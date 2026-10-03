import fs from 'node:fs';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {writeAtomic} from './merge.mjs';

/**
 * Model và mức thinking của mọi vai ở một chỗ:
 * - mặc định trong assets/configs/model-defaults.json (cập nhật theo bản phát hành);
 * - <agent-dir>/model-roles.json của người dùng: ghi đè theo vai.
 * Installer sinh các file gốc (settings.json, agents/*.md, advisor.json) từ kết quả resolve;
 * /models (runtime/models.mjs) đổi model-roles.json và áp ngay vào các file gốc; /models và pi-doctor so kết quả
 * resolve với giá trị đang có hiệu lực trong các file gốc.
 * Model của bộ phân loại auto mode không phải một vai: đặt trong /permissions → Classifier (autoMode.model của settings.json).
 */

export const ROLES = ['main', 'researcher', 'worker', 'reviewer', 'advisor'];
// Vai đã gỡ khỏi pi-config: ghi đè còn sót trong model-roles.json bị bỏ qua kèm cảnh báo, không làm hỏng cấu hình.
export const REMOVED_ROLES = ['auditor', 'oracle', 'debugger'];
// Vai đã chuyển chỗ: ghi đè còn sót bị bỏ qua kèm cảnh báo chỉ chỗ đặt mới.
const MOVED_ROLES = {autoMode: 'model của bộ phân loại auto mode giờ đặt trong /permissions → Classifier'};
export const SUBAGENT_ROLES = ['researcher', 'worker', 'reviewer'];
export const THINKING_LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
const FIELDS = ['model', 'thinking'];
export const MODEL_ROLES_FILE = 'model-roles.json';
const defaultModelRoles = () => ({roles: {}});

// Thứ tự suy ra enabledModels (Ctrl+P, scopeModels của pi-subagents) và thinking mặc định theo model:
// model của phiên chính đứng đầu.
const MODEL_ORDER = ['main', 'worker', 'reviewer', 'researcher', 'advisor'];
const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);

/** "provider/id" → {provider, id}; id có thể chứa "/" (vd model của OpenRouter). */
export function parseModelRef(value) {
  if (typeof value !== 'string' || /\s/u.test(value)) return undefined;
  const slash = value.indexOf('/');
  if (slash <= 0 || slash === value.length - 1) return undefined;
  return {provider: value.slice(0, slash), id: value.slice(slash + 1)};
}

function checkRole(where, value, errors) {
  if (!isObject(value)) {
    errors.push(`${where} phải là object dạng {"model": "provider/id", "thinking": "high"}`);
    return {};
  }
  const result = {};
  for (const key of Object.keys(value)) {
    if (key === 'model') {
      if (parseModelRef(value.model)) result.model = value.model;
      else errors.push(`${where}.model phải có dạng "provider/id" (vd "anthropic/claude-opus-5-5"), đang là ${JSON.stringify(value.model)}`);
    } else if (key === 'thinking') {
      if (THINKING_LEVELS.includes(value.thinking)) result.thinking = value.thinking;
      else errors.push(`${where}.thinking phải là một trong ${THINKING_LEVELS.join(', ')}, đang là ${JSON.stringify(value.thinking)}`);
    } else errors.push(`${where}: không có khóa "${key}" (chỉ có ${FIELDS.join(', ')})`);
  }
  return result;
}

function checkRoles(where, roles, errors, warnings) {
  if (roles === undefined) return {};
  if (!isObject(roles)) {
    errors.push(`${where} phải là object theo tên vai`);
    return {};
  }
  const result = {}, removed = [];
  for (const [name, value] of Object.entries(roles)) {
    if (ROLES.includes(name)) result[name] = checkRole(`${where}.${name}`, value, errors);
    else if (REMOVED_ROLES.includes(name)) removed.push(name);
    else if (Object.hasOwn(MOVED_ROLES, name)) warnings.push(`${where}: bỏ qua ${name} (${MOVED_ROLES[name]}); xoá khỏi ${MODEL_ROLES_FILE} để hết cảnh báo`);
    else errors.push(`${where}: không có vai "${name}" (có ${ROLES.join(', ')})`);
  }
  if (removed.length) warnings.push(`${where}: bỏ qua ${removed.join(', ')} (vai đã gỡ khỏi pi-config); xoá khỏi ${MODEL_ROLES_FILE} để hết cảnh báo`);
  return result;
}

