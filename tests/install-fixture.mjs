import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {buildConfiguration} from '../lib/config.mjs';
import {mergesConfig} from '../lib/resources.mjs';
import {reconcileConfigFile} from '../runtime/merge.mjs';
import {loadPresets, resolveModelRoles} from '../runtime/model-roles.mjs';

// Bản cài giả cho test của pi-models và /models; không chạy installer, không cài runtime.
export const repoDir = fileURLToPath(new URL('../', import.meta.url));
export const presets = loadPresets(path.join(repoDir, 'assets', 'configs', 'model-presets.json'));
export const sha256 = data => crypto.createHash('sha256').update(data).digest('hex');
export const readJson = file => JSON.parse(fs.readFileSync(file, 'utf8'));

/**
 * File cấu hình, base và checksum như installer ghi, cùng bản mẫu AGENTS.md và preset trong <root>/assets.
 * full: chép cả assets và runtime/*.mjs (vào <root>/bin) như installer, để nạp extension của bản cài.
 */
export function simulatedInstall(t, {roles = resolveModelRoles(presets).roles, full = false} = {}) {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-model-commands-'));
  t.after(() => fs.rmSync(temp, {recursive: true, force: true}));
  const root = path.join(temp, 'root'), agentDir = path.join(temp, 'agent');
  const options = {root, agentDir, binDir: path.join(temp, 'bin'), nodePath: process.execPath, home: temp, repoDir};
  const state = {files: {}};
  if (full) {
    fs.cpSync(path.join(repoDir, 'assets'), path.join(root, 'assets'), {recursive: true});
    fs.mkdirSync(path.join(root, 'bin'), {recursive: true});
    for (const name of fs.readdirSync(path.join(repoDir, 'runtime'))) fs.copyFileSync(path.join(repoDir, 'runtime', name), path.join(root, 'bin', name));
  }
  for (const {path: file, content} of buildConfiguration({...options, modelRoles: roles})) {
    if (mergesConfig(file, {root, agentDir})) {
      state.files[file] = reconcileConfigFile({root, file, content, recorded: state.files[file]}).recorded;
    } else {
      fs.mkdirSync(path.dirname(file), {recursive: true});
      fs.writeFileSync(file, content);
      state.files[file] = sha256(content);
    }
  }
  for (const name of ['AGENTS.md', path.join('configs', 'model-presets.json')]) {
    const copy = path.join(root, 'assets', name);
    fs.mkdirSync(path.dirname(copy), {recursive: true});
    fs.copyFileSync(path.join(repoDir, 'assets', name), copy);
    state.files[copy] = sha256(fs.readFileSync(copy));
  }
  const statePath = path.join(root, 'install-state.json');
  fs.writeFileSync(statePath, JSON.stringify(state));
  return {temp, root, agentDir, options, statePath, state: () => readJson(statePath), file: name => path.join(agentDir, name)};
}

/** sha256 của mọi file (bỏ qua symlink/junction tới runtime thật) để kiểm một bước không ghi gì. */
export function snapshot(...dirs) {
  const files = {};
  const walk = dir => {
    for (const entry of fs.existsSync(dir) ? fs.readdirSync(dir, {withFileTypes: true}) : []) {
      const file = path.join(dir, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) walk(file); else files[file] = sha256(fs.readFileSync(file));
    }
  };
  for (const dir of dirs) walk(dir);
  return files;
}

/** Nối runtime của bản cài thật (không chép) vào <root>/runtimes/current; trả hàm gỡ liên kết, gọi trước khi xoá thư mục tạm. */
export function linkRuntime(root, testRoot) {
  fs.mkdirSync(path.join(root, 'runtimes'), {recursive: true});
  const link = path.join(root, 'runtimes', 'current');
  fs.symlinkSync(path.join(testRoot, 'runtimes', 'current'), link, process.platform === 'win32' ? 'junction' : 'dir');
  return () => fs.unlinkSync(link);
}
