/**
 * Gộp ba chiều cho file cấu hình JSON khi cài lại, không đọc/ghi file.
 * base: mặc định installer ghi lần trước (<root>/state/defaults); next: mặc định mới; current: file hiện tại,
 * mà Pi và người dùng có thể đã sửa (Pi ghi lại settings.json khi đổi model, thinking, theme...).
 * Giá trị undefined nghĩa là thiếu khóa. Không có base thì gộp cộng dồn: giữ mọi giá trị hiện có, chỉ thêm phần thiếu.
 */

// Luật deny installer từng ghi, nay do pi-auto-mode xử lý: Bash(rm -rf *) chặn hẳn rm -rf (kể cả khi người
// dùng muốn duyệt) nhưng để lọt rm -fr; thay bằng kiểm tra xoá đệ quy (bypass hỏi, auto qua bộ phân loại).
export const RETIRED_DENY = new Set(['Bash(rm -rf *)']);

// Mảng dạng tập hợp của settings.json: gộp theo phần tử và giữ thứ tự của file hiện tại. Mảng khác là một giá trị.
const SET_PATHS = new Set(['permissions.allow', 'permissions.ask', 'permissions.deny', 'enabledModels', 'skills', 'themes', 'prompts', 'extensions', 'packages']);

const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const own = (object, key) => isObject(object) && Object.hasOwn(object, key) ? object[key] : undefined;
// Gán như thuộc tính riêng: khóa "__proto__" từ JSON không được đổi prototype.
const assign = (object, key, value) => Object.defineProperty(object, key, {value, enumerable: true, writable: true, configurable: true});

export function deepEqual(a, b) {
  if (a === b) return true;
  if (Array.isArray(a)) return Array.isArray(b) && a.length === b.length && a.every((item, i) => deepEqual(item, b[i]));
  if (!isObject(a) || !isObject(b)) return false;
  const keys = Object.keys(a);
  return keys.length === Object.keys(b).length && keys.every(key => Object.hasOwn(b, key) && deepEqual(a[key], b[key]));
}

const canonical = value => JSON.stringify(value, (key, item) => isObject(item)
  ? Object.fromEntries(Object.keys(item).sort().map(name => [name, item[name]])) : item);
// packages: chuỗi và {source, extensions} cùng source là một mục (người dùng có thể lọc extension của package).
function itemKey(setPath, item) {
  if (typeof item === 'string') return `s:${item}`;
  if (setPath === 'packages' && typeof item?.source === 'string') return `s:${item.source}`;
  return `j:${canonical(item)}`;
}
const itemLabel = item => typeof item === 'string' ? item : typeof item?.source === 'string' ? item.source : canonical(item);

// Kết quả = current + mục next thêm so với base (nối cuối) − mục next bỏ so với base; không có base thì là hợp.
function mergeSet(path, base, next, current, context) {
  const setPath = path.join('.');
  const index = list => new Map((Array.isArray(list) ? list : []).map(item => [itemKey(setPath, item), item]));
  const before = index(base), after = index(next), mine = index(current);
  const value = [], added = [], removed = [];
  const conflict = (item, currentItem, nextItem) => context.conflicts.push({path, item: itemLabel(item), current: currentItem, next: nextItem});
  for (const item of current) {
    const key = itemKey(setPath, item), old = before.get(key), fresh = after.get(key);
    if (!before.has(key) || deepEqual(old, fresh)) {
      // Mục người dùng tự thêm hoặc mục mặc định không đổi. Mục mặc định mới trùng source nhưng khác nội dung: giữ của người dùng.
      if (!before.has(key) && after.has(key) && !deepEqual(item, fresh)) conflict(item, item, fresh);
      value.push(item);
    } else if (deepEqual(item, old)) {
      // Mặc định mới bỏ hoặc đổi mục người dùng chưa sửa.
      if (!after.has(key)) removed.push(item);
      else { value.push(fresh); context.changes.push({type: 'set', path, item: itemLabel(item), from: item, to: fresh}); }
    } else {
      if (!deepEqual(item, fresh)) conflict(item, item, fresh);
      value.push(item);
    }
  }
  for (const [key, item] of after) {
    if (mine.has(key)) continue;
    if (!before.has(key)) { value.push(item); added.push(item); }
    // Người dùng đã bỏ một mục mặc định: vẫn bỏ, kể cả khi mặc định mới đổi nội dung mục đó (báo xung đột).
    else if (!deepEqual(before.get(key), item)) conflict(item, undefined, item);
  }
  return finishSet(path, value, added, removed, context);
}

