import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import os from "node:os";
import test from "node:test";
import { applyPatches, patchSource, sourceHash } from "../lib/patches.mjs";

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

test("metadata ghim tám bản vá cho một runtime", async () => {
  const data = JSON.parse(await readFile(new URL("../assets/patches.json", import.meta.url), "utf8"));
  assert.equal(data.schemaVersion, 1);
  assert.equal(data.patches.length, 8);
  for (const spec of data.patches) {
    assert.match(spec.originalSha256, /^[a-f0-9]{64}$/);
    assert.match(spec.patchedSha256, /^[a-f0-9]{64}$/);
    assert.deepEqual(Object.keys(spec.versions).sort(), ["current"]);
  }
  await assert.rejects(applyPatches({ root: os.tmpdir(), runtimes: ["../escape"] }), /Runtime phải/);
});
