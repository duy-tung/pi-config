import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { SUBAGENT_ROLES } from "../runtime/model-roles.mjs";

// Skills quy trình (chuyển từ tstack sang Pi): kiểm cấu trúc và mọi tham chiếu, như tests/check_refs.py của tstack.
const repoDir = fileURLToPath(new URL("../", import.meta.url));
const skillsDir = path.join(repoDir, "assets", "skills");
// Skill theo stack: ngoài danh sách chung, /skill:setup chép vào .agents/skills/ của repo dùng stack đó.
const stackDir = path.join(repoDir, "assets", "stack-skills");
const rel = (file) => path.relative(repoDir, file).replaceAll("\\", "/");

function walk(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const file = path.join(dir, entry.name);
    return entry.isDirectory() ? walk(file) : [file];
  });
}

/** Frontmatter YAML đơn giản của SKILL.md: key: value một dòng, value có thể trong nháy. */
function frontmatter(text) {
  const match = /^---\n([\s\S]*?)\n---\n/u.exec(text.replace(/\r\n/gu, "\n"));
  if (!match) return undefined;
  const fields = {};
  for (const line of match[1].split("\n")) {
    const field = /^([A-Za-z][\w-]*):\s*(.*)$/u.exec(line);
    assert.ok(field, `dòng frontmatter không hợp lệ: ${line}`);
    let value = field[2].trim();
    if (/^".*"$/u.test(value)) value = JSON.parse(value);
    else if (/^'.*'$/u.test(value)) value = value.slice(1, -1).replaceAll("''", "'");
    fields[field[1]] = value;
  }
  return fields;
}

function readSkills(dir) {
  const found = new Map();
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const file = path.join(dir, entry.name, "SKILL.md");
    if (!fs.existsSync(file)) continue;
    found.set(entry.name, { file, fields: frontmatter(fs.readFileSync(file, "utf8")) });
  }
  return found;
}
const skills = readSkills(skillsDir);
const stackSkills = readSkills(stackDir);
const userInvoked = (name) => skills.get(name)?.fields?.["disable-model-invocation"] === "true";
const markdown = [...walk(skillsDir), ...walk(stackDir)].filter((file) => file.endsWith(".md"));
// Bỏ code block và comment HTML như check_refs.py: ví dụ trong code không phải tham chiếu thật.
const prose = (file) => fs.readFileSync(file, "utf8").replace(/^```[\s\S]*?^```/gmu, "").replace(/<!--[\s\S]*?-->/gu, "");

test("mỗi skill có frontmatter hợp lệ theo luật tên của Pi và chuẩn Agent Skills", () => {
  assert.ok(skills.size >= 25, `chỉ có ${skills.size} skill`);
  const allowed = new Set(["name", "description", "disable-model-invocation", "argument-hint", "license", "compatibility", "metadata", "allowed-tools"]);
  for (const [dir, { fields }] of [...skills, ...stackSkills]) {
    assert.ok(fields, `${dir}: thiếu frontmatter`);
    assert.equal(fields.name, dir, `${dir}: name phải trùng tên thư mục`);
    assert.match(fields.name, /^[a-z0-9]+(?:-[a-z0-9]+)*$/u, dir);
    assert.ok(fields.name.length <= 64, dir);
    assert.ok(fields.description && fields.description.length <= 1024, `${dir}: description rỗng hoặc quá 1024 ký tự`);
    assert.doesNotMatch(fields.description, /tstack:/u, dir);
    for (const key of Object.keys(fields)) assert.ok(allowed.has(key), `${dir}: khoá ${key} không dùng trên Pi`);
    if ("disable-model-invocation" in fields) assert.equal(fields["disable-model-invocation"], "true", dir);
  }
});