// Luật riêng của settings.json sau khi gộp: bỏ luật deny đã thay thế; pi-auto-mode nạp sau cùng
// để duyệt input cuối của mỗi tool call.
function finishSet(path, value, added, removed, context) {
  const setPath = path.join('.');
  let result = value;
  if (setPath === 'permissions.deny') {
    removed.push(...result.filter(rule => RETIRED_DENY.has(rule)));
    result = result.filter(rule => !RETIRED_DENY.has(rule));
  }
  if (added.length || removed.length) context.changes.push({type: 'items', path, added, removed});
  if (setPath === 'extensions') {
    const exclusion = entry => typeof entry === 'string' && /^[!-]/u.test(entry.trim());
    const autoMode = entry => typeof entry === 'string' && !/^[!+-]/u.test(entry.trim()) && /(?:^|[\\/])pi-auto-mode[\\/]*$/u.test(entry.trim());
    const first = result.findIndex(autoMode);
    if (first >= 0 && result.slice(first).some(entry => !autoMode(entry) && !exclusion(entry))) {
      const moved = result.filter(autoMode);
      result = [...result.filter(entry => !autoMode(entry)), ...moved];
      context.changes.push({type: 'last', path, item: moved.at(-1)});
    }
  }
  return result;
}

function mergeLeaf(path, base, next, current, context) {
  if (deepEqual(current, next)) return current;
  if (deepEqual(current, base)) {
    // Người dùng chưa đổi giá trị này: nhận mặc định mới (kể cả khi mặc định mới bỏ khóa).
    context.changes.push(current === undefined ? {type: 'add', path, value: next}
      : next === undefined ? {type: 'delete', path} : {type: 'set', path, from: current, to: next});
    return next;
  }
  if (deepEqual(next, base)) return current;
  context.conflicts.push({path, current, next});
  return current;
}

function mergeNode(path, base, next, current, context) {
  const setPath = path.join('.');
  if (context.settings && SET_PATHS.has(setPath) && Array.isArray(next) && Array.isArray(current)) {
    return mergeSet(path, Array.isArray(base) ? base : undefined, next, current, context);
  }
  if (!isObject(next) || !isObject(current)) return mergeLeaf(path, base, next, current, context);
  // Hai bên đều là object: gộp theo khóa, giữ thứ tự khóa của file hiện tại, khóa mới thêm vào cuối.
  const result = {};
  for (const key of Object.keys(current)) {
    const value = mergeNode([...path, key], own(base, key), own(next, key), current[key], context);
    if (value !== undefined) assign(result, key, value);
  }
  for (const key of Object.keys(next)) {
    if (Object.hasOwn(current, key)) continue;
    const value = mergeNode([...path, key], own(base, key), next[key], undefined, context);
    if (value !== undefined) assign(result, key, value);
  }
  return result;
}

/**
 * base undefined: gộp cộng dồn cho bản cài trước khi có base (giữ mọi giá trị hiện có, thêm khóa và mục còn thiếu).
 * settings: áp các luật mảng tập hợp, luật deny đã bỏ và thứ tự extension của settings.json.
 */
export function mergeConfig({base, next, current, settings = false}) {
  const context = {settings, changes: [], conflicts: []};
  const value = mergeNode([], base, next, current, context);
  return {value, changes: context.changes, conflicts: context.conflicts};
}

/**
 * Hành vi trước khi có base cho settings.json installer ghi mà người dùng chưa sửa: nhận mặc định mới
 * nhưng giữ các loại trừ extension "-" và mọi luật deny hiện có (deny chỉ thu hẹp quyền).
 */
export function carryLocalControls(next, current) {
  const value = structuredClone(next);
  const strings = list => Array.isArray(list) ? list.filter(entry => typeof entry === 'string') : [];
  const exclusions = strings(current?.extensions).filter(entry => entry.startsWith('-'));
  if (exclusions.length) value.extensions = [...new Set([...exclusions, ...strings(value.extensions)])];
  if (isObject(value.permissions)) {
    value.permissions.deny = [...new Set([...strings(value.permissions.deny), ...strings(current?.permissions?.deny)])]
      .filter(rule => !RETIRED_DENY.has(rule));
  }
  return value;
}

const stringify = value => `${JSON.stringify(value, null, 2)}\n`;

