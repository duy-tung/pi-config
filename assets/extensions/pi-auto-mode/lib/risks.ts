import path from "node:path";
import { insideAny, insideTemporary, resolveShellPath } from "./paths.ts";
import { commandName, type ShellAnalysis, type SimpleCommand } from "./shell.ts";

/**
 * Bộ nhận diện tất định cho những lệnh mà luật glob không diễn tả đúng (vừa bắt nhầm vừa bỏ lọt):
 * - cài cơ chế tự chạy: ghi file khởi động của shell, git hook, core.hooksPath, crontab, launchd,
 *   systemd, thư mục autostart, Task Scheduler, khóa Run của registry;
 * - tắt kiểm chứng chỉ TLS: curl -k, wget --no-check-certificate, NODE_TLS_REJECT_UNAUTHORIZED=0,
 *   GIT_SSL_NO_VERIFY, http.sslVerify=false, strict-ssl=false, pip --trusted-host (trừ localhost);
 * - ghi vào đường dẫn hệ thống hoặc thiết bị đĩa: /etc, /usr, /opt, /var, /Library, C:\Windows…,
 *   /dev/sdX, mkfs, chmod/chown -R trên thư mục hệ thống.
 * Kết quả là câu mô tả ("writes a shell startup file (~/.bashrc)"). Policy dùng nó để hỏi người dùng ở
 * bypass và gửi thẳng LLM giai đoạn 2 kèm ghi chú ở auto. Không có kết quả không có nghĩa là an toàn.
 */

export interface RiskContext {
  cwd: string;
  home: string;
  /** Thư mục làm việc và additionalDirectories: dự án ở /var/www, /opt/app không phải "đường dẫn hệ thống". */
  roots: string[];
  tempRoots: string[];
}

interface Target {
  file: string;
  /** Lệnh xoá (rm, unlink, shred): mô tả "deletes" thay cho "writes". */
  removes?: boolean;
}

const WRITE_REDIRECTS = new Set([">", ">>", ">|", "&>", "&>>", "<>"]);
const NO_TARGET = new Set(["/dev/null", "/dev/stdout", "/dev/stderr", "/dev/tty"]);
const DEST_LAST = new Set(["cp", "mv", "install", "ln", "rsync"]);
// Tùy chọn nhận giá trị ở từ kế tiếp, theo từng lệnh (ln -s, rsync -t không nhận giá trị).
const TARGET_DIRECTORY = ["-t", "--target-directory"];
const VALUE_OPTIONS: Record<string, Set<string>> = {
  cp: new Set([...TARGET_DIRECTORY, "-S", "--suffix"]),
  mv: new Set([...TARGET_DIRECTORY, "-S", "--suffix"]),
  ln: new Set([...TARGET_DIRECTORY, "-S", "--suffix"]),
  install: new Set([...TARGET_DIRECTORY, "-m", "-o", "-g", "-S", "--mode", "--owner", "--group", "--suffix"]),
  rsync: new Set([
    "-e", "--rsh", "-f", "--filter", "--exclude", "--include", "--exclude-from", "--include-from", "--files-from", "-T", "--temp-dir",
    "-B", "--block-size", "--partial-dir", "--compare-dest", "--copy-dest", "--link-dest", "--backup-dir", "--suffix", "--timeout",
    "--port", "--log-file", "--password-file", "--bwlimit", "--max-size", "--min-size",
  ]),
  truncate: new Set(["-s", "--size", "-r", "--reference"]),
  shred: new Set(["-n", "--iterations", "-s", "--size", "--random-source"]),
  sed: new Set(["-e", "--expression", "-f", "--file", "-l", "--line-length"]),
  crontab: new Set(["-u"]),
};
const NONE = new Set<string>();
const LOOPBACK = /^(?:localhost|127(?:\.\d{1,3}){3}|::1|\[::1\]|[a-z0-9-]+\.localhost)$/iu;
const FALSY = /^(?:false|0|no|off)$/iu;

const posix = (file: string) => file.replaceAll("\\", "/");
const isOption = (word: string) => word.length > 1 && word.startsWith("-");

/** $HOME/…, ${HOME}/… và ~/… được mở rộng; từ không-chữ-thuần khác thì không biết đích thật. */
function expand(word: string, literal: boolean, ctx: RiskContext, cwd: string): string | undefined {
  const home = /^(?:\$HOME|\$\{HOME\})(?=\/|$)/u;
  if (home.test(word)) return path.join(ctx.home, word.replace(home, ""));
  if (!literal || !word) return undefined;
  return resolveShellPath(word, cwd, ctx.home);
}

