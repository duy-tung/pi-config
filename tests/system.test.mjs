import assert from 'node:assert/strict';
import test from 'node:test';
import {COMMAND_TIMEOUT_MS, npmTimeout, run} from '../lib/system.mjs';

test('npm ci: giới hạn 30 phút, đổi bằng PI_CONFIG_NPM_TIMEOUT_MINUTES; giá trị sai thì dùng mặc định', () => {
  assert.equal(npmTimeout({}), 30 * 60000);
  assert.equal(npmTimeout({PI_CONFIG_NPM_TIMEOUT_MINUTES: '45'}), 45 * 60000);
  assert.equal(npmTimeout({PI_CONFIG_NPM_TIMEOUT_MINUTES: '0.5'}), 30000);
  for (const bad of ['0', '-5', 'abc', '']) assert.equal(npmTimeout({PI_CONFIG_NPM_TIMEOUT_MINUTES: bad}), 30 * 60000, bad);
  assert.ok(npmTimeout({}) > COMMAND_TIMEOUT_MS, 'npm ci được lâu hơn lệnh thường');
});

test('lệnh quá giờ báo rõ là quá giờ kèm gợi ý; lệnh lỗi báo mã thoát', async () => {
  const sleep = ['-e', 'setTimeout(() => {}, 60000)'];
  await assert.rejects(run(process.execPath, sleep, {stdio: 'ignore', timeout: 1000, timeoutHint: 'Tăng PI_CONFIG_NPM_TIMEOUT_MINUTES.'}),
    /^Error: Lệnh chạy quá 1 giây nên bị dừng: node(?:\.exe)?\. Tăng PI_CONFIG_NPM_TIMEOUT_MINUTES\.$/u);
  // npm bắt SIGTERM rồi thoát với mã 1: vẫn phải báo là quá giờ.
  const trapping = ['-e', "process.on('SIGTERM', () => process.exit(1)); setInterval(() => {}, 1000)"];
  await assert.rejects(run(process.execPath, trapping, {stdio: 'ignore', timeout: 1000}), /^Error: Lệnh chạy quá 1 giây nên bị dừng: node(?:\.exe)?$/u);
  await assert.rejects(run(process.execPath, ['-e', 'process.exit(3)'], {stdio: 'ignore'}), /^Error: Lệnh thất bại \(3\): node(?:\.exe)?$/u);
  await run(process.execPath, ['-e', ''], {stdio: 'ignore'});
});
