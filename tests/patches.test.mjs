import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile, mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
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

test("metadata ghim năm bản vá chung và backport OpenCode Go cho compat", async () => {
  const data = JSON.parse(await readFile(new URL("../assets/patches.json", import.meta.url), "utf8"));
  assert.equal(data.schemaVersion, 1);
  assert.equal(data.patches.length, 7);
  for (const spec of data.patches) {
    assert.match(spec.originalSha256, /^[a-f0-9]{64}$/);
    assert.match(spec.patchedSha256, /^[a-f0-9]{64}$/);
    assert.deepEqual(Object.keys(spec.versions).sort(), spec.file === 'dist/providers/opencode-go.js' ? ['compat'] : ["compat", "current"]);
  }
  await assert.rejects(applyPatches({ root: os.tmpdir(), runtimes: ["../escape"] }), /Runtime phải/);
});

// Kiểm thử thật sau npm ci trong install-smoke/CI; không đụng auth của máy chạy.
const installRoot = process.env.PI_CONFIG_TEST_ROOT;
for (const runtime of ["current", "compat"]) {
  test(`auth ${runtime}: shared defaults, explicit path, read helper và lock`, { skip: !installRoot }, async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "pi-config-auth-test-"));
    const savedAgent = process.env.PI_CODING_AGENT_DIR;
    const savedAuth = process.env.PI_CONFIG_AUTH_PATH;
    try {
      const defaultAgent = path.join(directory, "profile");
      await mkdir(defaultAgent);
      const profileFile = path.join(defaultAgent, "auth.json");
      const sharedFile = path.join(directory, "shared.json");
      const explicitFile = path.join(directory, "explicit.json");
      // Đây là dữ liệu fixture, không phải credential có hiệu lực.
      const credential = (marker) => ({ type: "oauth", access: `fixture-${marker}`, refresh: "fixture-refresh", expires: 1 });
      for (const [filename, marker] of [[profileFile, "profile"], [sharedFile, "shared"], [explicitFile, "explicit"]]) {
        await writeFile(filename, JSON.stringify({ "fixture-provider": credential(marker) }), { mode: 0o600 });
      }
      process.env.PI_CODING_AGENT_DIR = defaultAgent;
      process.env.PI_CONFIG_AUTH_PATH = sharedFile;
      const modulePath = path.join(installRoot, "runtimes", runtime, "node_modules", "@earendil-works/pi-coding-agent/dist/core/auth-storage.js");
      const { AuthStorage, FileAuthStorageBackend, ReadOnlyAuthStorage, readStoredCredential } = await import(pathToFileURL(modulePath).href);
      assert.deepEqual(await AuthStorage.create().read("fixture-provider"), credential("shared"));
      assert.deepEqual(await new ReadOnlyAuthStorage().read("fixture-provider"), credential("shared"));
      assert.deepEqual(readStoredCredential("fixture-provider"), credential("shared"));
      const actualBackend = new FileAuthStorageBackend();
      assert.deepEqual(actualBackend.withLock((text) => ({ result: JSON.parse(text)["fixture-provider"] })), credential("shared"));
      assert.deepEqual(await AuthStorage.create(explicitFile).read("fixture-provider"), credential("explicit"));
      assert.deepEqual(await new ReadOnlyAuthStorage(explicitFile).read("fixture-provider"), credential("explicit"));
      assert.deepEqual(readStoredCredential("fixture-provider", explicitFile), credential("explicit"));
      assert.deepEqual(new FileAuthStorageBackend(explicitFile).withLock((text) => ({ result: JSON.parse(text)["fixture-provider"] })), credential("explicit"));
      await AuthStorage.create().modify("fixture-provider", () => credential("updated"));
      assert.deepEqual(readStoredCredential("fixture-provider"), credential("updated"));
      assert.deepEqual(JSON.parse(await readFile(profileFile, "utf8"))["fixture-provider"], credential("profile"));
      delete process.env.PI_CONFIG_AUTH_PATH;
      assert.deepEqual(await AuthStorage.create().read("fixture-provider"), credential("profile"));
      assert.deepEqual(await new ReadOnlyAuthStorage().read("fixture-provider"), credential("profile"));
      assert.deepEqual(readStoredCredential("fixture-provider"), credential("profile"));
    } finally {
      if (savedAgent === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = savedAgent;
      if (savedAuth === undefined) delete process.env.PI_CONFIG_AUTH_PATH;
      else process.env.PI_CONFIG_AUTH_PATH = savedAuth;
      await rm(directory, { recursive: true, force: true });
    }
  });
}
