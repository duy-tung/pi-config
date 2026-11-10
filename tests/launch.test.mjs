import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repo = fileURLToPath(new URL("../", import.meta.url));

// Firecrawl CLI từ 1.29.0 tự cài bản mới vào ~/.firecrawl cho bản cài global. Runtime ghim phiên bản theo lockfile, nên
// launcher tắt hẳn tự cập nhật cho CLI (lệnh `firecrawl`) và cho Pi (CLI do tool bash của Pi gọi thừa hưởng môi trường này).
test("launcher tắt tự cập nhật của Firecrawl CLI cho cả lệnh firecrawl và Pi", () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pi-launch-")));
  try {
    fs.mkdirSync(path.join(root, "runtime"));
    fs.copyFileSync(path.join(repo, "runtime", "launch.mjs"), path.join(root, "runtime", "launch.mjs"));
    fs.writeFileSync(path.join(root, "install-state.json"), JSON.stringify({ nodePath: process.execPath, agentDir: path.join(root, "agent") }));
    const stub = 'process.stdout.write(JSON.stringify({ autoUpdate: process.env.FIRECRAWL_NO_AUTO_UPDATE, agentDir: process.env.PI_CODING_AGENT_DIR }));\n';
    const entries = {
      firecrawl: path.join(root, "tools", "firecrawl", "node_modules", "firecrawl-cli", "dist", "index.js"),
      main: path.join(root, "runtimes", "current", "node_modules", "@earendil-works", "pi-coding-agent", "dist", "cli.js"),
    };
    const env = { ...process.env };
    delete env.FIRECRAWL_NO_AUTO_UPDATE;
    for (const [action, entry] of Object.entries(entries)) {
      fs.mkdirSync(path.dirname(entry), { recursive: true });
      fs.writeFileSync(entry, stub);
      const output = JSON.parse(execFileSync(process.execPath, [path.join(root, "runtime", "launch.mjs"), action], { env, encoding: "utf8" }));
      assert.deepEqual(output, { autoUpdate: "1", agentDir: path.join(root, "agent") }, action);
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