/**
 * Quyết định nội dung mới của một file cấu hình JSON khi cài lại (chuỗi vào, chuỗi ra).
 * unedited: file khớp checksum installer ghi lần trước, chỉ dùng khi chưa có base.
 * Trả content undefined khi giữ nguyên file; invalid khi file hiện tại không phải JSON.
 */
export function reconcileJson({next, current, base, unedited = false, settings = false}) {
  const nextValue = JSON.parse(next);
  if (current === undefined) return {content: next, changes: [], conflicts: []};
  let currentValue, baseValue;
  try { currentValue = JSON.parse(current.replace(/^\uFEFF/u, '')); } catch { return {invalid: true, changes: [], conflicts: []}; }
  if (base !== undefined) { try { baseValue = JSON.parse(base); } catch { baseValue = undefined; } }
  if (deepEqual(currentValue, nextValue)) return {changes: [], conflicts: []};
  // File chưa sửa so với lần cài trước: nhận nguyên mặc định mới, như file installer tự quản lý.
  if (baseValue !== undefined && deepEqual(currentValue, baseValue)) return {content: next, changes: [], conflicts: []};
  if (baseValue === undefined && unedited) {
    const value = settings ? carryLocalControls(nextValue, currentValue) : nextValue;
    return {content: deepEqual(value, currentValue) ? undefined : settings ? stringify(value) : next, changes: [], conflicts: []};
  }
  const merged = mergeConfig({base: baseValue, next: nextValue, current: currentValue, settings});
  return {
    content: deepEqual(merged.value, currentValue) ? undefined : stringify(merged.value),
    changes: merged.changes, conflicts: merged.conflicts, additive: baseValue === undefined,
  };
}

const formatPath = (path, item) => (path.map((key, i) => /^[A-Za-z_$][\w$]*$/u.test(key)
  ? `${i ? '.' : ''}${key}` : `[${JSON.stringify(key)}]`).join('') || '(toàn file)') + (item === undefined ? '' : `[${JSON.stringify(item)}]`);
const formatValue = value => {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  return text.length > 120 ? `${text.slice(0, 119)}…` : text;
};
const quote = value => formatValue(JSON.stringify(value) ?? 'undefined');

function formatChange(change) {
  const where = formatPath(change.path, change.type === 'last' ? undefined : change.item);
  if (change.type === 'add') return `thêm ${where} = ${quote(change.value)}`;
  if (change.type === 'delete') return `bỏ ${where} (mặc định mới không còn khóa này)`;
  if (change.type === 'set') return `${where}: ${quote(change.from)} → ${quote(change.to)}`;
  if (change.type === 'last') return `đưa ${formatValue(change.item)} về cuối ${where} (pi-auto-mode phải nạp sau cùng)`;
  return [change.added.length ? `thêm vào ${where}: ${change.added.map(formatValue).join(', ')}` : '',
    change.removed.length ? `bỏ khỏi ${where}: ${change.removed.map(formatValue).join(', ')}` : ''].filter(Boolean).join('; ');
}

function formatConflict(conflict, additive) {
  const where = formatPath(conflict.path, conflict.item);
  const kept = additive ? 'giữ giá trị hiện có' : 'giữ giá trị của bạn';
  if (conflict.current === undefined) return `xung đột: giữ việc bạn bỏ ${where}; mặc định mới là ${quote(conflict.next)}`;
  if (conflict.next === undefined) return `xung đột: ${kept} cho ${where}; mặc định mới đã bỏ khóa này`;
  return `xung đột: ${kept} cho ${where}; mặc định mới là ${quote(conflict.next)}`;
}

/** Dòng báo cáo tiếng Việt cho một file đã gộp; rỗng khi không có gì để báo. */
export function describeMerge({file, changes = [], conflicts = [], additive = false}) {
  if (!changes.length && !conflicts.length) return [];
  const header = additive
    ? `Chưa có mặc định của lần cài trước cho ${file}: giữ mọi giá trị hiện có${changes.length ? ', thêm phần mặc định mới còn thiếu' : ''}:`
    : changes.length ? `Đã gộp mặc định mới vào ${file}, giữ phần bạn đã sửa:` : `Giữ phần bạn đã sửa trong ${file}:`;
  return [header, ...changes.map(change => `  - ${formatChange(change)}`), ...conflicts.map(conflict => `  - ${formatConflict(conflict, additive)}`)];
}
