import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { RewindDialog, describeCode, relativeTime } from "../assets/extensions/pi-rewind/lib/dialog.ts";
import { lineDiffCounts } from "../assets/extensions/pi-rewind/lib/diff.ts";
import { GitWatcher } from "../assets/extensions/pi-rewind/lib/gitwatch.ts";
import { History } from "../assets/extensions/pi-rewind/lib/history.ts";
import { JournalStore, planRecovery } from "../assets/extensions/pi-rewind/lib/journal.ts";
import { resolveToolPath } from "../assets/extensions/pi-rewind/lib/paths.ts";
import { applyRestore, describeRestore, planRestore, planStats } from "../assets/extensions/pi-rewind/lib/restore.ts";
import { ABSENT, BlobStore, Capturer } from "../assets/extensions/pi-rewind/lib/store.ts";

function sandbox() {
  // realpath native: Windows trả tên dài thay cho dạng 8.3 (RUNNER~1), giống realParent.
  const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "pi-rewind-test-")));
  const store = new BlobStore(path.join(dir, "store"));
  const capturer = new Capturer(store, { maxBytes: 1024 * 1024 });
  const work = path.join(dir, "work");
  fs.mkdirSync(work);
  return { dir, work, store, capturer, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

test("đếm dòng thêm/xóa như diff", () => {
  assert.deepEqual(lineDiffCounts("a\nb\nc\n", "a\nb\nc\n"), { insertions: 0, deletions: 0 });
  assert.deepEqual(lineDiffCounts("a\nb\nc\n", "a\nx\nc\n"), { insertions: 1, deletions: 1 });
  assert.deepEqual(lineDiffCounts("", "a\nb\n"), { insertions: 2, deletions: 0 });
  assert.deepEqual(lineDiffCounts("a\nb\nc\nd\n", "a\nd\n"), { insertions: 0, deletions: 2 });
  assert.deepEqual(lineDiffCounts("a\nb\n", "b\na\n"), { insertions: 1, deletions: 1 });
});

test("kho blob: ghi, đọc, chụp file và bỏ qua file quá lớn", () => {
  const { work, store, capturer, cleanup } = sandbox();
  try {
    const file = path.join(work, "a.txt");
    assert.equal(capturer.capture(file).kind, "absent");
    fs.writeFileSync(file, "hello\n");
    const version = capturer.capture(file);
    assert.equal(version.kind, "file");
    assert.equal(store.read(version.sha).toString(), "hello\n");
    assert.equal(version.dir, work);
    const big = path.join(work, "big.bin");
    fs.writeFileSync(big, Buffer.alloc(1024 * 1024 + 1));
    assert.equal(capturer.capture(big).kind, "unprotected");
    fs.mkdirSync(path.join(work, "folder"));
    assert.equal(capturer.capture(path.join(work, "folder")).kind, "unprotected");
    const old = Date.now() + 90 * 24 * 3600 * 1000;
    assert.equal(store.gc(1000, old), 1);
    assert.equal(store.has(version.sha), false);
  } finally {
    cleanup();
  }
});

test("đường dẫn tool giống resolveToCwd của Pi", () => {
  assert.equal(resolveToolPath("@src/a.ts", "/w"), path.resolve("/w/src/a.ts"));
  assert.equal(resolveToolPath("~/x", "/w"), path.join(os.homedir(), "x"));
  assert.equal(resolveToolPath("/abs/y", "/w"), path.resolve("/abs/y"));
  assert.equal(resolveToolPath(42, "/w"), undefined);
});

test("mục tiêu khôi phục theo thuật toán checkpoint của Claude Code", () => {
  const v = (sha) => ({ kind: "file", sha: sha.repeat(64).slice(0, 64), size: 1, mode: 0o644 });
  const history = new History();
  // Prompt 1: agent tạo a.txt (trước đó chưa có).
  history.apply({ v: 1, kind: "checkpoint", id: "c1", userEntryId: "u1", at: 1, delta: {} });
  history.apply({ v: 1, kind: "touch", checkpointId: "c1", file: "/w/a.txt", via: "write", pre: ABSENT });
  // Prompt 2: a.txt đã đổi thành bản 1; agent sửa tiếp và lần đầu chạm b.txt.
  history.apply({ v: 1, kind: "checkpoint", id: "c2", userEntryId: "u2", at: 2, delta: { "/w/a.txt": v("1") } });
  history.apply({ v: 1, kind: "touch", checkpointId: "c2", file: "/w/a.txt", via: "edit" });
  history.apply({ v: 1, kind: "touch", checkpointId: "c2", file: "/w/b.txt", via: "bash", pre: v("b") });
  history.apply({ v: 1, kind: "checkpoint", id: "c3", userEntryId: "u3", at: 3, delta: { "/w/a.txt": v("2"), "/w/b.txt": v("c") } });

  const toFirst = history.targetsFor(history.byUserEntry.get("u1"));
  assert.deepEqual(toFirst.get("/w/a.txt"), ABSENT);
  assert.deepEqual(toFirst.get("/w/b.txt"), v("b"));
  const toSecond = history.targetsFor(history.byUserEntry.get("u2"));
  assert.deepEqual(toSecond.get("/w/a.txt"), v("1"));
  assert.deepEqual(toSecond.get("/w/b.txt"), v("b"));
  const changes = history.turnChanges(history.byUserEntry.get("u2"), () => ABSENT);
  assert.deepEqual(changes.map((item) => item.file).sort(), ["/w/a.txt", "/w/b.txt"]);
  assert.deepEqual(history.delta((file) => (file === "/w/a.txt" ? v("2") : v("d"))), { "/w/b.txt": v("d") });
});

test("khôi phục ghi lại nội dung, xóa file mới, bỏ qua symlink và thư mục cha đã đổi", { skip: process.platform === "win32" }, async () => {
  const { work, store, capturer, cleanup } = sandbox();
  try {
    const kept = path.join(work, "kept.sh");
    fs.writeFileSync(kept, "one\n", { mode: 0o755 });
    const before = capturer.capture(kept);
    const created = path.join(work, "new", "created.txt");
    const absent = capturer.capture(created);
    fs.writeFileSync(kept, "two\nthree\n", { mode: 0o644 });
    fs.chmodSync(kept, 0o644);
    fs.mkdirSync(path.dirname(created));
    fs.writeFileSync(created, "x\n");
    const linkTarget = path.join(work, "target.txt");
    const link = path.join(work, "link.txt");
    fs.writeFileSync(linkTarget, "L1\n");
    const linkBefore = capturer.capture(link);
    fs.symlinkSync(linkTarget, link);
    const moved = path.join(work, "dir", "m.txt");
    fs.mkdirSync(path.dirname(moved));
    fs.writeFileSync(moved, "M1\n");
    const movedBefore = capturer.capture(moved);
    fs.renameSync(path.dirname(moved), path.join(work, "dir-real"));
    fs.symlinkSync(path.join(work, "dir-real"), path.join(work, "dir"));
    fs.writeFileSync(moved, "M2\n");

    const plan = planRestore(new Map([[kept, before], [created, absent], [link, linkBefore], [moved, movedBefore]]), capturer);
    assert.equal(plan.length, 4);
    const stats = planStats(plan, store);
    assert.ok(stats.insertions >= 1 && stats.deletions >= 2);
    const result = await applyRestore(plan, store, capturer);
    assert.equal(fs.readFileSync(kept, "utf8"), "one\n");
    assert.equal(fs.statSync(kept).mode & 0o111, 0o111);
    assert.equal(fs.existsSync(created), false);
    assert.deepEqual(result.skipped.map((item) => path.basename(item.file)).sort(), ["link.txt", "m.txt"]);
    assert.equal(fs.readFileSync(linkTarget, "utf8"), "L1\n");
    assert.equal(fs.readFileSync(path.join(work, "dir-real", "m.txt"), "utf8"), "M2\n");
    assert.match(describeRestore(result).warning, /skipped 2 files/u);
  } finally {
    cleanup();
  }
});

test("khôi phục ghi qua file tạm: đĩa đầy giữa chừng thì file cũ còn nguyên, không còn file tạm", async () => {
  const { work, store, capturer, cleanup } = sandbox();
  const fsync = fs.fsyncSync;
  try {
    const file = path.join(work, "app.ts");
    fs.writeFileSync(file, "checkpoint\n");
    const target = capturer.capture(file);
    fs.writeFileSync(file, "latest turn output\n");
    capturer.forget(file);
    fs.fsyncSync = () => { throw Object.assign(new Error("ENOSPC: no space left on device, fsync"), { code: "ENOSPC" }); };
    const result = await applyRestore(planRestore(new Map([[file, target]]), capturer), store, capturer);
    fs.fsyncSync = fsync;
    assert.equal(fs.readFileSync(file, "utf8"), "latest turn output\n");
    assert.deepEqual(result.failed.map((item) => [path.basename(item.file), item.partial]), [["app.ts", undefined]]);
    // Không file nào đổi: rewind báo lỗi, không ghi bản ghi Redo cho thay đổi không xảy ra.
    assert.match(describeRestore(result).error, /No files were restored/u);
    assert.deepEqual(fs.readdirSync(work).filter((name) => name.includes("pi-rewind")), []);
    const again = await applyRestore(planRestore(new Map([[file, target]]), capturer), store, capturer);
    assert.deepEqual(again.restored, [file]);
    assert.equal(fs.readFileSync(file, "utf8"), "checkpoint\n");
  } finally {
    fs.fsyncSync = fsync;
    cleanup();
  }
});

test("file có hard link: ghi tại chỗ để các link chung nội dung; lỗi khi đang ghi được báo là ghi dở", async () => {
  const { work, store, capturer, cleanup } = sandbox();
  const truncate = fs.ftruncateSync;
  try {
    const file = path.join(work, "shared.txt");
    const alias = path.join(work, "alias.txt");
    fs.writeFileSync(file, "checkpoint content\n");
    const target = capturer.capture(file);
    fs.writeFileSync(file, "later\n");
    fs.linkSync(file, alias);
    capturer.forget(file);
    const done = await applyRestore(planRestore(new Map([[file, target]]), capturer), store, capturer);
    assert.deepEqual(done.restored, [file]);
    assert.equal(fs.readFileSync(alias, "utf8"), "checkpoint content\n");
    fs.writeFileSync(file, "later again\n");
    capturer.forget(file);
    fs.ftruncateSync = () => { throw Object.assign(new Error("ENOSPC: no space left on device, ftruncate"), { code: "ENOSPC" }); };
    const result = await applyRestore(planRestore(new Map([[file, target]]), capturer), store, capturer);
    fs.ftruncateSync = truncate;
    assert.equal(result.failed[0].partial, true);
    // File ghi dở tính là đã đổi: lần khôi phục vẫn được ghi lại để Redo đưa file về.
    const message = describeRestore(result);
    assert.equal(message.error, undefined);
    assert.match(message.warning, /shared\.txt \(partly written: ENOSPC/u);
  } finally {
    fs.ftruncateSync = truncate;
    cleanup();
  }
});

test("khôi phục đủ quyền của file: file 0600 đã xoá quay lại với 0600", { skip: process.platform === "win32" }, async () => {
  const { work, store, capturer, cleanup } = sandbox();
  try {
    const file = path.join(work, "config.local.json");
    fs.writeFileSync(file, "{}\n", { mode: 0o600 });
    fs.chmodSync(file, 0o600);
    const target = capturer.capture(file);
    fs.unlinkSync(file);
    const result = await applyRestore(planRestore(new Map([[file, target]]), capturer), store, capturer);
    assert.deepEqual(result.restored, [file]);
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  } finally {
    cleanup();
  }
});

test("Redo lưu trạng thái ngay trước nó; Undo redo chỉ mở khi Redo là lần khôi phục mới nhất", () => {
  const v = (sha) => ({ kind: "file", sha: sha.repeat(64).slice(0, 64), size: 1, mode: 0o644 });
  const history = new History();
  history.apply({ v: 1, kind: "checkpoint", id: "c1", userEntryId: "u1", at: 1, delta: {} });
  history.apply({ v: 1, kind: "rewind", id: "r1", at: 2, checkpointId: "c1", mode: "both", fromLeafId: "leaf-a", previous: { "/w/a.txt": v("2") } });
  assert.equal(history.lastUndoneRewind()?.id, "r1");
  assert.equal(history.lastRedo(), undefined);
  // Redo ghi lại bản a.txt làm sau lần rewind (v3).
  history.apply({ v: 1, kind: "redo", id: "d1", rewindId: "r1", at: 3, previous: { "/w/a.txt": v("3") }, fromLeafId: "leaf-b" });
  assert.equal(history.lastUndoneRewind(), undefined);
  const redo = history.lastRedo();
  assert.deepEqual([redo?.id, redo?.mode, redo?.checkpointId, redo?.fromLeafId], ["d1", "both", "c1", "leaf-b"]);
  assert.deepEqual(redo?.previous.get("/w/a.txt"), v("3"));
  // Undo redo là một lần rewind mới: Redo đưa về lại được.
  history.apply({ v: 1, kind: "rewind", id: "u1", at: 4, checkpointId: "c1", mode: "both", fromLeafId: "leaf-a", previous: { "/w/a.txt": v("2") }, undoes: "d1" });
  assert.equal(history.lastRedo(), undefined);
  assert.equal(history.lastUndoneRewind()?.id, "u1");
  history.apply({ v: 1, kind: "redo", id: "d2", rewindId: "u1", at: 5, previous: { "/w/a.txt": v("3") }, fromLeafId: "leaf-b" });
  assert.equal(history.lastRedo()?.id, "d2");
  // Rewind mới sau Redo: Undo redo đóng lại.
  history.apply({ v: 1, kind: "rewind", id: "r2", at: 6, checkpointId: "c1", mode: "code", fromLeafId: "leaf-b", previous: {} });
  assert.equal(history.lastRedo(), undefined);
  // Bản ghi Redo cũ (không có id/previous) chỉ đánh dấu rewind đã redo.
  history.apply({ v: 1, kind: "redo", rewindId: "r2", at: 7 });
  assert.equal(history.lastRedo(), undefined);
  assert.equal(history.rewinds.find((item) => item.id === "r2")?.redone, true);
});

test("git watcher nhận file bash sửa, tạo và xóa; bỏ qua file bị ignore", async () => {
  const { work, capturer, cleanup } = sandbox();
  const git = (...args) => execFileSync("git", args, { cwd: work, stdio: "pipe" });
  try {
    git("init", "-q");
    // Kiểm theo dõi thay đổi, không phụ thuộc core.autocrlf của máy (Git for Windows bật sẵn).
    git("config", "core.autocrlf", "false");
    fs.writeFileSync(path.join(work, ".gitignore"), "ignored.txt\n");
    fs.writeFileSync(path.join(work, "clean.txt"), "C0\r\n");
    fs.writeFileSync(path.join(work, "gone.txt"), "G0\n");
    fs.writeFileSync(path.join(work, "dirty.txt"), "D0\n");
    fs.writeFileSync(path.join(work, ".gitattributes"), "clean.txt text eol=crlf\n");
    git("add", ".");
    git("-c", "user.name=t", "-c", "user.email=t@example.invalid", "commit", "-qm", "init");
    fs.writeFileSync(path.join(work, "dirty.txt"), "D1\n");
    const watcher = new GitWatcher(capturer, { slowMs: 5000, maxDirty: 500 });
    const window = await watcher.begin(work);
    assert.ok(window);
    fs.writeFileSync(path.join(work, "clean.txt"), "C1\r\n");
    fs.unlinkSync(path.join(work, "gone.txt"));
    fs.writeFileSync(path.join(work, "dirty.txt"), "D2\n");
    fs.writeFileSync(path.join(work, "made.txt"), "N\n");
    fs.writeFileSync(path.join(work, "ignored.txt"), "I\n");
    const changes = new Map((await watcher.end(window)).map((item) => [path.basename(item.file), item.before]));
    assert.deepEqual([...changes.keys()].sort(), ["clean.txt", "dirty.txt", "gone.txt", "made.txt"]);
    assert.equal(capturer.store.read(changes.get("clean.txt").sha).toString(), "C0\r\n");
    assert.equal(capturer.store.read(changes.get("dirty.txt").sha).toString(), "D1\n");
    assert.equal(capturer.store.read(changes.get("gone.txt").sha).toString(), "G0\n");
    assert.equal(changes.get("made.txt").kind, "absent");
  } finally {
    cleanup();
  }
});

test("git watcher tự tắt khi repo có quá nhiều file chưa commit", async () => {
  const { work, capturer, cleanup } = sandbox();
  try {
    execFileSync("git", ["init", "-q"], { cwd: work, stdio: "pipe" });
    for (const name of ["a", "b", "c"]) fs.writeFileSync(path.join(work, `${name}.txt`), name);
    const disabled = [];
    const watcher = new GitWatcher(capturer, { slowMs: 5000, maxDirty: 2, onDisable: (top, reason) => disabled.push(reason) });
    assert.equal(await watcher.begin(work), null);
    assert.match(disabled[0], /3 file chưa commit/u);
    assert.equal(await watcher.begin(work), null);
    assert.equal(disabled.length, 1);
  } finally {
    cleanup();
  }
});

test("hộp thoại Rewind: danh sách, xác nhận, lựa chọn như Claude Code", async () => {
  const theme = { fg: (_color, text) => text, bold: (text) => text, italic: (text) => text };
  const deps = { truncate: (text, width) => text.slice(0, width), width: (text) => text.length, wrap: (text) => [text], is: (data, key) => data === key };
  const executed = [];
  let closed = false;
  const dialog = new RewindDialog({
    rows: [
      { entryId: "u1", text: "first prompt", timestamp: 0, checkpointed: true },
      { entryId: "u2", text: "second prompt", timestamp: 0, checkpointed: false },
    ],
    canSummarize: true, bashTracked: false, terminalRows: () => 40, now: () => 60000,
    rowStats: async (row) => (row.entryId === "u1" ? { filesChanged: ["/w/a.ts"], insertions: 2, deletions: 1 } : null),
    restoreStats: async () => ({ filesChanged: ["/w/a.ts"], insertions: 1, deletions: 2 }),
    execute: async (choice) => { executed.push(choice); },
    done: () => { closed = true; }, requestRender: () => {},
  }, theme, deps);
  await new Promise((resolve) => setImmediate(resolve));
  let screen = dialog.render(80).join("\n");
  assert.match(screen, /Restore the code and\/or conversation to the point before…/u);
  assert.match(screen, /a\.ts \+2 -1/u);
  assert.match(screen, /No code restore/u);
  assert.match(screen, /❯ \(current\)/u);
  dialog.handleInput("up");
  dialog.handleInput("up");
  dialog.handleInput("enter");
  await new Promise((resolve) => setImmediate(resolve));
  screen = dialog.render(80).join("\n");
  assert.match(screen, /Confirm you want to restore to the point before you sent this message:/u);
  assert.match(screen, /\(1 minute ago\)/u);
  assert.match(screen, /The code will be restored \+1 -2 in a\.ts\./u);
  for (const label of ["1. Restore code and conversation", "2. Restore conversation", "3. Restore code", "4. Summarize from here", "5. Summarize up to here", "6. Never mind"]) {
    assert.ok(screen.includes(label), label);
  }
  assert.match(screen, /Rewinding does not affect files edited manually or via bash\./u);
  dialog.handleInput("down");
  dialog.handleInput("down");
  dialog.handleInput("down");
  for (const char of "keep notes") dialog.handleInput(char);
  dialog.handleInput("enter");
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(executed, [{ action: "summarize", entryId: "u1", instructions: "keep notes" }]);
  assert.equal(closed, true);
  assert.equal(relativeTime(0, 3 * 3600 * 1000), "3 hours ago");
  assert.equal(describeCode("code", true, { filesChanged: [], insertions: 0, deletions: 0 }), "The code has not changed (nothing will be restored).");
});

test("hộp thoại Rewind: phiên trước ở trên, Redo dưới (current), mỗi mục có màn hình xác nhận", async () => {
  const theme = { fg: (_color, text) => text, bold: (text) => text, italic: (text) => text };
  const deps = { truncate: (text, width) => text.slice(0, width), width: (text) => text.length, wrap: (text) => [text], is: (data, key) => data === key };
  const ran = [];
  let closed = 0;
  const options = (items, rows = []) => ({
    rows, items, canSummarize: false, bashTracked: true, terminalRows: () => 40,
    rowStats: async () => null, restoreStats: async () => undefined, execute: async () => {},
    runItem: async (key, value) => { ran.push([key, value]); }, done: () => { closed++; }, requestRender: () => {},
  });
  const resume = {
    key: "resume", position: "top", label: "Resume previous session", detail: "fix the login bug · 2 minutes ago",
    title: "Confirm you want to resume the previous session", lines: ["fix the login bug"], options: [{ value: "resume", label: "Resume previous session" }],
  };
  const redo = {
    key: "redo", position: "bottom", label: "Redo", detail: "Undo the last rewind: restore the code +1 -0 in a.ts",
    title: "Confirm you want to redo", lines: ["This will restore the code +1 -0 in a.ts."], options: [{ value: "redo", label: "Redo" }],
  };
  // Phiên mới sau /clear: không có prompt, vẫn có mục quay lại phiên trước.
  const empty = new RewindDialog(options([resume]), theme, deps);
  let screen = empty.render(80).join("\n");
  assert.doesNotMatch(screen, /Nothing to rewind to yet/u);
  assert.ok(screen.indexOf("Resume previous session") < screen.indexOf("(current)"));
  assert.match(screen, /fix the login bug · 2 minutes ago/u);
  empty.handleInput("up");
  empty.handleInput("enter");
  screen = empty.render(80).join("\n");
  assert.match(screen, /Confirm you want to resume the previous session:/u);
  assert.match(screen, /1\. Resume previous session/u);
  assert.match(screen, /2\. Never mind/u);
  empty.handleInput("2");
  assert.match(empty.render(80).join("\n"), /❯ Resume previous session/u);
  empty.handleInput("enter");
  empty.handleInput("1");
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(ran, [["resume", "resume"]]);
  assert.equal(closed, 1);
  // Redo nằm dưới (current).
  const rows = [{ entryId: "u1", text: "first prompt", timestamp: 0, checkpointed: true }];
  const withRedo = new RewindDialog(options([redo], rows), theme, deps);
  screen = withRedo.render(80).join("\n");
  assert.ok(screen.indexOf("(current)") < screen.indexOf("Redo"));
  withRedo.handleInput("down");
  withRedo.handleInput("enter");
  assert.match(withRedo.render(80).join("\n"), /This will restore the code \+1 -0 in a\.ts\./u);
  withRedo.handleInput("enter");
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(ran.at(-1), ["redo", "redo"]);
  // Không prompt, không mục nào: như trước.
  assert.match(new RewindDialog(options([]), theme, deps).render(80).join("\n"), /Nothing to rewind to yet/u);
});

test("nhật ký phục hồi: chỉ nhận lần khôi phục của process đã chết, hoàn tất/hoàn tác không đè file đã đổi", async () => {
  const { dir, work, store, capturer, cleanup } = sandbox();
  try {
    const journals = new JournalStore(path.join(dir, "store"));
    const [a, b, c] = ["a.txt", "b.txt", "c.txt"].map((name) => path.join(work, name));
    fs.writeFileSync(a, "A-now\n");
    fs.writeFileSync(b, "B-now\n");
    fs.writeFileSync(c, "C-now\n");
    const version = (text) => ({ kind: "file", sha: store.put(Buffer.from(text)), size: text.length, mode: 0o644, dir: work });
    const plan = [a, b, c].map((file) => ({ file, current: capturer.capture(file), target: version(`${path.basename(file)}-old\n`) }));
    const id = journals.begin({ sessionFile: "/s.jsonl", checkpointId: "c1" }, plan);
    // Process hiện tại còn sống: đang khôi phục, không phải bị gián đoạn.
    assert.deepEqual(journals.interrupted(), []);
    const [journal] = journals.interrupted(() => false);
    assert.equal(journal.id, id);
    assert.equal(journal.checkpointId, "c1");
    // Pi chết sau khi ghi a; c bị sửa tay sau đó.
    fs.writeFileSync(a, "a.txt-old\n");
    fs.writeFileSync(c, "C-edited\n");
    capturer.forget(a);
    capturer.forget(c);
    const finish = planRecovery(journal, "finish", capturer);
    assert.deepEqual(finish.plan.map((item) => path.basename(item.file)), ["b.txt"]);
    assert.deepEqual(finish.changed.map((file) => path.basename(file)), ["c.txt"]);
    const undo = planRecovery(journal, "undo", capturer);
    assert.deepEqual(undo.plan.map((item) => path.basename(item.file)), ["a.txt"]);
    await applyRestore(undo.plan, store, capturer);
    assert.equal(fs.readFileSync(a, "utf8"), "A-now\n");
    assert.equal(fs.readFileSync(c, "utf8"), "C-edited\n");
    journals.end(id);
    assert.deepEqual(journals.interrupted(() => false), []);
    // Quá hạn lưu giữ thì bị dọn (blob có thể đã mất).
    journals.begin({}, plan);
    journals.gc(1000, Date.now() + 5000);
    assert.equal(fs.readdirSync(journals.dir).length, 0);
  } finally {
    cleanup();
  }
});