/** Chỉ số các đối số vị trí (không phải tùy chọn), bỏ giá trị của tùy chọn nhận giá trị. */
function positionals(command: SimpleCommand): number[] {
  const values = VALUE_OPTIONS[commandName(command)] ?? NONE;
  const result: number[] = [];
  let options = true;
  for (let i = 1; i < command.words.length; i++) {
    const word = command.words[i];
    if (options && word === "--") {
      options = false;
      continue;
    }
    if (options && isOption(word)) {
      if (values.has(word)) i++;
      continue;
    }
    result.push(i);
  }
  return result;
}

/** File mà lệnh ghi hoặc xoá: đích chuyển hướng, tee, cp/mv/ln đích cuối, sed -i, dd of=, curl -o… */
function writeTargets(command: SimpleCommand, ctx: RiskContext, cwd: string): Target[] {
  const targets: Target[] = [];
  const add = (index: number, removes = false) => {
    const file = expand(command.words[index], command.literal[index], ctx, cwd);
    if (file) targets.push({ file, removes });
  };
  for (const redirect of command.redirects) {
    if (!WRITE_REDIRECTS.has(redirect.op) || NO_TARGET.has(redirect.target) || /^\d+$|^-$/u.test(redirect.target)) continue;
    const file = expand(redirect.target, redirect.literal, ctx, cwd);
    if (file) targets.push({ file });
  }
  const name = commandName(command);
  const words = command.words;
  const args = positionals(command);
  if (name === "tee" || name === "truncate" || name === "shred") {
    for (const index of args) add(index, name === "shred");
  } else if (DEST_LAST.has(name)) {
    // Đích: -t DIR / --target-directory[=]DIR (cp, mv, install, ln), còn lại là đối số cuối (trừ đích rsync ở máy khác).
    const directory = name === "rsync" ? -1 : words.findIndex((word, i) => i > 0 && (TARGET_DIRECTORY.includes(word) ||
      word.startsWith("--target-directory=") || /^-t./u.test(word)));
    if (directory > 0) {
      const word = words[directory];
      const joined = word.startsWith("--target-directory=") ? word.slice(19) : /^-t./u.test(word) ? word.slice(2) : undefined;
      if (joined !== undefined) {
        const file = expand(joined, command.literal[directory], ctx, cwd);
        if (file) targets.push({ file });
      } else if (directory + 1 < words.length) add(directory + 1);
    } else if (args.length >= 2 && !(name === "rsync" && /^[^/]*:/u.test(words[args.at(-1) as number]))) {
      add(args.at(-1) as number);
    }
  } else if (name === "chmod" || name === "chown" || name === "chgrp") {
    for (const index of args.slice(1)) add(index);
  } else if (name === "rm" || name === "unlink" || name === "rmdir") {
    for (const index of args) add(index, true);
  } else if (name === "sed" && words.some((word) => /^-[nrEsuz]*i/u.test(word) || word.startsWith("--in-place"))) {
    // Script đứng trước file khi không có -e/-f; script (vd s/a/b/) không khớp đường dẫn nhạy cảm nào.
    for (const index of args) add(index);
  } else if ((name === "perl" || name === "ruby") && words.some((word) => /^-[a-zA-Z]*i/u.test(word))) {
    for (let i = 1; i < words.length; i++) {
      if (words[i] === "-e" || words[i] === "-E") i++;
      else if (!isOption(words[i])) add(i);
    }
  } else if (name === "dd") {
    words.forEach((word, i) => {
      if (word.startsWith("of=")) {
        const file = expand(word.slice(3), command.literal[i], ctx, cwd);
        if (file) targets.push({ file });
      }
    });
  } else if (name === "curl" || name === "wget") {
    words.forEach((word, i) => {
      const flag = name === "curl" ? /^(?:-o|--output)$/u : /^(?:-O|--output-document)$/u;
      const joined = name === "curl" ? /^--output=/u : /^--output-document=/u;
      if (flag.test(word) && i + 1 < words.length) add(i + 1);
      else if (joined.test(word)) {
        const file = expand(word.slice(word.indexOf("=") + 1), command.literal[i], ctx, cwd);
        if (file) targets.push({ file });
      }
    });
  }
  return targets;
}