/**
 * Model/thinking của từng vai: mặc định (loadModelDefaults) → roles trong model-roles.json. source của mỗi trường là
 * "default" hoặc "override". errors khác rỗng: cấu hình không dùng được; roles khi đó vẫn đủ (lấy từ mặc định cho
 * phần lỗi) để còn hiển thị. warnings: phần bị bỏ qua (khóa preset cũ, ghi đè của vai đã gỡ), cấu hình vẫn dùng được.
 */
export function resolveModelRoles(defaults, config = defaultModelRoles()) {
  const errors = [], warnings = [];
  let overrides = {};
  if (!isObject(config)) errors.push(`${MODEL_ROLES_FILE} phải là một object JSON`);
  else {
    for (const key of Object.keys(config)) {
      // Preset đã gỡ: khóa còn sót chỉ bị bỏ qua, /models bỏ nó ở lần ghi kế tiếp (copyConfig).
      if (key === 'preset') warnings.push(`bỏ qua "preset": ${JSON.stringify(config.preset)} (preset đã gỡ khỏi pi-config: mọi vai dùng mặc định, chỉ ghi đè trong roles có tác dụng); xoá khóa này khỏi ${MODEL_ROLES_FILE} để hết cảnh báo`);
      else if (key !== 'roles') errors.push(`không có khóa "${key}" (chỉ có roles)`);
    }
    overrides = checkRoles('roles', config.roles, errors, warnings);
  }
  const layers = name => [['default', defaults[name]], ['override', overrides[name]]];
  const roles = {};
  for (const name of ROLES) {
    const role = {source: {}};
    for (const field of FIELDS) {
      for (const [source, layer] of layers(name)) {
        if (layer?.[field] === undefined) continue;
        role[field] = layer[field];
        role.source[field] = source;
      }
    }
    roles[name] = role;
  }
  return {roles, errors, warnings};
}

/** Giá trị cho từng file gốc từ các vai đã resolve. */
export function nativeValues(roles) {
  const ref = name => parseModelRef(roles[name].model);
  const main = ref('main');
  const levels = {};
  for (const name of MODEL_ORDER) levels[roles[name].model] ??= roles[name].thinking;
  return {
    settings: {
      defaultProvider: main.provider, defaultModel: main.id, defaultThinkingLevel: roles.main.thinking,
      modelThinkingLevels: levels, enabledModels: [...new Set(MODEL_ORDER.map(name => roles[name].model))],
    },
    subagents: Object.fromEntries(SUBAGENT_ROLES.map(name => [name, {model: roles[name].model, thinking: roles[name].thinking}])),
    // alwaysOn của advisor đặt model của phiên chính thành executor mỗi lần mở phiên: executor luôn là vai main.
    advisor: {
      executor: roles.main.model, executorEffort: roles.main.thinking, advisor: roles.advisor.model, advisorEffort: roles.advisor.thinking,
    },
  };
}

// Vai mà mỗi file gốc (JSON) chứa model/thinking.
const FILE_ROLES = {settings: ['main'], advisor: ['main', 'advisor']};

/**
 * Đặt model/thinking của các vai vào object của một file gốc JSON (sửa tại chỗ, giữ thứ tự khóa sẵn có).
 * only undefined: mọi giá trị do model-roles.json sinh ra, kể cả enabledModels và modelThinkingLevels (dựng mặc định
 * mới từ base). only là danh sách vai: chỉ các vai đó, và bỏ khóa khiến vai đó dùng giá trị khác (ép lại giá trị
 * người dùng đã đổi trong file gốc).
 */
