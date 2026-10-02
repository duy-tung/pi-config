import fs from 'node:fs';
import path from 'node:path';
import {
  MODEL_ROLES_FILE, ROLES, SUBAGENT_ROLES, changedRoles, driftWarning, driftedRoles, effectiveModelRoles, fillRoleNames,
  forceNativeModels, loadPresets, loginWarning, modelRolesReport, nativeValues, nextModelDefault, readModelRoles, resolveModelRoles,
  roleLabel as label, withPreset, withRole, withoutRoles, writeModelRoles,
} from './model-roles.mjs';
import {backupFile, defaultsFile, describeMerge, planConfigFile, sha256, writeAtomic, writeConfigPlan} from './merge.mjs';
import {acquireInstallLock} from './install-lock.mjs';

/**
 * Phần chạy của /models (extension model-roles, nạp từ <root>/bin của bản cài): in bảng model của các vai, hoặc áp
 * một thay đổi chọn trong menu: sửa <agent-dir>/model-roles.json rồi áp ngay phần model vào các file gốc, cùng cách
 * gộp và khóa với installer, không cần chạy lại installer.
 */

const relative = (agentDir, file) => path.relative(agentDir, file).split(path.sep).join('/');

/**
 * Kế hoạch áp model/thinking của các vai vào file gốc của agent dir, chưa ghi gì. Mặc định mới của mỗi file dựng từ
 * base của lần cài trước (nextModelDefault) rồi gộp ba chiều như installer: giá trị người dùng đổi trong file gốc được
 * giữ, trừ model/thinking của các vai trong force. AGENTS.md sinh lại từ bản mẫu trong <root>/assets như file
 * installer quản lý (đã sửa thì giữ). missing: file gốc chưa có base, phải chạy lại installer trước.
 */
export function planModelFiles({root, agentDir, state, roles, force = []}) {
  const models = nativeValues(roles);
  const plans = [], missing = [];
  const targets = [
    ['settings', 'settings.json'], ['advisor', 'advisor.json'], ['goal', 'pi-goal-x-settings.json'],
    ...SUBAGENT_ROLES.map(role => [role, path.join('agents', `${role}.md`)]),
  ];
  for (const [kind, name] of targets) {
    const file = path.join(agentDir, name);
    const baseFile = defaultsFile(root, file);
    if (!fs.existsSync(baseFile)) {
      missing.push(file);
      continue;
    }
    const content = nextModelDefault(kind, fs.readFileSync(baseFile, 'utf8'), models);
    const forced = force.length ? text => forceNativeModels(kind, text, models, force) : undefined;
    plans.push(planConfigFile({root, file, content, recorded: state.files[file], force: forced}));
  }
  const file = path.join(agentDir, 'AGENTS.md');
  const template = path.join(root, 'assets', 'AGENTS.md');
  if (!fs.existsSync(template) || sha256(fs.readFileSync(template)) !== state.files[template]) {
    plans.push({file, managed: true, preserved: 'template'});
    return {plans, missing};
  }
  if (fs.existsSync(file) && fs.lstatSync(file).isSymbolicLink()) throw new Error(`Không ghi đè symlink: ${file}`);
  const content = fillRoleNames(fs.readFileSync(template, 'utf8'), roles);
  const current = fs.existsSync(file) ? sha256(fs.readFileSync(file)) : undefined;
  if (current === sha256(content)) plans.push({file, managed: true, recorded: current});
  else if (current === undefined || current === state.files[file]) plans.push({file, managed: true, content, recorded: sha256(content)});
  else plans.push({file, managed: true, preserved: 'edited'});
  return {plans, missing};
}

/** Ghi kế hoạch của planModelFiles (backup file cũ, base mới) và checksum vào install-state.json. */
export function writeModelFiles({root, statePath, state, plans}) {
  const backup = file => backupFile(root, file);
  for (const plan of plans) {
    if (plan.preserved) continue;
    if (!plan.managed) writeConfigPlan(plan, {backup});
    else if (plan.content !== undefined) {
      if (fs.existsSync(plan.file)) backup(plan.file);
      writeAtomic(plan.file, Buffer.from(plan.content), 0o600);
    }
    state.files[plan.file] = plan.recorded;
  }
  writeAtomic(statePath, Buffer.from(`${JSON.stringify(state, null, 2)}\n`), 0o600);
}

