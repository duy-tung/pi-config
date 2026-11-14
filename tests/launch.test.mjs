import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repo = fileURLToPath(new URL("../", import.meta.url));

// Lệnh `pi` chạy Pi của runtime đã cài với agent dir của bản cài (PI_CODING_AGENT_DIR), chuyển nguyên tham số.
test("launcher chạy Pi với agent dir của bản cài và từ chối lệnh không thuộc pi-config", () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pi-launch-")));
  try {
    fs.mkdirSync(path.join(root, "runtime"));
    const launch = path.join(root, "runtime", "launch.mjs");
    fs.copyFileSync(path.join(repo, "runtime", "launch.mjs"), launch);
    fs.writeFileSync(path.join(root, "install-state.json"), JSON.stringify({ nodePath: process.execPath, agentDir: path.join(root, "agent") }));
    const entry = path.join(root, "runtimes", "current", "node_modules", "@earendil-works", "pi-coding-agent", "dist", "cli.js");
    fs.mkdirSync(path.dirname(entry), { recursive: true });
    fs.writeFileSync(entry, "process.stdout.write(JSON.stringify({ agentDir: process.env.PI_CODING_AGENT_DIR, args: process.argv.slice(2) }));\n");
    const env = { ...process.env };
    delete env.PI_CODING_AGENT_DIR;
    const output = JSON.parse(execFileSync(process.execPath, [launch, "main", "--version", "a b"], { env, encoding: "utf8" }));
    assert.deepEqual(output, { agentDir: path.join(root, "agent"), args: ["--version", "a b"] });
    // Bản trước có lệnh firecrawl; launcher cũ còn sót trên PATH phải dừng rõ ràng, không chạy nhầm Pi.
    const retired = spawnSync(process.execPath, [launch, "firecrawl", "--help"], { env, encoding: "utf8" });
    assert.notEqual(retired.status, 0);
    assert.match(retired.stderr, /Lệnh không hợp lệ: firecrawl/u);
    assert.equal(retired.stdout, "");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
