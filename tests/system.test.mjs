import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {COMMAND_TIMEOUT_MS, download, npmTimeout, run, sha256, useEnvProxy} from '../lib/system.mjs';

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

test('download đi qua HTTP(S)_PROXY như npm và curl', async (t) => {
  // Proxy nhận CONNECT (fetch của Node luôn đi đường hầm) và nối tới một server cục bộ.
  const target = http.createServer((request, response) => response.end('via-proxy'));
  const proxy = http.createServer();
  const seen = [];
  proxy.on('connect', (request, socket, head) => {
    seen.push(request.url);
    const upstream = net.connect(target.address().port, '127.0.0.1', () => {
      socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      upstream.write(head);
      upstream.pipe(socket);
      socket.pipe(upstream);
    });
    socket.on('error', () => upstream.destroy());
    upstream.on('error', () => socket.destroy());
  });
  for (const server of [target, proxy]) await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => {
    for (const server of [target, proxy]) { server.closeAllConnections(); server.close(); }
  });
  const address = `http://127.0.0.1:${proxy.address().port}`;
  assert.equal(useEnvProxy({}), false);
  // download tự đọc biến proxy của tiến trình (mỗi file test chạy trong tiến trình riêng).
  for (const name of ['NO_PROXY', 'no_proxy']) delete process.env[name];
  Object.assign(process.env, {HTTP_PROXY: address, HTTPS_PROXY: address});
  const dest = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'pi-config-download-')), 'file');
  t.after(() => fs.rmSync(path.dirname(dest), {recursive: true, force: true}));
  // Máy test không phân giải được tên miền này: chỉ đi qua proxy mới tải được.
  assert.equal(await download('http://pi-config-proxy-test.invalid/archive.tgz', dest, sha256('via-proxy')), sha256('via-proxy'));
  assert.deepEqual(seen, ['pi-config-proxy-test.invalid:80']);
  assert.equal(fs.readFileSync(dest, 'utf8'), 'via-proxy');
});
