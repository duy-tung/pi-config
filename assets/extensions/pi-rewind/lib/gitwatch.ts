import { spawn } from "node:child_process";
import path from "node:path";
import { ABSENT, type Capturer, type FileVersion, realParent, sameVersion } from "./store.ts";

export interface GitResult {
  code: number;
  stdout: Buffer;
  stderr: string;
  timedOut: boolean;
}

// Không bao giờ ghi vào repo của người dùng: status không làm mới index.
const GIT_ENV = { GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0", LC_ALL: "C" };

export function runGit(cwd: string, args: string[], input?: string, timeoutMs = 10000): Promise<GitResult> {
  return new Promise((resolve) => {
    const child = spawn("git", ["--no-optional-locks", ...args], {
      cwd, env: { ...process.env, ...GIT_ENV }, stdio: [input === undefined ? "ignore" : "pipe", "pipe", "pipe"], windowsHide: true,
    });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);
    child.stdout.on("data", (chunk: Buffer) => out.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => err.push(chunk));
    child.on("error", () => {
      clearTimeout(timer);
      resolve({ code: 127, stdout: Buffer.alloc(0), stderr: "không chạy được git", timedOut });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? 1, stdout: Buffer.concat(out), stderr: Buffer.concat(err).toString("utf8"), timedOut });
    });
    // git có thể thoát trước khi đọc hết stdin: EPIPE không được thành lỗi không bắt trong Pi.
    child.stdin?.on("error", () => {});
    if (input !== undefined) child.stdin?.end(input);
  });
}

/** `XY path` của `git status --porcelain=v1 -z`; bỏ thư mục (repo lồng, submodule). */
export function parseStatus(output: Buffer): Map<string, string> {
  const result = new Map<string, string>();
  for (const record of output.toString("utf8").split("\0")) {
    if (record.length < 4) continue;
    const file = record.slice(3);
    if (file.endsWith("/")) continue;
    result.set(file, record.slice(0, 2));
  }
  return result;
}

export interface WatchWindow {
  top: string;
  head: string | null;
  before: Map<string, FileVersion>;
}

export interface WatchChange {
  file: string;
  before: FileVersion;
}

export interface GitWatcherOptions {
  /** Status + chụp file bẩn chậm hơn ngưỡng này thì ngừng theo dõi repo trong phiên. */
  slowMs: number;
  /** Nhiều file chưa commit hơn ngưỡng này (vd. node_modules chưa ignore) thì ngừng theo dõi. */
  maxDirty: number;
  onDisable?: (top: string, reason: string) => void;
}

/**
 * Ghi nhận file bị thay đổi trong lúc một tool như bash hoặc Agent chạy.
 * Trước tool: chụp mọi file đang bẩn; file sạch lấy lại từ HEAD khi cần.
 * Sau tool: so sánh status để biết file nào đổi và nội dung trước đó.
 * Chỉ áp dụng trong git worktree; file bị .gitignore không được theo dõi.
 */
export class GitWatcher {
  readonly capturer: Capturer;
  readonly options: GitWatcherOptions;
  private readonly tops = new Map<string, Promise<string | null>>();
  private readonly disabled = new Set<string>();

  constructor(capturer: Capturer, options: GitWatcherOptions) {
    this.capturer = capturer;
    this.options = options;
  }

  topLevel(cwd: string): Promise<string | null> {
    let cached = this.tops.get(cwd);
    if (!cached) {
      cached = runGit(cwd, ["rev-parse", "--show-toplevel"]).then((result) => {
        if (result.code !== 0) return null;
        const top = result.stdout.toString("utf8").trim();
        return top ? path.resolve(top) : null;
      });
      this.tops.set(cwd, cached);
    }
    return cached;
  }

  isDisabled(top: string): boolean {
    return this.disabled.has(top);
  }

  private disable(top: string, reason: string): void {
    if (this.disabled.has(top)) return;
    this.disabled.add(top);
    this.options.onDisable?.(top, reason);
  }

  private async status(top: string): Promise<Map<string, string> | null> {
    const started = Date.now();
    const result = await runGit(top, ["status", "--porcelain=v1", "-z", "--untracked-files=all", "--no-renames", "--ignore-submodules=all"], undefined, Math.max(this.options.slowMs * 3, 5000));
    if (result.code !== 0) {
      this.disable(top, result.timedOut ? "git status quá thời gian" : `git status lỗi: ${result.stderr.trim().split("\n")[0] ?? ""}`);
      return null;
    }
    if (Date.now() - started > this.options.slowMs) this.disable(top, `git status mất ${Date.now() - started} ms`);
    return parseStatus(result.stdout);
  }