function setNativeModels(kind, value, models, only) {
  const want = name => FILE_ROLES[kind].includes(name) && (!only || only.includes(name));
  if (kind === 'settings') {
    if (want('main')) Object.assign(value, {
      defaultProvider: models.settings.defaultProvider, defaultModel: models.settings.defaultModel,
      defaultThinkingLevel: models.settings.defaultThinkingLevel,
    });
    if (!only) Object.assign(value, {modelThinkingLevels: models.settings.modelThinkingLevels, enabledModels: models.settings.enabledModels});
  } else if (kind === 'advisor') {
    if (want('main')) Object.assign(value, {executor: models.advisor.executor, executorEffort: models.advisor.executorEffort});
    if (want('advisor')) {
      const {executor, executorEffort, ...advisor} = models.advisor;
      Object.assign(value, advisor);
    }
  }
  return value;
}

/**
 * Mặc định mới của một file gốc khi chỉ model-roles.json đổi: lấy base (mặc định installer ghi lần cài trước, cùng
 * phiên bản) và thay các giá trị do model-roles.json sinh ra; kết quả giống hệt mặc định installer sẽ sinh.
 */
export function nextModelDefault(kind, base, models) {
  if (SUBAGENT_ROLES.includes(kind)) return setRoleModel(base, models.subagents[kind]);
  return `${JSON.stringify(setNativeModels(kind, JSON.parse(base), models), null, 2)}\n`;
}

/**
 * Ép model/thinking của các vai (roles) trong nội dung hiện tại của một file gốc về giá trị của model-roles.json.
 * Trả nguyên văn khi file không chứa vai nào trong roles hoặc không đọc được (bước gộp sẽ giữ file và báo lại).
 */
export function forceNativeModels(kind, text, models, roles) {
  if (SUBAGENT_ROLES.includes(kind)) {
    if (!roles.includes(kind)) return text;
    try {
      return setRoleModel(text, models.subagents[kind]);
    } catch {
      return text;
    }
  }
  if (!FILE_ROLES[kind].some(name => roles.includes(name))) return text;
  let value;
  try {
    value = JSON.parse(text.replace(/^﻿/u, ''));
  } catch {
    return text;
  }
  if (!isObject(value)) return text;
  return `${JSON.stringify(setNativeModels(kind, value, models, roles), null, 2)}\n`;
}

/** Vai có model hoặc thinking khác nhau giữa hai kết quả resolve. */
export const changedRoles = (before, after) =>
  ROLES.filter(name => before[name].model !== after[name].model || before[name].thinking !== after[name].thinking);

const FRONTMATTER = /^---\n([\s\S]*?)\n---(?:\n|$)/u;

/** Frontmatter của file role: {tên: giá trị thô} theo thứ tự dòng, và phần thân; undefined khi không phải dạng key: value. */
export function splitRole(text) {
  const normalized = text.replace(/\r\n/gu, '\n');
  const match = FRONTMATTER.exec(normalized);
  if (!match) return undefined;
  const fields = {};
  for (const line of match[1].split('\n')) {
    const field = /^([A-Za-z_][\w-]*):(?: (.*))?$/u.exec(line);
    if (!field || Object.hasOwn(fields, field[1])) return undefined;
    fields[field[1]] = field[2] ?? '';
  }
  return {fields, body: normalized.slice(match[0].length)};
}

export function joinRole({fields, body}) {
  return `---\n${Object.entries(fields).map(([key, value]) => value === '' ? `${key}:` : `${key}: ${value}`).join('\n')}\n---\n${body}`;
}

/**
 * Đặt model/thinking trong frontmatter của file role, giữ nguyên phần còn lại: dòng đã có được sửa tại chỗ,
 * dòng thiếu được thêm sau description (hoặc name).
 */