/** Đường dẫn để hiển thị: tương đối với thư mục làm việc của phiên, hoặc ~/… trong HOME. */
function display(file: string, ctx: RiskContext): string {
  const value = posix(file);
  const base = posix(ctx.cwd).replace(/\/+$/u, "");
  if (value.startsWith(`${base}/`)) return value.slice(base.length + 1);
  const home = posix(ctx.home).replace(/\/+$/u, "");
  if (value === home) return "~";
  if (value.startsWith(`${home}/`)) return `~${value.slice(home.length)}`;
  return value;
}

const STARTUP_FILES = [
  ".bashrc", ".bash_profile", ".bash_login", ".bash_logout", ".profile", ".zshrc", ".zprofile", ".zshenv", ".zlogin",
  ".zlogout", ".cshrc", ".tcshrc", ".kshrc", ".xprofile", ".xinitrc", ".config/fish/config.fish",
  "Documents/PowerShell/Microsoft.PowerShell_profile.ps1", "Documents/PowerShell/profile.ps1",
  "Documents/WindowsPowerShell/Microsoft.PowerShell_profile.ps1", "Documents/WindowsPowerShell/profile.ps1",
];
const AUTOSTART_DIRS = [
  ".config/fish/conf.d", ".config/autostart", ".config/systemd/user", "Library/LaunchAgents",
  "AppData/Roaming/Microsoft/Windows/Start Menu/Programs/Startup",
];
const SYSTEM_STARTUP = [
  "/etc/profile", "/etc/profile.d", "/etc/bash.bashrc", "/etc/bashrc", "/etc/zshrc", "/etc/zsh", "/etc/environment",
  "/etc/crontab", "/etc/cron.d", "/etc/cron.hourly", "/etc/cron.daily", "/etc/cron.weekly", "/etc/cron.monthly",
  "/etc/systemd", "/etc/init.d", "/etc/rc.local", "/var/spool/cron", "/Library/LaunchAgents", "/Library/LaunchDaemons",
];
const SYSTEM_DIRS = [
  "/etc", "/usr", "/bin", "/sbin", "/lib", "/lib32", "/lib64", "/libx32", "/boot", "/opt", "/var", "/srv",
  "/System", "/Library", "/Applications", "/private/etc", "/private/var",
];
const NOT_SYSTEM = ["/var/tmp", "/var/folders", "/private/var/folders", "/private/tmp"];
const WINDOWS_SYSTEM = /^[a-z]:\/(?:windows|program files(?: \(x86\))?|programdata)(?:\/|$)/iu;
const DISK_DEVICE = /^\/dev\/(?:(?:sd|hd|vd|xvd)[a-z]|nvme\d|mmcblk\d|r?disk\d|mapper\/|md\d)/u;

const under = (file: string, dir: string) => file === dir || file.startsWith(`${dir}/`);

/** Mô tả rủi ro của một file bị ghi hoặc xoá, nếu có. */
function targetRisk(target: Target, ctx: RiskContext): string | undefined {
  const file = posix(target.file);
  const home = posix(ctx.home).replace(/\/+$/u, "");
  const shown = display(target.file, ctx);
  const verb = target.removes ? "deletes" : "writes";
  if (!target.removes) {
    if (STARTUP_FILES.some((item) => file === `${home}/${item}`)) return `writes a shell startup file (${shown})`;
    if (AUTOSTART_DIRS.some((item) => under(file, `${home}/${item}`))) return `writes an autostart location (${shown})`;
    if (/(?:^|\/)\.git\/hooks(?:\/|$)/u.test(file) || /(?:^|\/)\.husky\/(?!_\/)[^/]+$/u.test(file)) return `writes a git hook (${shown})`;
    if (/(?:^|\/)\.git\/config$/u.test(file)) return `writes a git config file (${shown}), which can set hooks or commands git runs`;
    if (SYSTEM_STARTUP.some((item) => under(file, item))) return `writes a system startup or scheduler file (${shown})`;
    if (DISK_DEVICE.test(file)) return `writes a disk device (${shown})`;
  }
  // HOME có thể nằm dưới /var (Fedora Silverblue: /var/home); dự án có thể ở /var/www, /opt/app, /srv.
  if (under(file, home) || insideAny(ctx.roots, target.file) || insideTemporary(target.file, ctx.tempRoots)) return undefined;
  const system = WINDOWS_SYSTEM.test(file) ||
    (SYSTEM_DIRS.some((item) => under(file, item)) && !NOT_SYSTEM.some((item) => under(file, item)));
  return system ? `${verb} a system path (${shown})` : undefined;
}

