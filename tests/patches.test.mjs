import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { applyPatches, loadPatchData, patchSource, sourceHash } from "../lib/patches.mjs";

const fixtureSpec = {
  package: "fixture", file: "index.js", originalSha256: sourceHash("const value = 1;\n"),
  patchedSha256: sourceHash("const value = 2;\n"),
  edits: [{ before: "const value = 1;", after: "const value = 2;", count: 1 }],
};

test("bản vá có checksum, idempotent và chấp nhận CRLF", () => {
  const result = patchSource("const value = 1;\r\n", fixtureSpec);
  assert.deepEqual(result, { text: "const value = 2;\n", changed: true });
  assert.deepEqual(patchSource(result.text, fixtureSpec), { ...result, changed: false });
  assert.throws(() => patchSource("const value = 3;\n", fixtureSpec), /không ghi đè/);
});

test("không chấp nhận edit thiếu hoặc kết quả checksum sai", () => {
  assert.throws(() => patchSource("const value = 1;\n", {
    ...fixtureSpec, edits: [{ before: "absent", after: "changed", count: 1 }],
  }), /Không khớp source/);
  assert.throws(() => patchSource("const value = 1;\n", {
    ...fixtureSpec, patchedSha256: "0".repeat(64),
  }), /Checksum kết quả/);
});

test("edit chèn nội dung file trước after hoặc trước chuỗi neo", () => {
  const spec = (edit, result) => ({ ...fixtureSpec, patchedSha256: sourceHash(result), edits: [edit] });
  const inserted = "// thêm\nconst extra = 0;\n";
  assert.equal(patchSource("const value = 1;\n", spec({ before: "const value = 1;", insert: inserted, count: 1 }, `${inserted}const value = 1;\n`)).text,
    `${inserted}const value = 1;\n`);
  assert.equal(patchSource("const value = 1;\n", spec({ before: "const value = 1;", insert: inserted, after: "const value = 2;", count: 1 }, `${inserted}const value = 2;\n`)).text,
    `${inserted}const value = 2;\n`);
  // insertFile chưa được loadPatchData đọc thì không có gì để chèn: dừng thay vì ghi chuỗi rỗng.
  assert.throws(() => patchSource("const value = 1;\n", { ...fixtureSpec, edits: [{ before: "const value = 1;", insertFile: "x.js", count: 1 }] }), /không hợp lệ/);
});

test("insertFile chỉ đọc file trong assets/patches", async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), "pi-patch-data-"));
  try {
    const file = path.join(temp, "patches.json");
    await writeFile(file, JSON.stringify({ schemaVersion: 1, patches: [{ package: "fixture", file: "index.js", edits: [{ before: "x", insertFile: "../patches.json", count: 1 }] }] }));
    await assert.rejects(loadPatchData(pathToFileURL(file)), /phải nằm trong assets\/patches/);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

test("metadata ghim mười một bản vá cho một runtime", async () => {
  const data = await loadPatchData();
  assert.equal(data.schemaVersion, 1);
  assert.equal(data.patches.length, 11);
  for (const spec of data.patches) {
    assert.match(spec.originalSha256, /^[a-f0-9]{64}$/);
    assert.match(spec.patchedSha256, /^[a-f0-9]{64}$/);
    assert.deepEqual(Object.keys(spec.versions).sort(), ["current"]);
  }
  // Provider anthropic của pi-web-access: file nguồn trong repo được chèn nguyên văn vào dist/index.js.
  const webAccess = data.patches.find((spec) => spec.package === "pi-web-access");
  const insertion = webAccess.edits.find((edit) => edit.insertFile);
  assert.equal(insertion.insertFile, "pi-web-access/anthropic-search.js");
  assert.equal(insertion.insert, (await readFile(new URL("../assets/patches/pi-web-access/anthropic-search.js", import.meta.url), "utf8")).replace(/\r\n/g, "\n"));
  // Advisor: dòng ngân sách cố định để system prompt không đổi sau mỗi lần hỏi (giữ prompt cache của executor).
  const advisor = data.patches.find((spec) => spec.package === "pi-advisor-flow");
  const budget = advisor.edits.find((edit) => edit.before.includes("Advisor calls remaining this session"));
  assert.ok(budget && !budget.after.includes("remainingCalls"));
  // Mỗi phiên bắt đầu với advisor tắt, chỉ bật khi alwaysOn kích hoạt thành công: /advisor-off giữ qua phiên sau.
  assert.ok(advisor.edits.some((edit) => edit.before.includes("if (alwaysOnRef)") && edit.after.includes("runtime.flowEnabled()")));
  // Goal auditor: bash qua cổng permission của phiên cha.
  const auditor = data.patches.find((spec) => spec.package === "pi-goal-x");
  assert.equal(auditor.file, "extensions/goal-auditor.ts");
  assert.ok(auditor.edits.some((edit) => edit.after.includes("subagents:child:session-created")));
  // pi-subagents mention-clone trên Pi 0.87: bản sao lấy hội thoại qua SessionManager (không gán state của agent),
  // system prompt qua before_agent_start, và agent do bản sao khởi động luôn chạy nền (kể cả role ghim foreground).
  const clone = data.patches.find((spec) => spec.package === "@tintinweb/pi-subagents" && spec.file === "src/mention-clone.ts");
  assert.ok(clone.edits.some((edit) => edit.after.includes("SessionManager.inMemory(ctx.cwd, undefined, ctx.sessionManager.getBranch())")));
  assert.ok(clone.edits.some((edit) => edit.before.includes("session.agent.state.systemPrompt = systemPrompt") && edit.after === ""));
  assert.ok(clone.edits.some((edit) => edit.after.includes('pi.on("before_agent_start"')));
  const subagentsIndex = data.patches.find((spec) => spec.package === "@tintinweb/pi-subagents" && spec.file === "src/index.ts");
  const marker = 'Symbol.for("pi-config:mention-clone-spawn")';
  assert.ok(clone.edits.some((edit) => edit.after.includes(marker)) && subagentsIndex.edits.some((edit) => edit.after.includes(marker)));
  // pi-usage: Astra có Codex fast; request qua ModelRuntime dùng chung (advisor, auditor, Oracle) cũng theo fast.
  const usage = data.patches.find((spec) => spec.package === "@narumitw/pi-usage");
  assert.ok(usage.edits.some((edit) => edit.before.includes('"gpt-6-sol"') && edit.after.includes('"gpt-6-astra"')));
  assert.ok(usage.edits.some((edit) => edit.after.includes("runtime.streamSimple = wrapped") && edit.after.includes("requestModel ?? model")));
  // bg_run giữ mặc định của upstream: job xong tự đánh thức model; bản vá chỉ giới hạn shell job và viết lại mô tả.
  const background = data.patches.filter((spec) => spec.package === "pi-background-tasks");
  assert.deepEqual(background.map((spec) => spec.file), ["dist/src/extension.js"]);
  assert.ok(!background[0].edits.some((edit) => edit.before.includes("triggerOnCompletion ?? true")));
  assert.ok(background[0].edits.some((edit) => edit.after.includes("completion notification wakes you")));
  await assert.rejects(applyPatches({ root: os.tmpdir(), runtimes: ["../escape"] }), /Runtime phải/);
});
