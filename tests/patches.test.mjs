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
  await assert.rejects(applyPatches({ root: os.tmpdir(), runtimes: ["../escape"] }), /Runtime phải/);
});