/** Khóa chung với installer: không ghi cùng lúc với một lần cài hay một /models khác. */
async function withInstallLock(root, fn) {
  const release = acquireInstallLock(root);
  try {
    return await fn();
  } finally {
    release();
  }
}

// Khi nào một phiên Pi đang chạy nhận giá trị mới: pi-subagents đọc lại file role ở mỗi lần gọi Agent, advisor đọc lại
// advisor.json ở mỗi lần hỏi; phiên chính, pi-goal-x và auto mode đọc cấu hình khi mở phiên.
const APPLIED_AT = {
  ...Object.fromEntries(SUBAGENT_ROLES.map(name => [name, 'ở lần gọi Agent kế tiếp'])), advisor: 'ở lần hỏi advisor kế tiếp',
  main: 'ở phiên Pi mở sau', auditor: 'ở phiên Pi mở sau', oracle: 'ở phiên Pi mở sau', autoMode: 'ở phiên Pi mở sau',
};

/**
 * Câu báo các vai vừa đổi giá trị trong file gốc có hiệu lực khi nào (effects mặc định của runModels), gom các vai
 * cùng thời điểm. when: thời điểm riêng theo vai (vd /models trong phiên).
 */
export function whenApplied(changed, when = {}) {
  const groups = new Map();
  for (const name of changed) {
    const at = when[name] ?? APPLIED_AT[name];
    groups.set(at, [...(groups.get(at) ?? []), name]);
  }
  return groups.size ? [`Có hiệu lực: ${[...groups].map(([at, names]) => `${names.join(', ')} ${at}`).join('; ')}.`] : [];
}

/**
 * model-roles.json mới và các vai cần ép trong file gốc cho một thay đổi của /models:
 * - {preset}: chọn preset; ép các vai preset mới đổi giá trị;
 * - {role, model?, thinking?}: ghi đè model và/hoặc thinking của một vai; ép vai đó;
 * - {reset: vai}: bỏ ghi đè, vai dùng lại giá trị của preset; ép vai đó;
 * - {apply: true}: giữ model-roles.json, ép mọi vai (bỏ giá trị đổi ngoài model-roles.json qua /model, /agents...).
 */
function edit(config, change) {
  if (change.preset !== undefined) return {config: withPreset(config, change.preset), force: changedRoles};
  if (change.reset !== undefined) return {config: withoutRoles(config, [change.reset]), force: () => [change.reset]};
  if (change.role !== undefined) {
    const {role, ...fields} = change;
    return {config: withRole(config, role, fields), force: () => [role]};
  }
  if (change.apply === true) return {config, force: () => ROLES};
  throw new Error(`không hiểu thay đổi ${JSON.stringify(change)}`);
}

/**
 * Áp một thay đổi: kiểm cấu hình mới và catalog, in thay đổi, rồi (trừ dryRun) ghi model-roles.json trước, file gốc
 * sau. Có lỗi thì không ghi gì. Sau khi ghi, effects nhận các vai có giá trị hiệu lực đổi và trả các dòng báo (phiên
 * Pi áp ngay những gì áp được).
 */
