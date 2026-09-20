import fs from 'node:fs';
import path from 'node:path';
import {readJson, sha256} from './system.mjs';

// An unmanaged footer file may still live in the agent's auto-discovery folder.
// Preserve its existing exclusion rather than reactivating it on upgrade.
export function preserveLegacyFooterExclusion(file, log = console.log) {
  if (path.basename(file.path) !== 'settings.json' || !fs.existsSync(file.path)) return file;
  const footer = path.join(path.dirname(file.path), 'extensions/statusline.ts');
  const exclusion = `-${footer}`;
  if (!fs.existsSync(footer) || !readJson(file.path).extensions?.includes(exclusion)) return file;
  const next = JSON.parse(file.content);
  if (!next.extensions?.includes(exclusion)) next.extensions = [exclusion, ...(next.extensions ?? [])];
  log(`Giữ loại trừ footer cũ do người dùng quản lý: ${footer}`);
  return {...file, content: JSON.stringify(next, null, 2) + '\n'};
}

// Retire only installer-owned, unchanged resources no longer used by a profile.
// Modified or unowned configuration remains the user's data.
export function pruneInactiveConfiguration({root, agentDir, state, desiredFiles, log = console.log}) {
  const wanted = new Set(desiredFiles.map(file => file.path));
  const dirs = [agentDir, ...['goal','background','advisor'].map(name => path.join(root,'profiles',name))];
  const knownConfigs = new Set(['advisor.json','subagents.json','pi-goal-x-settings.json']);
  const obsoleteAssets = ['routing.json','routing-capabilities.json'].map(name => path.join(root,'assets/configs',name));
  let archive;
  const archived = [], preserved = [];
  for (const [file, expected] of Object.entries(state.files)) {
    if (wanted.has(file)) continue;
    const dir = dirs.find(candidate => file.startsWith(candidate + path.sep));
    const relative = dir && path.relative(dir, file);
    if (!obsoleteAssets.includes(file) && !(dir && (knownConfigs.has(relative) || (path.dirname(relative)==='agents' && path.extname(relative)==='.md')))) continue;
    if (!fs.existsSync(file)) { delete state.files[file]; continue; }
    if (fs.lstatSync(file).isSymbolicLink() || sha256(fs.readFileSync(file)) !== expected) {
      preserved.push(file); log(`Giữ cấu hình có tùy chỉnh, dù profile không dùng: ${file}`); continue;
    }
    archive ??= path.join(root,'backups',`inactive-config-${Date.now()}`);
    const label = dir ? `profile-${dirs.indexOf(dir)}/${relative}` : `assets/${path.basename(file)}`;
    const target = path.join(archive,label);
    fs.mkdirSync(path.dirname(target),{recursive:true,mode:0o700});
    fs.renameSync(file,target);
    if(process.platform!=='win32')fs.chmodSync(target,0o600);
    delete state.files[file]; archived.push(file);
  }
  if(archived.length)log(`Đã cất ${archived.length} cấu hình không còn dùng vào ${archive}.`);
  return {archived,preserved,archive};
}