/** URL trong đối số: chỉ tính localhost/127.x/::1 là loopback; userinfo (localhost@evil) vẫn lấy đúng host. */
function allLoopback(words: string[]): boolean {
  const hosts = words.filter((word) => /^[a-z][a-z0-9+.-]*:\/\//iu.test(word) || /^(?:localhost|127\.|\[::1\])/iu.test(word)).map((word) => {
    try {
      return new URL(/^[a-z][a-z0-9+.-]*:\/\//iu.test(word) ? word : `http://${word}`).hostname;
    } catch {
      return "";
    }
  });
  return hosts.length > 0 && hosts.every((host) => LOOPBACK.test(host));
}

// Tùy chọn ngắn của curl nhận giá trị: phần còn lại của cụm là giá trị, không phải cờ khác.
const CURL_VALUE_FLAGS = new Set([..."AbcCdDeEFHKmoPQrtTuUwxXyYz"]);

function curlInsecure(words: string[]): boolean {
  for (const word of words.slice(1)) {
    if (word === "--") break;
    if (word === "--insecure" || word === "--proxy-insecure" || word === "--doh-insecure") return true;
    if (!/^-[a-zA-Z]+$/u.test(word)) continue;
    for (const flag of word.slice(1)) {
      if (flag === "k") return true;
      if (CURL_VALUE_FLAGS.has(flag)) break;
    }
  }
  return false;
}

/** Biến môi trường tắt kiểm TLS (gán trước lệnh, export, env). */
function insecureAssignment(assignment: string): string | undefined {
  const eq = assignment.indexOf("=");
  const name = assignment.slice(0, eq).replace(/\+$/u, "");
  const value = assignment.slice(eq + 1);
  if (name === "NODE_TLS_REJECT_UNAUTHORIZED" && value === "0") return "NODE_TLS_REJECT_UNAUTHORIZED=0";
  if (name === "GIT_SSL_NO_VERIFY" && !/^(?:|0|false|no)$/iu.test(value)) return "GIT_SSL_NO_VERIFY";
  if (name === "PYTHONHTTPSVERIFY" && value === "0") return "PYTHONHTTPSVERIFY=0";
  if (/^npm_config_strict_ssl$/iu.test(name) && FALSY.test(value)) return "npm strict-ssl=false";
  if (name === "PIP_TRUSTED_HOST" && value && !value.split(/\s+/u).every((host) => LOOPBACK.test(host))) return "PIP_TRUSTED_HOST";
  if ((name === "CURL_CA_BUNDLE" || name === "REQUESTS_CA_BUNDLE") && value === "") return `${name} set to empty`;
  return undefined;
}

const GIT_HOOK_KEYS = /^core\.(?:hookspath|fsmonitor)$/iu;
const GIT_SSL_KEY = /^http\.(?:.+\.)?sslverify$/iu;

/** git -c key=value … và git config [set] key value. */
function gitRisks(command: SimpleCommand): string[] {
  const risks: string[] = [];
  const args = command.words.slice(1);
  const check = (key: string, value: string | undefined, via: string) => {
    if (GIT_SSL_KEY.test(key) && value !== undefined && FALSY.test(value)) risks.push(`turns off TLS certificate checks (${via} http.sslVerify=${value})`);
    if (GIT_HOOK_KEYS.test(key) && value !== undefined && value !== "") risks.push(`changes the programs git runs (${key}=${value})`);
  };
  let i = 0;
  while (i < args.length && args[i].startsWith("-")) {
    if (args[i] === "-c" && i + 1 < args.length) {
      const [key, ...rest] = args[i + 1].split("=");
      check(key, rest.length ? rest.join("=") : "true", "git -c");
      i += 2;
    } else {
      i += ["-C", "--git-dir", "--work-tree", "--namespace", "--config-env"].includes(args[i]) ? 2 : 1;
    }
  }
  if (args[i] !== "config") return risks;
  const rest = args.slice(i + 1);
  if (rest.some((word) => /^--(?:get|get-all|get-regexp|list|unset|unset-all|remove-section|rename-section)$|^-l$/u.test(word))) return risks;
  const words: string[] = [];
  for (let j = 0; j < rest.length; j++) {
    const word = rest[j];
    if (["--file", "-f", "--blob", "--type", "--default", "--comment"].includes(word)) j++;
    else if (!word.startsWith("-")) words.push(word);
  }
  // git 2.46+: git config set key value / get / unset / list.
  if (["get", "unset", "list", "remove-section", "rename-section", "edit"].includes(words[0] ?? "")) return risks;
  if (words[0] === "set") words.shift();
  if (words.length >= 2) check(words[0], words[1], "git config");
  return risks;
}

