import fs from 'node:fs';
import path from 'node:path';
import {pathToFileURL} from 'node:url';

/**
 * Model và mức thinking của các vai nằm thẳng trong file gốc mà Pi và các package đọc, không có lớp cấu hình riêng:
 * - main: settings.json, đổi bằng /model của Pi (advisor luôn bật lưu model đó vào executor của advisor.json);
 * - researcher, worker, reviewer: frontmatter của agents/<vai>.md, đổi trong /agents → Agent types → vai → Model/Thinking;
 * - advisor: advisor.json, đổi bằng /advisor-models.
 * assets/configs/model-defaults.json là mặc định installer ghi vào các file đó; cài lại gộp ba chiều nên giá trị đã đổi
 * được giữ. Model của bộ phân loại auto mode không phải một vai: đặt trong /permissions → Classifier.
 */

export const ROLES = ['main', 'researcher', 'worker', 'reviewer', 'advisor'];
export const SUBAGENT_ROLES = ['researcher', 'worker', 'reviewer'];
export const THINKING_LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
// Chỗ đổi model của từng vai.
export const CHANGE_AT = {main: '/model', researcher: '/agents', worker: '/agents', reviewer: '/agents', advisor: '/advisor-models'};

// Thứ tự suy ra enabledModels (Ctrl+P) và thinking mặc định theo model: model của phiên chính đứng đầu.
const MODEL_ORDER = ['main', 'worker', 'reviewer', 'researcher', 'advisor'];
const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);

/** "provider/id" → {provider, id}; id có thể chứa "/" (vd model của OpenRouter). */
export function parseModelRef(value) {
  if (typeof value !== 'string' || /\s/u.test(value)) return undefined;
  const slash = value.indexOf('/');
  if (slash <= 0 || slash === value.length - 1) return undefined;
  return {provider: value.slice(0, slash), id: value.slice(slash + 1)};
}

/** Model/thinking mặc định của mọi vai, từ <root>/assets/configs/model-defaults.json (root: repo hoặc bản cài). */
export const loadModelDefaults = root =>
  JSON.parse(fs.readFileSync(path.join(root, 'assets', 'configs', 'model-defaults.json'), 'utf8')).roles;

/**
 * Giá trị mặc định cho từng file gốc. Thinking của phiên chính chỉ ghi vào settings.json: advisor không có
 * executorEffort nên không đặt lại thinking mà /model hay /thinking của Pi đã chọn.
 */
export function nativeValues(roles) {
  const main = parseModelRef(roles.main.model);
  const levels = {};
  for (const name of MODEL_ORDER) levels[roles[name].model] ??= roles[name].thinking;
  return {
    settings: {
      defaultProvider: main.provider, defaultModel: main.id, defaultThinkingLevel: roles.main.thinking,
      modelThinkingLevels: levels, enabledModels: [...new Set(MODEL_ORDER.map(name => roles[name].model))],
    },
    subagents: Object.fromEntries(SUBAGENT_ROLES.map(name => [name, {model: roles[name].model, thinking: roles[name].thinking}])),
    // alwaysOn của advisor cần executor đã lưu để bật lúc mở phiên; /model của Pi cập nhật giá trị này.
    advisor: {executor: roles.main.model, advisor: roles.advisor.model, advisorEffort: roles.advisor.thinking},
  };
}

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

const read = file => {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^﻿/u, ''));
  } catch {
    return undefined;
  }
};

/**
 * Model/thinking đang có hiệu lực theo các file gốc của agent dir, kèm file quyết định giá trị đó.
 * Phiên chính: advisor alwaysOn đặt executor (và executorEffort khi có) mỗi lần mở phiên, nên executor thắng settings.json.
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
 * undefined; clamp(model, level): mức Pi dùng.
 */
export function catalogReport({roles, find, clamp}) {
  const errors = [], notes = [];
  for (const name of Object.keys(roles)) {
    const {model, thinking} = roles[name];
    const ref = parseModelRef(model);
    const found = ref && find(ref.provider, ref.id);
    if (!found) {
      const where = roles[name].file ? ` (theo ${roles[name].file}; đổi bằng ${CHANGE_AT[name] ?? 'file đó'})` : '';
      errors.push(`${name}: không có model ${model} trong catalog của Pi${where}; kiểm tên provider/id, hoặc khai báo model trong models.json`);
      continue;
    }
    if (thinking === undefined) continue;
    const clamped = clamp(found, thinking);
    if (clamped !== thinking) notes.push(`${name}: ${model} không hỗ trợ thinking ${thinking}; Pi dùng ${clamped}`);
  }
  return {errors, notes};
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

/** Bảng model đang có hiệu lực của mọi vai cho pi-doctor, kèm chỗ đổi và kết quả kiểm catalog. */
export async function modelRolesReport({agentDir, modules}) {
  const lines = ['model của các vai (main đổi bằng /model, researcher/worker/reviewer trong /agents, advisor bằng /advisor-models)'];
  const warnings = [], errors = [];
  const effective = effectiveModelRoles(agentDir);
  for (const name of ROLES) lines.push(`  ${name}: ${roleLabel(effective[name])} theo ${effective[name].file}`);
  try {
    const report = await checkCatalog({modules, agentDir, roles: effective});
    errors.push(...report.errors);
    warnings.push(...report.notes);
  } catch (error) {
    warnings.push(`không kiểm được model trong catalog của Pi: ${error.message}`);
  }
  return {lines, warnings, errors};
}

// --- model-roles.json của bản trước ---

/** File cấu hình vai của bản trước (mặc định + ghi đè, đổi bằng /models): installer chuyển vào backups. */
export const LEGACY_MODEL_ROLES = 'model-roles.json';

/** Đặt model/thinking của mọi vai vào object của một file gốc JSON (sửa tại chỗ, giữ thứ tự khóa sẵn có). */
function setNativeModels(kind, value, models) {
  if (kind === 'settings') Object.assign(value, models.settings);
  else if (kind === 'advisor') Object.assign(value, models.advisor);
  return value;
}

/**
 * Nội dung một file gốc theo base của lần cài trước nhưng với model/thinking của roles (mặc định thuần, không có ghi
 * đè của model-roles.json): dùng làm base mới khi chuyển đổi, để gộp ba chiều coi giá trị ghi đè đang nằm trong file
 * gốc là giá trị người dùng đã chọn và giữ lại.
 */
export function rebaseModels(kind, base, roles) {
  const models = nativeValues(roles);
  if (SUBAGENT_ROLES.includes(kind)) return setRoleModel(base, models.subagents[kind]);
  return `${JSON.stringify(setNativeModels(kind, JSON.parse(base), models), null, 2)}\n`;
}