export function setRoleModel(text, {model, thinking}) {
  const role = splitRole(text);
  if (!role) throw new Error('File role phải bắt đầu bằng frontmatter dạng "key: value" giữa hai dòng ---');
  const entries = Object.entries(role.fields);
  const missing = [];
  for (const [key, value] of [['model', model], ['thinking', thinking]]) {
    const at = entries.findIndex(([name]) => name === key);
    if (at >= 0) entries[at] = [key, value]; else missing.push([key, value]);
  }
  const at = entries.findIndex(([key]) => key === 'thinking' || key === 'model') + 1 ||
    entries.findIndex(([key]) => key === 'description') + 1 || entries.findIndex(([key]) => key === 'name') + 1;
  entries.splice(at, 0, ...missing);
  return joinRole({fields: Object.fromEntries(entries), body: role.body});
}

/** model/thinking đang ghi trong file role. */
export function roleModel(text) {
  const fields = splitRole(text)?.fields;
  return {model: fields?.model || undefined, thinking: fields?.thinking || undefined};
}

/** Model/thinking mặc định của mọi vai, từ <root>/assets/configs/model-defaults.json (root: repo hoặc bản cài). */
export const loadModelDefaults = root =>
  JSON.parse(fs.readFileSync(path.join(root, 'assets', 'configs', 'model-defaults.json'), 'utf8')).roles;

/** Đọc <agent-dir>/model-roles.json: chưa có thì chỉ dùng mặc định; JSON hỏng thì trả error. */
export function readModelRoles(agentDir) {
  const file = path.join(agentDir, MODEL_ROLES_FILE);
  if (!fs.existsSync(file)) return {file, exists: false, config: defaultModelRoles()};
  try {
    return {file, exists: true, config: JSON.parse(fs.readFileSync(file, 'utf8').replace(/^﻿/u, ''))};
  } catch (error) {
    return {file, exists: true, error: `${file} không phải JSON hợp lệ: ${error.message}`};
  }
}

/** Ghi model-roles.json (file của người dùng) qua file tạm rồi đổi tên, quyền 0600. */
export const writeModelRoles = (file, config) => writeAtomic(file, Buffer.from(`${JSON.stringify(config, null, 2)}\n`), 0o600);

// Các thay đổi của /models: trả bản sao đã sửa, không đổi object gốc. File hỏng dạng (không phải object) thì bắt
// đầu lại từ cấu hình mặc định; khóa preset cũ bị bỏ.
export function copyConfig(config) {
  if (!isObject(config)) return defaultModelRoles();
  const {preset, ...rest} = structuredClone(config);
  return rest;
}

/** Ghi đè model và/hoặc thinking của một vai; trường không nêu giữ nguyên ghi đè sẵn có. */
export function withRole(config, role, fields) {
  const next = copyConfig(config);
  if (!isObject(next.roles)) next.roles = {};
  next.roles[role] = {...(isObject(next.roles[role]) ? next.roles[role] : {}), ...fields};
  return next;
}

/** Bỏ ghi đè của các vai, để vai dùng lại giá trị mặc định. */
export function withoutRoles(config, roles) {
  const next = copyConfig(config);
  if (isObject(next.roles)) for (const role of roles) delete next.roles[role];
  return next;
}

const read = file => {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^﻿/u, ''));
  } catch {
    return undefined;
  }
};

/**
 * Model/thinking đang có hiệu lực theo các file gốc của agent dir, kèm file quyết định giá trị đó.
 * Phiên chính: advisor alwaysOn đặt executor mỗi lần mở phiên, nên executor thắng settings.json.
 */
export function effectiveModelRoles(agentDir) {
  const settings = read(path.join(agentDir, 'settings.json')) ?? {};
  const advisor = read(path.join(agentDir, 'advisor.json'));
  const result = {};
  result.main = advisor?.alwaysOn === true && advisor.executor
    ? {model: advisor.executor, thinking: advisor.executorEffort ?? settings.defaultThinkingLevel, file: 'advisor.json'}
    : {model: settings.defaultProvider && settings.defaultModel ? `${settings.defaultProvider}/${settings.defaultModel}` : undefined,
      thinking: settings.defaultThinkingLevel, file: 'settings.json'};
  for (const name of SUBAGENT_ROLES) {
    const file = path.join(agentDir, 'agents', `${name}.md`);
    result[name] = {...(fs.existsSync(file) ? roleModel(fs.readFileSync(file, 'utf8')) : {}), file: `agents/${name}.md`};
  }
  result.advisor = {model: advisor?.advisor, thinking: advisor?.advisorEffort, file: 'advisor.json'};
  return result;
}