test("không còn tham chiếu riêng của Claude Code trong skills", () => {
  const forbidden = [
    /tstack:[a-z]/u, /Skill tool/u, /\$\{?CLAUDE_[A-Z_]+/u, /\.claude\//u, /AskUserQuestion/u, /TodoWrite|TaskCreate/u,
    /claude (?:-p|--bg)\b/u, /\/reload-plugins/u, /subagent_type: general-purpose/u, /codex exec|gemini -p/u,
    /NotebookEdit|disallowedTools/u, /^effort:|^paths:/mu,
  ];
  const problems = [];
  for (const file of [...walk(skillsDir), ...walk(stackDir)]) {
    const text = fs.readFileSync(file, "utf8");
    for (const pattern of forbidden) if (pattern.test(text)) problems.push(`${rel(file)}: ${pattern}`);
  }
  assert.deepEqual(problems, []);
});

test("mọi /skill:<tên> trỏ tới skill có thật; skill chỉ tự nạp skill model gọi được", () => {
  const problems = [];
  const agentsDocs = [path.join(repoDir, "assets", "AGENTS.md"), ...walk(path.join(repoDir, "docs")).filter((file) => file.endsWith(".md")),
    path.join(repoDir, "README.md")];
  for (const file of [...markdown, ...agentsDocs]) {
    const text = prose(file);
    for (const match of text.matchAll(/\/skill:([a-z0-9-]+)/gu)) {
      if (!skills.has(match[1])) problems.push(`${rel(file)}: /skill:${match[1]} không tồn tại`);
    }
    if (!file.startsWith(skillsDir) && !file.startsWith(stackDir)) continue;
    // "Load the `a` skill", "Load the `a` and `b` skills", "load the `a`, `b` and `c` skills".
    for (const match of text.matchAll(/\b[Ll]oad(?:s|ing)? the ((?:`[a-z0-9-]+`(?:,? (?:and )?)?)+) skills?\b/gu)) {
      for (const [, name] of match[1].matchAll(/`([a-z0-9-]+)`/gu)) {
        if (stackSkills.has(name)) problems.push(`${rel(file)}: ${name} là skill theo stack, chỉ có trong repo đã chạy /skill:setup`);
        else if (!skills.has(name)) problems.push(`${rel(file)}: nạp skill ${name} không tồn tại`);
        else if (userInvoked(name)) problems.push(`${rel(file)}: nạp ${name} là skill chỉ người gọi; hãy bảo người dùng chạy /skill:${name}`);
      }
    }
  }
  assert.deepEqual(problems, []);
});

test("skill theo stack nằm ngoài danh sách chung, setup chép được và bản chép tự đứng", () => {
  assert.deepEqual([...stackSkills.keys()].sort(), ["mobile", "python", "typescript"]);
  for (const name of stackSkills.keys()) assert.ok(!fs.existsSync(path.join(skillsDir, name)), `${name} còn trong assets/skills`);
  const setup = prose(path.join(skillsDir, "setup", "SKILL.md"));
  for (const name of stackSkills.keys()) assert.ok(setup.includes(`](../../stack-skills/${name}/SKILL.md)`), `setup không trỏ tới ${name}`);
  // Bản chép sang repo khác mang theo giấy phép (gồm notice của nguồn gốc MIT).
  assert.equal(fs.readFileSync(path.join(stackDir, "LICENSE"), "utf8"), fs.readFileSync(path.join(skillsDir, "LICENSE"), "utf8"));
  assert.ok(setup.includes("](../../stack-skills/LICENSE)"), "setup không chép LICENSE");
  // Bản chép nằm trong .agents/skills/<tên>/ của repo khác: link tương đối không được ra khỏi thư mục skill.
  const problems = [];
  for (const file of walk(stackDir).filter((entry) => entry.endsWith(".md"))) {
    const own = path.join(stackDir, path.relative(stackDir, file).split(path.sep)[0]);
    for (const match of prose(file).matchAll(/\]\(([^)\s]+)\)/gu)) {
      const target = match[1].split("#")[0];
      if (!target || /^[a-z][a-z+.-]*:/iu.test(target)) continue;
      if (path.relative(own, path.resolve(path.dirname(file), target)).startsWith("..")) problems.push(`${rel(file)}: ${match[1]}`);
    }
  }
  assert.deepEqual(problems, []);
});

test("agent được nhắc tới là role có thật của pi-config", () => {
  const roles = new Set(SUBAGENT_ROLES);
  const problems = [];
  for (const file of markdown) {
    for (const match of prose(file).matchAll(/`([A-Za-z][\w-]*)` (?:agent|agents|role)\b/gu)) {
      if (!roles.has(match[1])) problems.push(`${rel(file)}: \`${match[1]}\` không phải role (${[...roles].join(", ")})`);
    }
  }
  assert.deepEqual(problems, []);
});

test("preset được skill nhắc tới có trong model-presets.json", () => {
  const presets = new Set(Object.keys(JSON.parse(fs.readFileSync(path.join(repoDir, "assets", "configs", "model-presets.json"), "utf8"))));
  const problems = [];
  for (const file of markdown) {
    for (const match of prose(file).matchAll(/((?:`[\w-]+`(?:,? (?:and )?)?)+) presets?\b/gu)) {
      for (const [, name] of match[1].matchAll(/`([\w-]+)`/gu)) {
        if (!presets.has(name)) problems.push(`${rel(file)}: preset ${name} không có (${[...presets].join(", ")})`);
      }
    }
  }
  assert.deepEqual(problems, []);
});

test("skill gọi ask_advisor nói cách làm khi hết lượt hoặc không có tool (advisor tắt, subagent)", () => {
  // Số lượt advisor tính theo phiên và subagent không có ask_advisor (AGENTS.md).
  const problems = [];
  for (const file of markdown) {
    const text = prose(file);
    if (!text.includes("`ask_advisor`")) continue;
    if (!/calls (?:are )?left/u.test(text) || !/no `ask_advisor`/u.test(text)) problems.push(rel(file));
  }
  assert.deepEqual(problems, []);
});

test("link tương đối trong skills trỏ tới file có thật", () => {
  const problems = [];
  for (const file of markdown) {
    for (const match of prose(file).matchAll(/\]\(([^)\s]+)\)/gu)) {
      const target = match[1].split("#")[0];
      if (!target || /^[a-z][a-z+.-]*:/iu.test(target) || target.includes("<")) continue;
      if (!fs.existsSync(path.resolve(path.dirname(file), target))) problems.push(`${rel(file)}: ${match[1]}`);
    }
  }
  assert.deepEqual(problems, []);
});

test("mỗi script trong skills được skill của nó nhắc tới (không để script chết)", () => {
  const problems = [];
  for (const file of walk(skillsDir)) {
    const parts = path.relative(skillsDir, file).split(path.sep);
    if (!parts.includes("scripts")) continue;
    const skill = path.join(skillsDir, parts[0]);
    const mentioned = walk(skill).filter((entry) => entry.endsWith(".md")).some((entry) => fs.readFileSync(entry, "utf8").includes(path.basename(file)));
    if (!mentioned) problems.push(`${rel(file)}: không skill nào nhắc tới`);
  }
  assert.deepEqual(problems, []);
});
