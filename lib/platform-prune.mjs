import fs from 'node:fs';
import path from 'node:path';

// npm (arborist) chỉ kiểm os/cpu của dependency optional lúc dựng cây từ lockfile. Package có npm-shrinkwrap.json
// riêng (pi-coding-agent) được nạp lại từ shrinkwrap đó trong lúc cài, mất dấu "bỏ qua" vừa đánh, nên mọi binary
// theo nền tảng bên trong nó đều được tải (26 gói @esbuild/*, ~280 MB). Sau npm ci, xoá các package optional
// không chạy được trên máy này.

/** Khớp trường os/cpu/libc của package.json như npm-install-checks: hỗ trợ "!x" và "any". */
function allows(list, value) {
  if (typeof list !== 'string' && !Array.isArray(list)) return true;
  const entries = [].concat(list).map(String);
  if (!entries.length || (entries.length === 1 && entries[0] === 'any')) return true;
  let negated = 0, match = false;
  for (const entry of entries) {
    if (entry.startsWith('!')) { negated++; if (entry.slice(1) === value) return false; }
    else if (entry === value) match = true;
  }
  return match || negated === entries.length;
}

/** libc của Linux đang chạy (glibc hoặc musl); hệ khác không có. */
export function hostLibc(platform = process.platform) {
  if (platform !== 'linux') return undefined;
  return process.report?.getReport?.().header?.glibcVersionRuntime ? 'glibc' : 'musl';
}

/**
 * Xoá package optional (theo package-lock.json của dir) đã cài nhưng os/cpu/libc trong package.json của chính nó
 * không khớp máy này. Package không optional, symlink, đường dẫn ra ngoài dir thì giữ; thiếu lockfile thì không xoá gì.
 * Trả danh sách đã xoá.
 */
export function prunePlatformPackages(dir, {platform = process.platform, arch = process.arch, libc = hostLibc(platform)} = {}) {
  let lock;
  try { lock = JSON.parse(fs.readFileSync(path.join(dir, 'package-lock.json'), 'utf8')); } catch { return []; }
  const modules = path.join(dir, 'node_modules');
  const removed = [];
  for (const [location, entry] of Object.entries(lock.packages ?? {})) {
    if (!entry?.optional || !location.startsWith('node_modules/')) continue;
    const target = path.resolve(dir, location);
    const relative = path.relative(modules, target);
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) continue;
    let pkg;
    try {
      if (fs.lstatSync(target).isSymbolicLink()) continue;
      pkg = JSON.parse(fs.readFileSync(path.join(target, 'package.json'), 'utf8'));
    } catch { continue; }
    const fits = allows(pkg.os, platform) && allows(pkg.cpu, arch) && (platform !== 'linux' || !libc || allows(pkg.libc, libc));
    if (fits) continue;
    fs.rmSync(target, {recursive: true, force: true});
    removed.push(target);
  }
  return removed;
}