/** Vai có giá trị hiệu lực khác cấu hình (đã đổi qua /model, /agents hoặc sửa tay file gốc). */
export const driftedRoles = (roles, effective) =>
  ROLES.filter(name => effective[name].model !== roles[name].model || effective[name].thinking !== roles[name].thinking);

/**
 * Catalog model của runtime Pi ở chế độ offline, không đọc auth: model có sẵn, models.json của agent dir và bộ nhớ
 * catalog Pi đã tải từ pi.dev (models-store.json, đọc vào bộ nhớ để không tạo hay khóa file của Pi).
 * fn nhận {runtime, pi} (pi: các hàm model của pi-ai); kết quả của fn được trả về.
 */
async function withCatalog({modules, agentDir}, fn) {
  const load = relative => import(pathToFileURL(path.join(modules, relative)).href);
  const savedOffline = process.env.PI_OFFLINE;
  process.env.PI_OFFLINE = '1';
  try {
    const {ModelRuntime} = await load('@earendil-works/pi-coding-agent/dist/index.js');
    const {AuthStorage} = await load('@earendil-works/pi-coding-agent/dist/core/auth-storage.js');
    const {InMemoryCodingAgentModelsStore} = await load('@earendil-works/pi-coding-agent/dist/core/models-store.js');
    const pi = await load('@earendil-works/pi-ai/dist/models.js');
    const modelsPath = agentDir && fs.existsSync(path.join(agentDir, 'models.json')) ? path.join(agentDir, 'models.json') : null;
    const modelsStore = new InMemoryCodingAgentModelsStore();
    const cached = agentDir ? read(path.join(agentDir, 'models-store.json')) : undefined;
    for (const [provider, entry] of Object.entries(isObject(cached) ? cached : {})) modelsStore.entries.set(provider, entry);
    const runtime = await ModelRuntime.create({
      credentials: AuthStorage.inMemory({}), modelsPath, modelsStore, refreshOnCreate: false, allowModelNetwork: false,
    });
    return await fn({runtime, pi});
  } finally {
    if (savedOffline === undefined) delete process.env.PI_OFFLINE; else process.env.PI_OFFLINE = savedOffline;
  }
}

/**
 * Kiểm model của mọi vai trong một catalog, không gọi mạng: model không có là lỗi (pi-subagents sẽ lặng lẽ dùng model
 * của parent), mức thinking model không hỗ trợ là ghi chú (Pi hạ về mức gần nhất). find(provider, id): model hoặc
 * undefined; clamp(model, level): mức Pi dùng; login(provider): nhãn đăng nhập hoặc undefined, không truyền thì không
 * kiểm đăng nhập.
 */
export async function catalogReport({roles, find, clamp, login}) {
  const errors = [], notes = [], providers = new Map();
  for (const name of Object.keys(roles)) {
    const {model, thinking} = roles[name];
    const ref = parseModelRef(model);
    const found = ref && find(ref.provider, ref.id);
    if (!found) {
      errors.push(`${name}: không có model ${model} trong catalog của Pi${roles[name].file ? ` (theo ${roles[name].file})` : ''}; kiểm tên provider/id, hoặc khai báo model trong models.json`);
      continue;
    }
    if (!providers.has(ref.provider)) providers.set(ref.provider, []);
    providers.get(ref.provider).push(name);
    if (thinking === undefined) continue;
    const clamped = clamp(found, thinking);
    if (clamped !== thinking) notes.push(`${name}: ${model} không hỗ trợ thinking ${thinking}; Pi dùng ${clamped}`);
  }
  const loggedOut = [];
  if (login) for (const [provider, names] of providers) if (!await login(provider)) loggedOut.push({provider, roles: names});
  return {errors, notes, loggedOut};
}

