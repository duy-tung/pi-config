import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {
  MODEL_ROLES_FILE, ROLES, SUBAGENT_ROLES, THINKING_LEVELS, adoptRoles, changedRoles, driftWarning, driftedRoles,
  effectiveModelRoles, fillRoleNames, forceNativeModels, loadPresets, loginWarning, modelRolesReport, nativeValues,
  nextModelDefault, offlineCatalog, parseModelRef, readModelRoles, resolveModelRoles, withPreset, withRole, withoutRoles,
  writeModelRoles,
} from './model-roles.mjs';
import {backupFile, defaultsFile, describeMerge, planConfigFile, writeAtomic, writeConfigPlan} from './merge.mjs';

/**
 * pi-models: xem và đổi model/thinking của các vai. Lệnh ghi sửa <agent-dir>/model-roles.json rồi áp ngay phần model
 * vào các file gốc, cùng cách gộp với installer, không cần chạy lại installer.
 */

const USAGE_LINES = [
  ['', `bảng model của mọi vai, chỗ lệch với ${MODEL_ROLES_FILE}, kiểm catalog`],
  ['list [provider]', 'provider (đã đăng nhập chưa) và model trong catalog của Pi'],
  ['preset <tên>', `chọn preset (có sẵn hoặc preset riêng trong ${MODEL_ROLES_FILE})`],
  ['set <vai> [provider/id] [thinking]', 'ghi đè model và/hoặc thinking của một vai'],
  ['reset <vai>... | --all', 'bỏ ghi đè, vai dùng lại giá trị của preset'],
  ['adopt [vai...]', `ghi giá trị đang chạy (đổi qua /model, /agents...) vào ${MODEL_ROLES_FILE}`],
  ['apply [--reset]', `áp ${MODEL_ROLES_FILE} vào file gốc; --reset ép cả vai đang lệch`],
];

/** Hướng dẫn của pi-models, hoặc của /models trong phiên Pi (command). */
export function usage(command = 'pi-models') {
  const lines = USAGE_LINES.map(([args, text]) => {
    const left = `  ${command}${args ? ` ${args}` : ''}`;
    return left.length < 37 ? `${left.padEnd(37)}${text}` : `${left}\n${' '.repeat(37)}${text}`;
  });
  return [
    `${command}: model và thinking của từng vai (${ROLES.join(', ')})`, ...lines,
    'Lệnh ghi nhận --dry-run: in thay đổi, không ghi file.', `Thinking: ${THINKING_LEVELS.join(', ')}.`,
  ].join('\n');
}

export const USAGE = usage();

const sha256 = data => crypto.createHash('sha256').update(data).digest('hex');
const label = role => `${role.model ?? '?'} (${role.thinking ?? '?'})`;
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

/** Khóa chung với installer: không ghi cùng lúc với một lần cài hay một pi-models khác. */
async function withInstallLock(root, fn) {
  const lock = path.join(root, '.install.lock');
  let descriptor;
  try {
    descriptor = fs.openSync(lock, 'wx', 0o600);
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    throw new Error(`Installer hoặc pi-models khác đang chạy (có ${lock}). Chờ xong rồi thử lại; nếu chắc không còn tiến trình nào thì xoá file này.`);
  }
  try {
    fs.writeFileSync(descriptor, String(process.pid));
    fs.closeSync(descriptor);
    descriptor = undefined;
    return await fn();
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
    fs.rmSync(lock, {force: true});
  }
}

/** Danh sách vai trong tham số; tên sai là lỗi. */
function roleNames(names) {
  for (const name of names) if (!ROLES.includes(name)) throw new Error(`không có vai "${name}" (có ${ROLES.join(', ')})`);
  return [...new Set(names)];
}

