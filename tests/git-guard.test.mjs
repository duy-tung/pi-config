import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { baseProtectedBranches, checkGitGuard, DEFAULT_PROTECTED_BRANCHES, gitGuardOff } from "../assets/extensions/pi-auto-mode/lib/git-guard.ts";
import { gitGuardDenial } from "../assets/extensions/pi-auto-mode/lib/messages.ts";

// Bảng ca của tests/test_guard_git.py trong tstack (git guard gốc bằng Python), đổi tên cho pi-config:
// khoá git config tstack.protectedBranches → pi.protectedBranches, TSTACK_GIT_GUARD → PI_GIT_GUARD,
// TSTACK_PROTECTED_BRANCHES → PI_GIT_PROTECTED_BRANCHES. [lệnh, repo, chặn?]
const CASES = [
  ["git status", "feature", false],
  ["git push -u origin feature/x", "feature", false],
  ["git push --force-with-lease origin feature/x", "feature", false],
  ["git push --force origin feature/x", "feature", true],
  ["git push -f", "feature", true],
  ["git push -uf origin feature/x", "feature", true],
  ["git push origin +feature/x", "feature", true],
  ["git push origin :old-branch", "feature", true],
  ["git push --delete origin old", "feature", true],
  ["git push origin HEAD:main", "feature", true],
  ["git push origin main", "feature", true],
  ["git push origin release/1.2", "feature", true],
  ["git push", "main", true],
  ["git push origin", "main", true],
  ["git push", "feature", false],
  ["git push --no-verify", "feature", true],
  ["git -C sub push --force", "feature", true],
  ["cd app && git push --force", "feature", true],
  ["git reset --hard HEAD~1", "feature", true],
  ["git reset --soft HEAD~1", "feature", false],
  ["git reset HEAD file.txt", "feature", false],
  ["git clean -fd", "feature", true],
  ["git clean -xdf", "feature", true],
  ["git clean -n -fd", "feature", false],
  ["git clean -nd", "feature", false],
  ["git branch -D old", "feature", true],
  ["git branch -d old", "feature", false],
  ["git branch --delete --force old", "feature", true],
  ["git checkout .", "feature", true],
  ["git checkout -- .", "feature", true],
  ["git checkout -- src/a.ts", "feature", false],
  ["git checkout -b new-branch", "feature", false],
  ["git checkout -f main", "feature", true],
  ["git restore .", "feature", true],
  ["git restore --staged .", "feature", false],
  ["git restore src/a.ts", "feature", false],
  ["git stash drop", "feature", true],
  ["git stash clear", "feature", true],
  ["git stash push -u -m wip", "feature", false],
  ["git commit -m 'fix: thing'", "feature", false],
  ["git commit -n -m 'skip hooks'", "feature", true],
  ["git commit --no-verify -m x", "feature", true],
  ["HUSKY=0 git commit -m x", "feature", true],
  ["git -c core.hooksPath=/dev/null commit -m x", "feature", true],
  ["git config core.hooksPath .nohooks", "feature", true],
  ["git filter-branch --tree-filter x", "feature", true],
  ["git gc --prune=now", "feature", true],
  ["git gc", "feature", false],
  ["git commit -m 'docs: explain why git push --force is banned'", "feature", false],
  ["echo 'git reset --hard'", "feature", false],
  ["rm -rf node_modules dist", "feature", false],
  ["rm -rf .", "feature", true],
  ["rm -rf /", "feature", true],
  ["rm -rf ~", "feature", true],
  ["rm -rf ./*", "feature", true],
  ["rm file.txt", "feature", false],
  ["npm run format", "feature", false],
  ["git push -u origin HEAD", "main", true],
  ["git push -u origin HEAD", "feature", false],
  ["git push origin @", "main", true],
  ["git push --all origin", "feature", true],
  ["git push origin --tags", "main", false],
  ["git push origin v1.2.3", "main", false],
  ["git push --follow-tags", "main", true],
  ["git push -u origin hotfix/login-crash", "feature", false],
  ["git push -u origin release-notes-typo", "feature", false],
  ["git push origin refs/heads/main", "feature", true],
  ["git push", "custom", true],
  ["git push origin main", "custom", true],
  ["git push origin develop", "custom", true],
  ["git push origin feature/y", "custom", false],
  ["git config core.hooksPath .githooks", "feature", false],
  ["git config --get core.hooksPath", "feature", false],
  ["git config core.hooksPath", "feature", false],
  ["git config core.hooksPath /dev/null", "feature", true],
  ["git config --unset core.hooksPath", "feature", true],
  ["git config --global core.hooksPath .githooks", "feature", true],
  ["git config core.hooksPath ''", "feature", true],
  ["gh pr create --body \"Replaces \\`git clean -fd\\` in CI\"", "feature", false],
  ["git commit -m \"$(cat <<'EOF'\nfix(guard): stop treating quoted text as commands\n\nIt doesn't block `git reset --hard` (or rm -rf /) inside a message anymore.\nEOF\n)\"", "feature", false],
  ["git commit -F - <<'EOF'\ngit reset --hard is now blocked; see tests.\nEOF", "feature", false],
  ["git commit -m \"-n is not a flag here\"", "feature", false],
  ["git commit -nm 'x'", "feature", true],
  ["git commit -am 'x'", "feature", false],
  ["grep -rn \"reset --hard\" .", "feature", false],
  ["git log --oneline | head", "feature", false],
  ["git log --oneline # then git push -f", "feature", false],
  ["git diff 2>&1 | tee /tmp/out.txt", "feature", false],
  ["git push origin feature/x > /dev/null 2>&1", "feature", false],
  ["gh pr create --body \"Replaces `git clean -fd` in CI\"", "feature", true],
  ["echo \"$(git reset --hard)\"", "feature", true],
  ["cat <<EOF\n$(git reset --hard)\nEOF", "feature", true],
  ["diff <(git stash drop) b", "feature", true],
  ["sudo rm -rf /", "feature", true],
  ["sudo -u root rm -rf ~", "feature", true],
  ["FOO=1 rm -rf ~", "feature", true],
  ["for b in $(git branch --merged); do git branch -D $b; done", "feature", true],
  ["if true; then git reset --hard; fi", "feature", true],
  ["(git reset --hard)", "feature", true],
  ["{ git reset --hard; }", "feature", true],
  ["git branch --merged | xargs git branch -D", "feature", true],
  ["git branch --merged | xargs -n 1 git branch -d", "feature", false],
  ["timeout 60 git push --force", "feature", true],
  ["nice -n 10 git push -f", "feature", true],
  ["sleep 1 & git push -f", "feature", true],
  ["bash -c \"git reset --hard\"", "feature", true],
  ["bash -lc 'git push -f'", "feature", true],
  ["eval 'git reset --hard'", "feature", true],
  ["export HUSKY=0; git commit -m x", "feature", true],
  ["env HUSKY=0 git commit -m x", "feature", true],
  ["SKIP=eslint git commit -m x", "feature", true],
  ["git push \\\n  --force", "feature", true],
  ["git switch -f main", "feature", true],
  ["git switch --discard-changes main", "feature", true],
  ["git switch -c new-thing", "feature", false],
  ["git worktree remove --force ../wt", "feature", true],
  ["git worktree remove ../wt", "feature", false],
  ["rm -rf .git", "feature", true],
  ["rm -rf -- /", "feature", true],
  ["rm -rf \"$HOME\"", "feature", true],
  ["rm -rf ${HOME}/*", "feature", true],
  ["rm -rf build/ .cache", "feature", false],
  ["rm -rf ./dist", "feature", false],
  ["git config pi.protectedBranches none", "feature", true],
  ["git config --unset pi.protectedBranches", "feature", true],
  ["git config --get pi.protectedBranches", "feature", false],
  ["git push -u origin $(git branch --show-current)", "main", true],
  ["git push -u origin $(git branch --show-current)", "feature", false],
  ["git push origin \"$(git rev-parse --abbrev-ref HEAD)\"", "main", true],
  ["BRANCH=main; git push origin \"$BRANCH\"", "feature", true],
  ["git push origin \"$SOME_BRANCH\"", "feature", false],
  ["git config core.hooksPath docs", "feature", true],
  ["git config core.hooksPath src/../../outside", "feature", true],
  ["git config core.hooksPath .githooks", "subdir", false],
  ["bash <<'EOF'\ngit reset --hard\nEOF", "feature", true],
  ["sh -s <<EOF\ngit push -f\nEOF", "feature", true],
  ["echo 'git reset --hard' | bash", "feature", true],
  ["printf 'git status\\ngit clean -fd\\n' | sh", "feature", true],
  ["cat <<'EOF' | grep reset\ngit reset --hard\nEOF", "feature", false],
  ["echo 'git reset --hard' | grep reset", "feature", false],
  ["function nuke { git reset --hard; }; nuke", "feature", true],
  ["git stash -q drop", "feature", true],
  ["git rm -rf .", "feature", true],
  ["git rm -r --cached .", "feature", false],
  ["git rm -f src/a.ts", "feature", false],
  ["flock /tmp/l git push -f", "feature", true],
  ["python3 -c \"print('git reset --hard')\"", "feature", false],
  ["git fetch --prune", "feature", false],
  ["git remote prune origin", "feature", false],
  ["git pull --rebase", "feature", false],
  ["git log -p -- src/", "feature", false],
  ["git status --porcelain && git diff --stat", "feature", false],
  ["ls -la | grep git", "feature", false],
  ["npm test -- --watch=false", "feature", false],
  ["docker compose up -d && git log -1", "feature", false],
  ["git rebase -i HEAD~3", "feature", false],
  ["git commit --amend --no-edit", "feature", false],
  ["git tag -a v1.0.0 -m 'release 1.0.0' && git push origin v1.0.0", "feature", false],
  ["git switch -c fix/login && git push -u origin fix/login", "main", false]
];