/**
 * catalogReport trên catalog của runtime đã cài (installer, pi-doctor), không đọc auth. models.json và bộ nhớ catalog
 * (models-store.json) của agent dir được tính, để model tự khai báo cũng hợp lệ.
 */
export function checkCatalog({modules, agentDir, roles}) {
  return withCatalog({modules, agentDir}, ({runtime, pi}) =>
    catalogReport({roles, find: (provider, id) => runtime.getModel(provider, id), clamp: pi.clampThinkingLevel}));
}

export const roleLabel = role => `${role.model ?? '?'} (${role.thinking ?? '?'})`;

/** Cảnh báo cho vai đang dùng giá trị khác model-roles.json, kèm cách giữ hoặc bỏ giá trị đó. */
export const driftWarning = (name, effective, wanted) =>
  `${name} đang dùng ${roleLabel(effective)} theo ${effective.file}, khác ${MODEL_ROLES_FILE} (${roleLabel(wanted)}). ` +
  `Trong /models: đặt ${name} để giữ giá trị này, hoặc đưa các vai lệch về ${MODEL_ROLES_FILE}.`;

/** Cảnh báo provider chưa đăng nhập (catalog của phiên Pi trong /models). */
export const loginWarning = ({provider, roles}) => `provider ${provider} (${roles.join(', ')}) chưa đăng nhập: dùng /login.`;

/**
 * Bảng model của mọi vai cho /models và pi-doctor: giá trị theo model-roles.json, giá trị đang có hiệu lực khi
 * khác (đổi qua /model, /agents hoặc sửa tay file gốc), và kết quả kiểm catalog của cả hai.
 * catalog: {check(roles, {logins})}; mặc định là runtime đã cài (modules), không kiểm đăng nhập. logins: cảnh báo cả
 * provider chưa đăng nhập (catalog của phiên Pi).
 */
export async function modelRolesReport({
  root, agentDir, modules, logins = false, catalog = {check: roles => checkCatalog({modules, agentDir, roles})},
}) {
  const lines = [], warnings = [], errors = [];
  const current = readModelRoles(agentDir);
  if (current.error) return {lines, warnings, errors: [current.error]};
  const resolved = resolveModelRoles(loadModelDefaults(root), current.config);
  if (resolved.errors.length) return {lines, warnings, errors: resolved.errors.map(error => `${current.file}: ${error}`)};
  warnings.push(...resolved.warnings.map(warning => `${current.file}: ${warning}`));
  const effective = effectiveModelRoles(agentDir);
  const drifted = new Set(driftedRoles(resolved.roles, effective));
  lines.push(`mặc định + ghi đè (${current.exists ? current.file : `chưa có ${MODEL_ROLES_FILE}`})`);
  for (const name of ROLES) {
    const wanted = resolved.roles[name];
    const overridden = wanted.source.model === 'override' || wanted.source.thinking === 'override' ? ', ghi đè' : '';
    if (!drifted.has(name)) {
      lines.push(`  ${name}: ${roleLabel(wanted)}${overridden}`);
      continue;
    }
    lines.push(`  ${name}: ${roleLabel(effective[name])} theo ${effective[name].file}; ${MODEL_ROLES_FILE}: ${roleLabel(wanted)}${overridden}`);
    warnings.push(driftWarning(name, effective[name], wanted));
  }
  // Giá trị đang có hiệu lực là thứ Pi dùng: model sai tên ở đó cũng bị thay lặng lẽ bằng model của parent.
  const checked = Object.fromEntries(ROLES.map(name => [name, drifted.has(name) && effective[name].model ? effective[name] : resolved.roles[name]]));
  try {
    const report = await catalog.check(checked, {logins});
    errors.push(...report.errors);
    warnings.push(...report.notes, ...report.loggedOut.map(loginWarning));
  } catch (error) {
    warnings.push(`không kiểm được model trong catalog của Pi: ${error.message}`);
  }
  return {lines, warnings, errors};
}