function packageRisks(name: string, command: SimpleCommand): string[] {
  const args = command.words.slice(1);
  const risks: string[] = [];
  if (["npm", "pnpm", "yarn"].includes(name)) {
    const set = args.indexOf("set");
    const key = set >= 0 ? args[set + 1] : undefined;
    const value = set >= 0 ? args[set + 2] : undefined;
    const keyed = key?.split("=") ?? [];
    const off = (k: string | undefined, v: string | undefined) => !!k && /^(?:strict-ssl|enableStrictSsl)$/iu.test(k) && !!v && FALSY.test(v);
    if (off(keyed[0], keyed.length > 1 ? keyed[1] : value) || args.some((word, i) => word === "--no-strict-ssl" ||
      /^--strict-ssl=(?:false|0)$/iu.test(word) || (word === "--strict-ssl" && FALSY.test(args[i + 1] ?? "")))) {
      risks.push(`turns off TLS certificate checks (${name} strict-ssl=false)`);
    }
  }
  if (/^pip3?(?:\.\d+)?$/u.test(name) || (/^python3?(?:\.\d+)?$/u.test(name) && args[0] === "-m" && /^pip3?$/u.test(args[1] ?? ""))) {
    const hosts = args.flatMap((word, i) => word === "--trusted-host" ? [args[i + 1] ?? ""] : word.startsWith("--trusted-host=") ? [word.slice(15)] : []);
    const configured = args.some((word) => /(?:^|\.)trusted-host$/u.test(word)) && args.includes("set");
    if (configured || hosts.some((host) => !LOOPBACK.test(host.replace(/:\d+$/u, "")))) risks.push("turns off TLS certificate checks (pip --trusted-host)");
  }
  return risks;
}

function schedulerRisk(name: string, command: SimpleCommand): string | undefined {
  const args = command.words.slice(1);
  const first = args.find((word) => !word.startsWith("-"));
  if (name === "crontab") {
    // crontab FILE hoặc crontab - (stdin) thay toàn bộ crontab; -l xem, -r xoá (để bộ phân loại xét).
    const rest = positionals(command).map((index) => command.words[index]);
    const flags = args.filter((word) => word.startsWith("-") && word !== "-");
    if (flags.includes("-e")) return "edits the user's crontab";
    if (!flags.includes("-l") && !flags.includes("-r") && (rest.length || args.includes("-"))) return "installs a crontab";
  }
  if (name === "launchctl" && ["load", "bootstrap", "enable", "submit"].includes(first ?? "")) return `loads a launchd job (launchctl ${first})`;
  if (name === "systemctl" && ["enable", "link", "reenable", "preset", "add-wants", "add-requires"].includes(first ?? "")) return `enables a systemd unit (systemctl ${first})`;
  if (/^schtasks(?:\.exe)?$/iu.test(name) && args.some((word) => /^\/create$/iu.test(word))) return "creates a scheduled task (schtasks /create)";
  if (/^reg(?:\.exe)?$/iu.test(name) && /^add$/iu.test(args[0] ?? "") && args.some((word) => /\\CurrentVersion\\Run(?:Once)?(?:\\|$)/iu.test(word))) {
    return "adds a program that runs at login (registry Run key)";
  }
  if (/^sc(?:\.exe)?$/iu.test(name) && /^(?:create|config)$/iu.test(args[0] ?? "")) return `creates or changes a Windows service (sc ${args[0]})`;
  return undefined;
}

const DISK_TOOLS = /^(?:mkfs(?:\..+)?|mke2fs|mkswap|wipefs|fdisk|sfdisk|gdisk|sgdisk|parted)$/u;

function diskRisk(name: string, command: SimpleCommand): string | undefined {
  if (DISK_TOOLS.test(name)) return `formats or repartitions a disk (${name})`;
  if (name === "diskutil" && /^(?:erase|partition|zero|random|secureErase|reformat)/u.test(command.words[1] ?? "")) {
    return `erases or repartitions a disk (diskutil ${command.words[1]})`;
  }
  return undefined;
}

