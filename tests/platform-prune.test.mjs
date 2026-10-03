import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {prunePlatformPackages} from '../lib/platform-prune.mjs';

// Runtime giả: lockfile như npm ci để lại (package lồng trong pi-coding-agent có shrinkwrap riêng) và package.json đã cài.
function fixture(t, packages) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-config-platform-'));
  t.after(() => fs.rmSync(dir, {recursive: true, force: true}));
  const lock = {name: 'runtime', lockfileVersion: 3, packages: {'': {}}};
  for (const [location, {lock: entry = {}, pkg}] of Object.entries(packages)) {
    lock.packages[location] = entry;
    if (pkg === undefined) continue;
    fs.mkdirSync(path.join(dir, location, 'bin'), {recursive: true});
    fs.writeFileSync(path.join(dir, location, 'package.json'), JSON.stringify(pkg));
  }
  fs.writeFileSync(path.join(dir, 'package-lock.json'), JSON.stringify(lock));
  return dir;
}
const nested = name => `node_modules/@earendil-works/pi-coding-agent/node_modules/@esbuild/${name}`;
const esbuild = (os, cpu) => ({lock: {optional: true, os: [os], cpu: [cpu]}, pkg: {name: `@esbuild/${os}-${cpu}`, os: [os], cpu: [cpu]}});

test('xoá package optional sai os/cpu, giữ package của máy này, package bắt buộc và package không ghi nền tảng', t => {
  const dir = fixture(t, {
    'node_modules/@earendil-works/pi-coding-agent': {pkg: {name: '@earendil-works/pi-coding-agent'}},
    [nested('darwin-arm64')]: esbuild('darwin', 'arm64'),
    [nested('darwin-x64')]: esbuild('darwin', 'x64'),
    [nested('linux-x64')]: esbuild('linux', 'x64'),
    [nested('win32-x64')]: esbuild('win32', 'x64'),
    'node_modules/not-windows': {lock: {optional: true}, pkg: {name: 'not-windows', os: ['!win32']}},
    'node_modules/not-darwin': {lock: {optional: true}, pkg: {name: 'not-darwin', os: '!darwin'}},
    'node_modules/any-cpu': {lock: {optional: true}, pkg: {name: 'any-cpu', cpu: ['any']}},
    'node_modules/plain-optional': {lock: {optional: true}, pkg: {name: 'plain-optional', os: false}},
    'node_modules/required-linux': {pkg: {name: 'required-linux', os: ['linux']}},
    'node_modules/missing-optional': {lock: {optional: true, os: ['linux']}},
  });
  const removed = prunePlatformPackages(dir, {platform: 'darwin', arch: 'arm64'}).map(file => path.relative(dir, file).split(path.sep).join('/'));
  assert.deepEqual(removed.sort(), [nested('darwin-x64'), nested('linux-x64'), nested('win32-x64'), 'node_modules/not-darwin'].sort());
  for (const kept of [nested('darwin-arm64'), 'node_modules/not-windows', 'node_modules/any-cpu', 'node_modules/plain-optional', 'node_modules/required-linux'])
    assert.ok(fs.existsSync(path.join(dir, kept, 'package.json')), kept);
  assert.deepEqual(prunePlatformPackages(dir, {platform: 'darwin', arch: 'arm64'}), []);
});

test('libc chỉ xét trên Linux: glibc giữ gói gnu, bỏ gói musl', t => {
  const pkg = libc => ({lock: {optional: true}, pkg: {name: `x-${libc}`, os: ['linux'], cpu: ['x64'], libc: [libc]}});
  const dir = fixture(t, {'node_modules/x-glibc': pkg('glibc'), 'node_modules/x-musl': pkg('musl')});
  assert.deepEqual(prunePlatformPackages(dir, {platform: 'linux', arch: 'x64', libc: 'glibc'}).map(file => path.basename(file)), ['x-musl']);
  assert.ok(fs.existsSync(path.join(dir, 'node_modules/x-glibc')));
});

test('không đi theo symlink, không ra ngoài node_modules, thiếu lockfile thì không xoá gì', t => {
  const outside = fixture(t, {'node_modules/victim': {pkg: {name: 'victim', os: ['aix']}}});
  const dir = fixture(t, {'node_modules/escape/../../outside': {lock: {optional: true}, pkg: {name: 'outside', os: ['aix']}}});
  fs.mkdirSync(path.join(dir, 'node_modules'), {recursive: true});
  const link = path.join(dir, 'node_modules', 'linked');
  fs.symlinkSync(path.join(outside, 'node_modules', 'victim'), link, process.platform === 'win32' ? 'junction' : 'dir');
  const lock = JSON.parse(fs.readFileSync(path.join(dir, 'package-lock.json'), 'utf8'));
  lock.packages['node_modules/linked'] = {optional: true};
  fs.writeFileSync(path.join(dir, 'package-lock.json'), JSON.stringify(lock));
  assert.deepEqual(prunePlatformPackages(dir, {platform: 'darwin', arch: 'arm64'}), []);
  assert.ok(fs.existsSync(path.join(outside, 'node_modules', 'victim', 'package.json')));
  assert.ok(fs.existsSync(path.join(dir, 'outside', 'package.json')));
  fs.rmSync(path.join(dir, 'package-lock.json'));
  assert.deepEqual(prunePlatformPackages(dir, {platform: 'darwin', arch: 'arm64'}), []);
});
