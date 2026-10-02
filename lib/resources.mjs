import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {readJson, sha256} from './system.mjs';


function contains(directory, file) {
  const relative = path.relative(directory, file);
  return relative !== '' && relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative);
}

/**
 * File được gộp ba chiều khi cài lại: JSON của agent dir và <root>/config, và file role agents/*.md của agent dir
 * (frontmatter theo từng khóa, prompt là một giá trị). File khác giữ nguyên nếu người dùng sửa.
 */
export const mergesConfig = (file, {root, agentDir}) =>
  (path.extname(file) === '.json' && [agentDir, path.join(root, 'config')].some(directory => contains(directory, file))) ||
  (path.extname(file) === '.md' && path.dirname(file) === path.join(agentDir, 'agents'));

export function reconcileResources({root, agentDir, binDir, state, wanted, log = console.log}) {
  const scopes = [...['assets','vendor','bin','config','tests'].map(name => path.join(root,name)), agentDir, binDir];
  const references = [];
  // Thư mục được tham chiếu chỉ giữ file cũ khi nó không còn chứa file nào installer đang cài: tham chiếu tới cả
  // thư mục skills/extensions của installer (vd <root>/assets/extensions) không giữ mãi skill đã bị gỡ khỏi bản mới.
  const wantedFiles = [...wanted];
  const reference = directory => { if (!wantedFiles.some(file => contains(directory,file))) references.push(directory); };
  const settingsFile = path.join(agentDir,'settings.json');
  const settings = fs.existsSync(settingsFile) ? readJson(settingsFile) : {};
  for (const entry of [...(settings.extensions ?? []), ...(settings.themes ?? []), ...(settings.skills ?? []), ...(settings.prompts ?? []), ...(settings.packages ?? [])]) {
    const source = typeof entry === 'string' ? entry : entry?.source;
    if (typeof source !== 'string') continue;
    const resource = source.trim().replace(/^[!+-]/, '');
    if (/^(?:npm:|git:|https?:|github:)/u.test(resource)) continue;
    const target = resource === '~' || /^~[/\\]/u.test(resource)
      ? path.resolve(os.homedir(),resource.slice(2)) : path.resolve(agentDir,resource);
    if (!fs.existsSync(target)) {
      const wildcard = target.search(/[*?\[{]/u);
      if (wildcard >= 0) reference(path.dirname(target.slice(0,wildcard) + '_'));
      continue;
    }
    if (fs.statSync(target).isDirectory()) reference(target);
    else if (!wanted.has(target) || !state.files[target] || sha256(fs.readFileSync(target)) !== state.files[target]) references.push(path.dirname(target));
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
    // Thư mục chỉ còn rỗng sau khi dọn (vd skill đã gỡ) cũng bỏ, tới gốc phạm vi.
    for (let directory = path.dirname(file); contains(scope,directory); directory = path.dirname(directory)) {
      try { fs.rmdirSync(directory); } catch { break; }
    }
  }
  if (archived.length) log(`Đã lưu ${archived.length} tài nguyên ngoài cấu hình hiện tại tại ${archive}.`);
  return {archived,preserved,archive};
}