async function applyChange({root, agentDir, catalog, effects, out, dryRun, change}) {
  const run = async () => {
    const presets = loadPresets(path.join(root, 'assets', 'configs', 'model-presets.json'));
    const current = readModelRoles(agentDir);
    if (current.error) throw new Error(`${current.error}\nSửa file rồi mở lại /models.`);
    const before = resolveModelRoles(presets, current.config);
    const effective = effectiveModelRoles(agentDir);
    const {config, force} = edit(current.config, change);
    const after = resolveModelRoles(presets, config);
    if (after.errors.length) throw new Error(`${current.file} sẽ không hợp lệ:\n- ${after.errors.join('\n- ')}`);
    const report = await catalog.check(after.roles, {logins: true});
    if (report.errors.length) throw new Error(`Model không dùng được, chưa ghi gì:\n- ${report.errors.join('\n- ')}`);
    const statePath = path.join(root, 'install-state.json');
    const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    const forced = force(before.roles, after.roles);
    const {plans, missing} = planModelFiles({root, agentDir, state, roles: after.roles, force: forced});
    if (missing.length) {
      throw new Error(`Chưa có mặc định của lần cài trước cho:\n- ${missing.join('\n- ')}\nChạy lại installer một lần rồi dùng /models.`);
    }
    const configChanged = !current.exists || JSON.stringify(config) !== JSON.stringify(current.config);
    const changed = changedRoles(before.roles, after.roles);
    if (after.preset !== before.preset) out.log(`preset: ${before.preset} → ${after.preset}`);
    for (const name of changed) out.log(`${name}: ${label(before.roles[name])} → ${label(after.roles[name])}`);
    if (!current.exists) out.log(`${dryRun ? 'Sẽ tạo' : 'Tạo'} ${current.file}.`);
    else if (!configChanged) out.log(`${MODEL_ROLES_FILE} không đổi.`);
    else if (!changed.length && after.preset === before.preset) out.log('Không vai nào đổi model/thinking.');
    // Giá trị người dùng đã đổi trong file gốc (lệch với cấu hình trước thay đổi) mà thay đổi này ép về cấu hình mới.
    const driftedBefore = driftedRoles(before.roles, effective), driftedAfter = driftedRoles(after.roles, effective);
    const overwritten = forced.filter(name => driftedBefore.includes(name) && driftedAfter.includes(name) && effective[name].model);
    if (overwritten.length) {
      out.log(`${dryRun ? 'Sẽ ghi đè' : 'Ghi đè'} giá trị đổi ngoài ${MODEL_ROLES_FILE}: ${overwritten.map(name => `${name} (${effective[name].file}: ${label(effective[name])})`).join(', ')}`);
    }
    const written = plans.filter(plan => !plan.preserved && plan.content !== undefined).map(plan => relative(agentDir, plan.file));
    out.log(written.length ? `${dryRun ? 'Sẽ cập nhật' : 'Cập nhật'}: ${written.join(', ')}` : 'File gốc đã khớp, không cần ghi.');
    for (const plan of plans) {
      if (plan.preserved === 'edited') out.log(`Giữ nguyên ${plan.file} vì bạn đã sửa; model của các vai trong file có thể đã cũ.`);
      else if (plan.preserved === 'template') out.log(`Không cập nhật ${plan.file}: bản mẫu trong ${path.join(root, 'assets')} đã bị sửa hoặc thiếu.`);
      else if (plan.preserved) out.log(`Không cập nhật ${plan.file}: không đọc được ${plan.file.endsWith('.md') ? 'frontmatter' : 'JSON'}.`);
      else if (plan.conflicts?.length) out.log(describeMerge({file: plan.file, conflicts: plan.conflicts, additive: plan.additive}).join('\n'));
    }
    if (report.notes.length) out.log(`Mức thinking model không hỗ trợ (Pi dùng mức gần nhất):\n  - ${report.notes.join('\n  - ')}`);
    for (const provider of report.loggedOut) out.warn(`cảnh báo: ${loginWarning(provider)}`);
    if (dryRun) return 0;
    if (configChanged) writeModelRoles(current.file, config);
    writeModelFiles({root, statePath, state, plans});
    const now = effectiveModelRoles(agentDir);
    for (const name of driftedRoles(after.roles, now)) out.warn(`cảnh báo: ${driftWarning(name, now[name], after.roles[name])}`);
    return changedRoles(effective, now);
  };
  // Hiệu lực được báo sau khi nhả khóa: phiên Pi có thể đổi model ngay, và advisor khi đó tự ghi advisor.json.
  const changed = dryRun ? await run() : await withInstallLock(root, run);
  if (Array.isArray(changed)) for (const line of await effects(changed)) out.log(line);
  return 0;
}

/**
 * /models trong phiên Pi. Không có change: in bảng model của mọi vai (như pi-doctor, thêm provider chưa đăng nhập).
 * Có change (xem edit): áp thay đổi đó; dryRun chỉ in, không ghi. Trả exit code; lỗi được in ra, không ném.
 * catalog: catalog của phiên ({check}). effects(vai): các dòng báo khi nào vai có giá trị hiệu lực mới.
 */
export async function runModels({root, agentDir, catalog, change, dryRun = false, out = console, effects = whenApplied}) {
  try {
    if (change) return await applyChange({root, agentDir, catalog, effects, out, dryRun, change});
    const report = await modelRolesReport({root, agentDir, logins: true, catalog});
    out.log(report.lines.join('\n') || 'không đọc được cấu hình model');
    for (const warning of report.warnings) out.warn(`cảnh báo: ${warning}`);
    for (const error of report.errors) out.error(`lỗi: ${error}`);
    return report.errors.length ? 1 : 0;
  } catch (error) {
    out.error(`/models: ${error.message}`);
    return 1;
  }
}