/** Giá trị của pi-models set: model dạng provider/id và/hoặc mức thinking, mỗi loại tối đa một lần. */
function roleFields(values, command) {
  if (!values.length) throw new Error(`thiếu giá trị: ${command} set <vai> [provider/id] [thinking]`);
  const fields = {};
  for (const value of values) {
    const field = THINKING_LEVELS.includes(value) ? 'thinking' : parseModelRef(value) ? 'model' : undefined;
    if (!field) throw new Error(`"${value}" không phải model dạng provider/id hay mức thinking (${THINKING_LEVELS.join(', ')})`);
    if (fields[field]) throw new Error(`chỉ nêu một ${field}`);
    fields[field] = value;
  }
  return fields;
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
 * Chạy một lệnh ghi: edit trả model-roles.json mới và các vai cần ép trong file gốc; kiểm cấu hình và catalog, in
 * thay đổi, rồi (trừ --dry-run) ghi model-roles.json trước, file gốc sau. Có lỗi thì không ghi gì. Sau khi ghi,
 * effects nhận các vai có giá trị hiệu lực đổi và trả các dòng báo (phiên Pi áp ngay những gì áp được).
 */
async function change({root, agentDir, catalog, effects, command, out, dryRun, edit}) {
  const run = async () => {
    if (dryRun) out.log('Xem trước (--dry-run), chưa ghi file nào.');
    const presets = loadPresets(path.join(root, 'assets', 'configs', 'model-presets.json'));
    const current = readModelRoles(agentDir);
    if (current.error) throw new Error(`${current.error}\nSửa file rồi chạy lại lệnh.`);
    const before = resolveModelRoles(presets, current.config);
    const effective = effectiveModelRoles(agentDir);
    const {config, force, message} = edit({config: current.config, before, effective});
    if (message) out.log(message);
    if (!config) return 0;
    const after = resolveModelRoles(presets, config);
    if (after.errors.length) throw new Error(`${current.file} sẽ không hợp lệ:\n- ${after.errors.join('\n- ')}`);
    const report = await catalog.check(after.roles, {logins: true});
    if (report.errors.length) throw new Error(`Model không dùng được, chưa ghi gì:\n- ${report.errors.join('\n- ')}`);
    const statePath = path.join(root, 'install-state.json');
    const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    const forced = force(before.roles, after.roles);
    const {plans, missing} = planModelFiles({root, agentDir, state, roles: after.roles, force: forced});
    if (missing.length) {
      throw new Error(`Chưa có mặc định của lần cài trước cho:\n- ${missing.join('\n- ')}\nChạy lại installer một lần rồi dùng ${command}.`);
    }
    const configChanged = !current.exists || JSON.stringify(config) !== JSON.stringify(current.config);
    const changed = changedRoles(before.roles, after.roles);
    if (after.preset !== before.preset) out.log(`preset: ${before.preset} → ${after.preset}`);
    for (const name of changed) out.log(`${name}: ${label(before.roles[name])} → ${label(after.roles[name])}`);
    if (!current.exists) out.log(`${dryRun ? 'Sẽ tạo' : 'Tạo'} ${current.file}.`);
    else if (!configChanged) out.log(`${MODEL_ROLES_FILE} không đổi.`);
    else if (!changed.length && after.preset === before.preset) out.log('Không vai nào đổi model/thinking.');
    // Giá trị người dùng đã đổi trong file gốc (lệch với cấu hình trước lệnh) mà lệnh này ép về cấu hình mới.
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
    for (const provider of report.loggedOut) out.warn(`cảnh báo: ${loginWarning(provider, command)}`);
    if (dryRun) return 0;
    if (configChanged) writeModelRoles(current.file, config);
    writeModelFiles({root, statePath, state, plans});
    const now = effectiveModelRoles(agentDir);
    for (const name of driftedRoles(after.roles, now)) out.warn(`cảnh báo: ${driftWarning(name, now[name], after.roles[name], command)}`);
    return changedRoles(effective, now);
  };
  // Hiệu lực được báo sau khi nhả khóa: phiên Pi có thể đổi model ngay, và advisor khi đó tự ghi advisor.json.
  const changed = dryRun ? await run() : await withInstallLock(root, run);
  if (Array.isArray(changed)) for (const line of await effects(changed)) out.log(line);
  return 0;
}

/** In bảng provider hoặc model của một provider trong catalog. */
async function list({catalog, command, provider, roles, out}) {
  const providers = await catalog.list();
  const using = new Map();
  for (const name of ROLES) {
    const model = roles?.[name]?.model;
    if (model) using.set(model, [...(using.get(model) ?? []), name]);
  }
  const status = entry => entry.login ? `đã đăng nhập (${entry.login})` : 'chưa đăng nhập';
  if (!provider) {
    for (const entry of providers) {
      const used = ROLES.filter(name => roles?.[name]?.model?.startsWith(`${entry.id}/`));
      out.log(`${entry.id}: ${status(entry)}, ${entry.models.length} model${used.length ? `; vai: ${used.join(', ')}` : ''}`);
    }
    out.log(`Xem model của một provider: ${command} list <provider>`);
    return 0;
  }
  const entry = providers.find(item => item.id === provider);
  if (!entry) throw new Error(`không có provider "${provider}" trong catalog (có ${providers.map(item => item.id).join(', ')})`);
  out.log(`${entry.id} (${entry.name}): ${status(entry)}`);
  for (const model of entry.models) {
    const ref = `${entry.id}/${model.id}`;
    const used = using.get(ref);
    out.log(`  ${ref}  thinking: ${model.levels.join(', ')}${used ? `  ← ${used.join(', ')}` : ''}`);
  }
  return 0;
}

/**
 * Lệnh pi-models (launch.mjs) và /models trong phiên Pi. Trả exit code; lỗi được in ra, không ném.
 * command: tên lệnh trong hướng dẫn và lỗi. catalog: catalog của phiên Pi (dạng offlineCatalog) thay cho runtime đã cài
 * ở chế độ offline. effects(vai): các dòng báo khi nào vai có giá trị hiệu lực mới (phiên Pi áp ngay phần áp được).
 */
export async function runModels({root, profiles, args, out = console, command = 'pi-models', catalog, effects = whenApplied}) {
  try {
    const flags = args.filter(arg => arg.startsWith('--'));
    const [name = 'show', ...rest] = args.filter(arg => !arg.startsWith('--'));
    if (name === 'help' || flags.includes('--help')) {
      out.log(usage(command));
      return 0;
    }
    const accepted = {show: [], list: [], preset: ['--dry-run'], set: ['--dry-run'], reset: ['--dry-run', '--all'], adopt: ['--dry-run'], apply: ['--dry-run', '--reset']};
    if (!Object.hasOwn(accepted, name)) throw new Error(`không có lệnh "${name}"\n${usage(command)}`);
    for (const flag of flags) if (!accepted[name].includes(flag)) throw new Error(`${command} ${name} không nhận ${flag}`);
    const dryRun = flags.includes('--dry-run');
    const catalogOf = profile => (profile === profiles.main && catalog) ||
      offlineCatalog({modules: path.join(root, 'runtimes', profile.runtime, 'node_modules'), agentDir: profile.agentDir});
    const agentDir = profiles.main.agentDir;
    if (name === 'show') {
      if (rest.length) throw new Error(`không có lệnh "${rest[0]}"\n${usage(command)}`);
      let status = 0;
      for (const [profileName, entry] of Object.entries(profiles)) {
        const report = await modelRolesReport({
          root, agentDir: entry.agentDir, modules: path.join(root, 'runtimes', entry.runtime, 'node_modules'), logins: true,
          catalog: catalogOf(entry), command,
        });
        out.log(`${profileName}: ${report.lines.join('\n') || 'không đọc được cấu hình model'}`);
        for (const warning of report.warnings) out.warn(`cảnh báo: ${warning}`);
        for (const error of report.errors) {
          out.error(`lỗi: ${error}`);
          status = 1;
        }
      }
      return status;
    }
    if (name === 'list') {
      if (rest.length > 1) throw new Error(`${command} list [provider]`);
      const current = readModelRoles(agentDir);
      const roles = current.error ? undefined : resolveModelRoles(loadPresets(path.join(root, 'assets', 'configs', 'model-presets.json')), current.config).roles;
      return await list({catalog: catalogOf(profiles.main), command, provider: rest[0], roles, out});
    }
    const context = {root, agentDir, catalog: catalogOf(profiles.main), effects, command, out, dryRun};
    if (name === 'preset') {
      if (rest.length !== 1) throw new Error(`${command} preset <tên>`);
      return await change({...context, edit: ({config}) => ({config: withPreset(config, rest[0]), force: changedRoles})});
    }
    if (name === 'set') {
      if (!rest.length) throw new Error(`${command} set <vai> [provider/id] [thinking]`);
      const [role] = roleNames(rest.slice(0, 1));
      const fields = roleFields(rest.slice(1), command);
      return await change({...context, edit: ({config}) => ({config: withRole(config, role, fields), force: () => [role]})});
    }
    if (name === 'reset') {
      const all = flags.includes('--all');
      if (all === Boolean(rest.length)) throw new Error(`${command} reset <vai>... hoặc ${command} reset --all`);
      const names = all ? [] : roleNames(rest);
      return await change({...context, edit: ({config}) => {
        const overridden = config?.roles && typeof config.roles === 'object' ? Object.keys(config.roles).filter(role => ROLES.includes(role)) : [];
        const targets = all ? overridden : names;
        const message = targets.length ? undefined : 'Không có vai nào được ghi đè.';
        return {config: targets.length ? withoutRoles(config, targets) : undefined, force: () => targets, message};
      }});
    }
    if (name === 'adopt') {
      const names = roleNames(rest);
      return await change({...context, edit: ({config, before, effective}) => {
        const targets = names.length ? names : driftedRoles(before.roles, effective);
        const {config: next, adopted} = adoptRoles(config, before.roles, effective, targets);
        const entries = Object.entries(adopted);
        if (!entries.length) return {message: `Không vai nào lệch với ${MODEL_ROLES_FILE}${names.length ? ` trong ${names.join(', ')}` : ''}.`};
        const message = `Ghi vào ${MODEL_ROLES_FILE}: ${entries.map(([role, fields]) => `${role} ${[fields.model, fields.thinking].filter(Boolean).join(' ')}`).join(', ')}`;
        return {config: next, force: () => [], message};
      }});
    }
    if (rest.length) throw new Error(`${command} apply [--reset]`);
    const reset = flags.includes('--reset');
    return await change({...context, edit: ({config}) => ({config, force: () => (reset ? ROLES : [])})});
  } catch (error) {
    out.error(`${command}: ${error.message}`);
    return 1;
  }
}