/** chmod/chown/chgrp -R trên /, thư mục cấp đầu, HOME hoặc thư mục hệ thống. */
function recursiveOwnership(name: string, command: SimpleCommand, ctx: RiskContext, cwd: string): string | undefined {
  if (!["chmod", "chown", "chgrp"].includes(name)) return undefined;
  if (!command.words.some((word) => word === "--recursive" || /^-[a-zA-Z]*R/u.test(word))) return undefined;
  const home = posix(ctx.home).replace(/\/+$/u, "");
  for (const index of positionals(command).slice(1)) {
    const file = expand(command.words[index], command.literal[index], ctx, cwd);
    if (!file) continue;
    const value = posix(file).replace(/(?<=.)\/+$/u, "");
    const topLevel = /^\/[^/]*$/u.test(value) || /^[a-z]:\/?[^/]*$/iu.test(value);
    if (topLevel || value === home) return `changes ownership or permissions recursively on ${display(file, ctx)}`;
  }
  return undefined;
}

/** Rủi ro của lệnh bash (đã phân tích). Theo dõi `cd` theo thứ tự để đích tương đối tính đúng thư mục. */
export function detectRisks(analysis: ShellAnalysis, ctx: RiskContext): string[] {
  const risks = new Set<string>();
  let cwd = ctx.cwd;
  for (const command of analysis.commands) {
    const name = commandName(command);
    if (name === "cd" || name === "pushd") {
      const word = command.words[1];
      const next = word === undefined ? ctx.home : word === "-" ? undefined : expand(word, command.literal[1], ctx, cwd);
      if (next) cwd = next;
    }
    for (const target of writeTargets(command, ctx, cwd)) {
      const risk = targetRisk(target, ctx);
      if (risk) risks.add(risk);
    }
    const assignments = [
      ...command.assignments,
      ...(["export", "env", "declare", "typeset", "setenv"].includes(name) ? command.words.slice(1).filter((word) => word.includes("=")) : []),
    ];
    for (const assignment of assignments) {
      const insecure = insecureAssignment(assignment);
      if (insecure) risks.add(`turns off TLS certificate checks (${insecure})`);
    }
    if (name === "curl" && curlInsecure(command.words) && !allLoopback(command.words.slice(1))) risks.add("turns off TLS certificate checks (curl -k)");
    if (name === "wget" && command.words.some((word) => word === "--no-check-certificate") && !allLoopback(command.words.slice(1))) {
      risks.add("turns off TLS certificate checks (wget --no-check-certificate)");
    }
    if (name === "git") for (const risk of gitRisks(command)) risks.add(risk);
    for (const risk of packageRisks(name, command)) risks.add(risk);
    const scheduler = schedulerRisk(name, command);
    if (scheduler) risks.add(scheduler);
    const disk = diskRisk(name, command);
    if (disk) risks.add(disk);
    const ownership = recursiveOwnership(name, command, ctx, cwd);
    if (ownership) risks.add(ownership);
  }
  return [...risks];
}

const POWERSHELL_RISKS: [RegExp, string][] = [
  [/-SkipCertificateCheck\b|ServerCertificateValidationCallback/iu, "turns off TLS certificate checks (PowerShell)"],
  [/\$env:NODE_TLS_REJECT_UNAUTHORIZED\s*=\s*['"]?0/iu, "turns off TLS certificate checks (NODE_TLS_REJECT_UNAUTHORIZED=0)"],
  [/\$env:GIT_SSL_NO_VERIFY\s*=/iu, "turns off TLS certificate checks (GIT_SSL_NO_VERIFY)"],
  [/\bschtasks(?:\.exe)?\s+\/create\b|\bRegister-ScheduledTask\b/iu, "creates a scheduled task"],
  [/\b(?:New-Service|sc(?:\.exe)?\s+create)\b/iu, "creates a Windows service"],
  [/\\CurrentVersion\\Run(?:Once)?\b/iu, "adds a program that runs at login (registry Run key)"],
  [/\b(?:Set-Content|Add-Content|Out-File)\b[^\n;|]*\$PROFILE\b|>>?\s*\$PROFILE\b/iu, "writes a PowerShell startup profile ($PROFILE)"],
  [/\b(?:Set-Content|Add-Content|Out-File|Copy-Item|Move-Item|New-Item|Remove-Item)\b[^\n;|]*[a-z]:\\(?:Windows|Program Files|ProgramData)\\/iu, "writes a system path (C:\\Windows, Program Files)"],
];

/** PowerShell không phân tích được bằng lexer bash: chỉ khớp mẫu trên chuỗi gốc. */
export function detectPowerShellRisks(command: string): string[] {
  return POWERSHELL_RISKS.filter(([pattern]) => pattern.test(command)).map(([, risk]) => risk);
}