function fixture() {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "pi-git-guard-test-")));
  const repo = (name, branch) => {
    const dir = path.join(root, name);
    execFileSync("git", ["init", "-q", "-b", branch, dir]);
    return dir;
  };
  const feature = repo("feature", "feature/x");
  const main = repo("main", "main");
  const custom = repo("custom", "staging");
  execFileSync("git", ["-C", custom, "config", "pi.protectedBranches", "main,staging"]);
  fs.mkdirSync(path.join(feature, ".githooks"));
  fs.writeFileSync(path.join(feature, ".githooks", "pre-commit"), "#!/bin/sh\nexit 0\n");
  fs.mkdirSync(path.join(feature, "docs"));
  fs.writeFileSync(path.join(feature, "docs", "README.md"), "# docs\n");
  const subdir = path.join(feature, "sub");
  fs.mkdirSync(subdir);
  return { dirs: { feature, main, custom, subdir }, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

// Môi trường của tiến trình Pi, bỏ các biến điều khiển guard của máy chạy test.
function environment(extra = {}) {
  const env = { ...process.env };
  delete env.PI_GIT_GUARD;
  delete env.PI_GIT_PROTECTED_BRANCHES;
  return { ...env, ...extra };
}

test("git guard: toàn bộ bảng ca của bản Python, kể cả lệnh thường ngày phải cho qua", (t) => {
  const f = fixture();
  t.after(f.cleanup);
  assert.equal(CASES.length, 159);
  const wrong = [];
  for (const [command, repo, blocked] of CASES) {
    const block = checkGitGuard(command, { cwd: f.dirs[repo], env: environment() });
    if (Boolean(block) !== blocked) wrong.push(`${blocked ? "phải chặn" : "phải cho qua"}: ${JSON.stringify(command)} (${repo})${block ? ` <${block.reason}>` : ""}`);
  }
  assert.deepEqual(wrong, []);
});

test("git guard: tên lệnh viết khác (escape, nháy, biến đã gán) vẫn bị kiểm", (t) => {
  const f = fixture();
  t.after(f.cleanup);
  const blocked = [
    "g\\it push --force origin feature", '"gi"t push -f origin feature', "gi''t push --force", "GIT=git; $GIT reset --hard",
    'export G=git; "$G" clean -fdx', "X='git push'; $X --force", "r\\m -rf /", "${GIT:-git} reset --hard",
    // Tiền tố tùy chọn dài, git và GNU rm nhận như tùy chọn đầy đủ.
    "git commit --no-veri -m x", "git push --no-ver", "git reset --har", "git clean --forc", "git switch --disc main",
    "git push --forc origin feature", "git branch --del --forc x", "rm --recur /",
  ];
  const passed = ["echo digit", "ls; rm -r build", "GIT=git; $GIT status", "$UNSET push --force",
    "git push --force-with-lease origin feature", "git clean --dry -f", "git restore --sta .", "git commit --all -m x", "git push --tags"];
  const wrong = [];
  for (const command of blocked) if (!checkGitGuard(command, { cwd: f.dirs.feature ?? Object.values(f.dirs)[0], env: environment() })) wrong.push(`phải chặn: ${command}`);
  for (const command of passed) {
    const block = checkGitGuard(command, { cwd: f.dirs.feature ?? Object.values(f.dirs)[0], env: environment() });
    if (block) wrong.push(`phải cho qua: ${command} <${block.reason}>`);
  }
  assert.deepEqual(wrong, []);
});

test("git guard: tắt bằng PI_GIT_GUARD của tiến trình, không bằng phép gán trong lệnh; danh sách nhánh từ môi trường và settings", (t) => {
  const f = fixture();
  t.after(f.cleanup);
  const { feature, custom } = f.dirs;
  assert.equal(checkGitGuard("git push --force", { cwd: feature, env: environment({ PI_GIT_GUARD: "off" }) }), undefined);
  assert.equal(checkGitGuard("git push --force", { cwd: feature, env: environment({ PI_GIT_GUARD: "OFF" }) }), undefined);
  assert.ok(checkGitGuard("PI_GIT_GUARD=off git push --force", { cwd: feature, env: environment() }));
  assert.ok(checkGitGuard("git push origin develop", { cwd: feature, env: environment({ PI_GIT_PROTECTED_BRANCHES: "develop" }) }));
  assert.equal(checkGitGuard("git push origin main", { cwd: feature, env: environment({ PI_GIT_PROTECTED_BRANCHES: "develop" }) }), undefined);
  // Settings thay danh sách mặc định; biến môi trường thắng settings; git config của repo chỉ thêm.
  assert.equal(checkGitGuard("git push origin main", { cwd: feature, env: environment(), protectedBranches: ["staging"] }), undefined);
  assert.ok(checkGitGuard("git push origin staging", { cwd: feature, env: environment(), protectedBranches: ["staging"] }));
  assert.deepEqual(baseProtectedBranches(environment({ PI_GIT_PROTECTED_BRANCHES: "a, b" }), ["staging"]), ["a", "b"]);
  assert.deepEqual(baseProtectedBranches(environment(), undefined), DEFAULT_PROTECTED_BRANCHES);
  assert.ok(checkGitGuard("git push origin staging", { cwd: custom, env: environment(), protectedBranches: ["develop"] }));
  assert.equal(gitGuardOff(environment()), false);
});

test("git guard: input lạ cho qua, lỗi của git runner không làm hỏng lệnh; câu báo chỉ cách người dùng tự chạy", (t) => {
  const f = fixture();
  t.after(f.cleanup);
  const { feature } = f.dirs;
  assert.equal(checkGitGuard(undefined, { cwd: feature, env: environment() }), undefined);
  assert.equal(checkGitGuard("", { cwd: feature, env: environment() }), undefined);
  const throwing = () => { throw new Error("boom"); };
  assert.equal(checkGitGuard("git push origin feature/x", { cwd: feature, env: environment(), git: throwing }), undefined);
  const block = checkGitGuard('gh pr create --body "Replaces `git clean -fd` in CI"', { cwd: feature, env: environment() });
  assert.equal(block.substitution, true);
  const message = gitGuardDenial(block);
  assert.match(message, /^BLOCKED by git guard: /u);
  assert.match(message, /run it themselves in Pi's editor with !<command>/u);
  assert.match(message, /sits inside backticks or \$\(\.\.\.\)/u);
  assert.match(gitGuardDenial(checkGitGuard("git push origin main", { cwd: feature, env: environment() })), /open a PR/u);
});
