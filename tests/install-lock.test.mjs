import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {acquireInstallLock} from '../runtime/install-lock.mjs';

test('khóa cài đặt: khóa của tiến trình đã chết được gỡ; tiến trình còn chạy thì báo PID', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-config-lock-'));
  t.after(() => fs.rmSync(root, {recursive: true, force: true}));
  const lock = path.join(root, '.install.lock');
  const release = acquireInstallLock(root);
  assert.equal(fs.readFileSync(lock, 'utf8'), String(process.pid));
  assert.throws(() => acquireInstallLock(root), new RegExp(`đang chạy \\(PID ${process.pid}\\)`, 'u'));
  release();
  assert.equal(fs.existsSync(lock), false);
  // Cài bị ngắt: file khóa của một tiến trình đã thoát.
  const dead = spawnSync(process.execPath, ['-e', '']).pid;
  fs.writeFileSync(lock, String(dead));
  const logs = [];
  const again = acquireInstallLock(root, message => logs.push(message));
  assert.match(logs.join('\n'), new RegExp(`tiến trình ${dead} không còn chạy`, 'u'));
  assert.equal(fs.readFileSync(lock, 'utf8'), String(process.pid));
  again();
  assert.deepEqual(fs.readdirSync(root), []);
  // File khóa rỗng (không rõ PID): không tự gỡ.
  fs.writeFileSync(lock, '');
  assert.throws(() => acquireInstallLock(root), /Installer hoặc \/models khác đang chạy: /u);
});
