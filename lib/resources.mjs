import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {readJson, sha256} from './system.mjs';

/**
 * Luật deny của @gotgenes/pi-permission-system cũ (kể cả luật người dùng tự thêm)
 * chuyển thành permissions.deny của pi-auto-mode: path → Path(...), bash → Bash(...).
 */
export function legacyPermissionDenials(agentDir) {
  const file = path.join(agentDir, 'extensions', 'pi-permission-system', 'config.json');
  if (!fs.existsSync(file)) return [];
  let config;
  try { config = readJson(file); } catch { return []; }
  const permission = config?.permission ?? {};
  const denied = (value) => Object.entries(value ?? {}).filter(([, decision]) => decision === 'deny').map(([pattern]) => pattern);
  const rules = [
    ...denied(permission.path).map(pattern => `Path(${pattern})`),
    ...denied(permission.bash).map(pattern => `Bash(${pattern})`),
    ...Object.entries(permission).filter(([key, value]) => typeof value === 'string' && value === 'deny' && key !== '*').map(([key]) => key),
  ];
  // Luật deny-tất-cả sẽ khóa mọi tool; không chuyển.
  return rules.filter(rule => !['Path(*)', 'Path(**)', 'Bash(*)'].includes(rule));
}

// Luật deny installer từng ghi, nay do pi-auto-mode xử lý: Bash(rm -rf *) chặn hẳn rm -rf (kể cả khi người
// dùng muốn duyệt) nhưng để lọt rm -fr; thay bằng kiểm tra xoá đệ quy (bypass hỏi, auto qua bộ phân loại).
const RETIRED_DENY = new Set(['Bash(rm -rf *)']);

export function preserveLocalControls(file) {
  if (path.basename(file.path) !== 'settings.json') return file;
  const current = fs.existsSync(file.path) ? readJson(file.path) : {};
  const next = JSON.parse(file.content);
  const exclusions = (current.extensions ?? []).filter(value => typeof value === 'string' && value.startsWith('-'));
  next.extensions = [...new Set([...exclusions, ...(next.extensions ?? [])])];
  if (next.permissions) {
    // Giữ luật deny người dùng đã thêm và luật của bản permission cũ; deny chỉ thu hẹp quyền.
    const kept = (current.permissions?.deny ?? []).filter(value => typeof value === 'string');
    next.permissions.deny = [...new Set([...(next.permissions.deny ?? []), ...kept, ...legacyPermissionDenials(path.dirname(file.path))])]
      .filter(value => !RETIRED_DENY.has(value));
  }
  return {...file, content: JSON.stringify(next, null, 2) + '\n'};
}

function contains(directory, file) {
  const relative = path.relative(directory, file);
  return relative !== '' && relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative);
}

export function reconcileResources({root, agentDir, binDir, state, wanted, log = console.log}) {
  const directoryRoot = path.join(root,'profiles');
  const profiles = [agentDir, ...(fs.existsSync(directoryRoot)
    ? fs.readdirSync(directoryRoot,{withFileTypes:true}).filter(entry=>entry.isDirectory()).map(entry=>path.join(directoryRoot,entry.name)) : [])];
  const scopes = [...['assets','vendor','bin','config','tests'].map(name => path.join(root,name)), ...profiles, binDir];
  const references = [];
  for (const directory of profiles) {
    const settingsFile = path.join(directory,'settings.json');
    if (!fs.existsSync(settingsFile)) continue;
    const settings = readJson(settingsFile);
    for (const entry of [...(settings.extensions ?? []), ...(settings.themes ?? []), ...(settings.skills ?? []), ...(settings.prompts ?? []), ...(settings.packages ?? [])]) {
      const source = typeof entry === 'string' ? entry : entry?.source;
      if (typeof source !== 'string') continue;
      const resource = source.trim().replace(/^[!+-]/, '');
      if (/^(?:npm:|git:|https?:|github:)/u.test(resource)) continue;
      const target = resource === '~' || /^~[/\\]/u.test(resource)
        ? path.resolve(os.homedir(),resource.slice(2)) : path.resolve(directory,resource);
      if (!fs.existsSync(target)) {
        const wildcard = target.search(/[*?\[{]/u);
        if (wildcard >= 0) references.push(path.dirname(target.slice(0,wildcard) + '_'));
        continue;
      }
      if (fs.statSync(target).isDirectory()) references.push(target);
      else if (!wanted.has(target) || !state.files[target] || sha256(fs.readFileSync(target)) !== state.files[target]) references.push(path.dirname(target));
    }
  }
  const archived = [], preserved = [];
  let archive;
  for (const [file, expected] of Object.entries(state.files)) {
    if (wanted.has(file)) continue;
    const scope = scopes.find(directory => contains(directory,file));
    if (!scope || /^(auth|credentials)\.json$|^\.env(?:\.|$)/u.test(path.basename(file))) continue;
    if (!fs.existsSync(file)) { delete state.files[file]; continue; }
    const info = fs.lstatSync(file);
    if (!info.isFile() || references.some(directory => contains(directory,file)) || sha256(fs.readFileSync(file)) !== expected) {
      preserved.push(file); log(`Giữ tài nguyên đang được tham chiếu hoặc đã tùy chỉnh: ${file}`); continue;
    }
    archive ??= path.join(root,'backups',`resources-${Date.now()}`);
    const target = path.join(archive,String(scopes.indexOf(scope)),path.relative(scope,file));
    fs.mkdirSync(path.dirname(target),{recursive:true,mode:0o700});
    try { fs.renameSync(file,target); }
    catch (error) {
      if (error.code !== 'EXDEV') throw error;
      fs.copyFileSync(file,target,fs.constants.COPYFILE_EXCL);
      if (process.platform !== 'win32') fs.chmodSync(target,0o600);
      fs.unlinkSync(file);
    }
    if (process.platform !== 'win32') fs.chmodSync(target,0o600);
    delete state.files[file]; archived.push(file);
  }
  if (archived.length) log(`Đã lưu ${archived.length} tài nguyên ngoài cấu hình hiện tại tại ${archive}.`);
  return {archived,preserved,archive};
}
