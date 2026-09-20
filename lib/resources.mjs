import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {readJson, sha256} from './system.mjs';

export function preserveLocalControls(file) {
  const settings = path.basename(file.path) === 'settings.json';
  const permissions = file.path.replaceAll('\\','/').endsWith('/extensions/pi-permission-system/config.json');
  if ((!settings && !permissions) || !fs.existsSync(file.path)) return file;
  const current = readJson(file.path);
  const next = JSON.parse(file.content);
  if (settings) {
    const exclusions = (current.extensions ?? []).filter(value => typeof value === 'string' && value.startsWith('-'));
    next.extensions = [...new Set([...exclusions, ...(next.extensions ?? [])])];
  } else {
    const denials = Object.fromEntries(Object.entries(current.permission?.path ?? {}).filter(([, value]) => value === 'deny'));
    next.permission.path = {...next.permission.path, ...denials};
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
