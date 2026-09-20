import fs from 'node:fs';
import path from 'node:path';
import {readJson, writeJson, sha256} from './system.mjs';

// Upgrade cleanup only; no runtime hooks or model calls. Preserve user edits
// while removing the exact extension path shipped by older pi-config releases.
export function retireDispatcher({root, agentDir, state, log = console.log}) {
  const component = path.join(root, 'assets/extensions/pi-dispatch-router');
  const entry = path.join(component, 'index.ts');
  const owned = file => Object.hasOwn(state.files, file);
  if (!owned(entry)) return;
  const writers = path.join(root, 'state/routing-writers');
  if (fs.existsSync(writers) && fs.readdirSync(writers).length) {
    throw new Error('Còn writer lock của dispatcher. Dừng task/Pi và kiểm tra lock trước khi cập nhật.');
  }
  const archive = path.join(root, 'backups', `dispatcher-removed-${Date.now()}`);
  const normalized = value => process.platform === 'win32' ? value.replaceAll('\\', '/').toLowerCase() : value;
  const matches = value => typeof value === 'string' && normalized(value.replace(/^-/, '')) === normalized(entry);
  const profiles = {main: agentDir, ...Object.fromEntries(['goal', 'background', 'advisor'].map(name => [name, path.join(root, 'profiles', name)]))};
  // Validate symlinks and JSON before any mutation.
  const settings = [];
  for (const [name, dir] of Object.entries(profiles)) {
    const file = path.join(dir, 'settings.json');
    if (fs.existsSync(file)) {
      if (fs.lstatSync(file).isSymbolicLink()) throw new Error(`Không sửa settings qua symlink: ${file}`);
      const data = readJson(file);
      if (data.extensions?.some(matches)) settings.push({name, file, data});
    }
  }
  if (fs.existsSync(component) && fs.lstatSync(component).isSymbolicLink()) throw new Error('Không gỡ dispatcher qua symlink.');
  fs.mkdirSync(archive, {recursive: true, mode: 0o700});
  const retire = (file, relative) => {
    if (!fs.existsSync(file)) return;
    const dest = path.join(archive, relative);
    fs.mkdirSync(path.dirname(dest), {recursive: true, mode: 0o700});
    fs.renameSync(file, dest);
    delete state.files[file];
  };
  for (const {name, file, data} of settings) {
    const wasManaged = sha256(fs.readFileSync(file)) === state.files[file];
    const backup = path.join(archive, 'profiles', name, 'settings.json');
    fs.mkdirSync(path.dirname(backup), {recursive: true, mode: 0o700});
    fs.copyFileSync(file, backup);
    if (process.platform !== 'win32') fs.chmodSync(backup, 0o600);
    log(`Gỡ dispatcher khỏi ${file}; sao lưu trước khi sửa và giữ các trường tùy chỉnh khác.`);
    data.extensions = data.extensions.filter(value => !matches(value));
    writeJson(file, data);
    // A theme/custom setting must not become an installer-owned default.
    if (wasManaged) state.files[file] = sha256(fs.readFileSync(file));
  }
  for (const [name, dir] of Object.entries(profiles)) {
    for (const file of ['routing.json', 'routing-capabilities.json']) {
      const target = path.join(dir, file);
      if (owned(target)) retire(target, path.join('profiles', name, file));
    }
    retire(path.join(dir, 'routing-state'), path.join('profiles', name, 'routing-state'));
  }
  retire(writers, 'routing-writers');
  retire(component, 'extension');
  for (const file of Object.keys(state.files)) if (file.startsWith(component + path.sep)) delete state.files[file];
  log(`Dispatcher đã gỡ; hồ sơ cũ lưu tại ${archive}.`);
}