  async begin(cwd: string): Promise<WatchWindow | null> {
    const top = await this.topLevel(cwd);
    if (!top || this.disabled.has(top)) return null;
    const started = Date.now();
    const headResult = await runGit(top, ["rev-parse", "-q", "--verify", "HEAD^{commit}"]);
    const head = headResult.code === 0 ? headResult.stdout.toString("utf8").trim() : null;
    const status = await this.status(top);
    if (!status) return null;
    // Mỗi lần bash/Agent đều phải chụp toàn bộ file bẩn: quá nhiều thì ngừng thay vì làm chậm mọi tool.
    if (status.size > this.options.maxDirty) {
      this.disable(top, `${status.size} file chưa commit, vượt ngưỡng ${this.options.maxDirty}`);
      return null;
    }
    const before = new Map<string, FileVersion>();
    for (const file of status.keys()) before.set(file, this.capturer.capture(path.join(top, file)));
    const elapsed = Date.now() - started;
    if (elapsed > this.options.slowMs) this.disable(top, `chuẩn bị theo dõi mất ${elapsed} ms`);
    return { top, head, before };
  }

  async end(window: WatchWindow): Promise<WatchChange[]> {
    const status = await this.status(window.top);
    if (!status) return [];
    const candidates = new Set<string>([...window.before.keys(), ...status.keys()]);
    const changes: WatchChange[] = [];
    const fromHead: string[] = [];
    for (const file of candidates) {
      const absolute = path.join(window.top, file);
      const after = this.capturer.capture(absolute);
      const before = window.before.get(file);
      if (before) {
        // Hai lần đều không lưu được (file quá lớn...): không kết luận là tool đã sửa.
        if (before.kind === "unprotected" && after.kind === "unprotected") continue;
        if (!sameVersion(before, after)) changes.push({ file: absolute, before });
        continue;
      }
      // Trước tool file này sạch: nội dung trước là HEAD, hoặc chưa tồn tại nếu untracked.
      const code = status.get(file) ?? "";
      if (code === "??" || !window.head) changes.push({ file: absolute, before: { ...ABSENT, dir: realParent(absolute) } });
      else fromHead.push(file);
    }
    if (fromHead.length && window.head) {
      const versions = await this.headVersions(window.top, window.head, fromHead);
      for (const file of fromHead) {
        const absolute = path.join(window.top, file);
        const before = versions.get(file) ?? { kind: "unprotected", reason: "không đọc được nội dung từ HEAD" };
        if (!sameVersion(before, this.capturer.capture(absolute))) changes.push({ file: absolute, before });
      }
    }
    return changes;
  }

  /**
   * Nội dung worktree của các file tại HEAD, qua filter như checkout (CRLF, LFS smudge).
   * `cat-file --batch --filters` mất đường dẫn ở git 2.55 nên đọc từng file, song song có giới hạn.
   */
  private async headVersions(top: string, head: string, files: string[]): Promise<Map<string, FileVersion>> {
    const result = new Map<string, FileVersion>();
    const modes = new Map<string, number>();
    const tree = await runGit(top, ["ls-tree", "-z", "--full-tree", head, "--", ...files]);
    if (tree.code === 0) {
      for (const record of tree.stdout.toString("utf8").split("\0")) {
        const tab = record.indexOf("\t");
        if (tab > 0) modes.set(record.slice(tab + 1), record.startsWith("100755") ? 0o755 : 0o644);
      }
    }
    const limit = 500;
    const queue = files.slice(0, limit);
    for (const file of files.slice(limit)) result.set(file, { kind: "unprotected", reason: "quá nhiều file đổi trong một lần chạy" });
    const worker = async () => {
      for (let file = queue.shift(); file !== undefined; file = queue.shift()) {
        const absolute = path.join(top, file);
        if (tree.code === 0 && !modes.has(file)) {
          result.set(file, { ...ABSENT, dir: realParent(absolute) });
          continue;
        }
        const blob = await runGit(top, ["cat-file", "--filters", `${head}:${file}`], undefined, 30000);
        if (blob.code === 0) result.set(file, this.capturer.captureBuffer(blob.stdout, modes.get(file) ?? 0o644, absolute));
      }
    };
    await Promise.all(Array.from({ length: Math.min(8, queue.length) }, worker));
    return result;
  }
}
