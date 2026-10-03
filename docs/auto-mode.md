# Permission: manual, auto và bypass

`pi-auto-mode` là extension riêng của pi-config (`assets/extensions/pi-auto-mode`), thay cho `@gotgenes/pi-permission-system`. Có ba mode, theo mode default, auto mode và bypassPermissions của Claude Code (auto và bypass tương ứng "Approve for me" và "Full Access" của Codex):

| Mode | Dòng dưới ô nhập | Hành vi |
|---|---|---|
| **Manual** | `⏸ manual mode on` | Thao tác an toàn và luật `allow` chạy ngay. Thao tác còn lại hỏi bạn: Allow once / Allow for this session / Deny. Không gọi model nào để duyệt |
| **Auto** (mặc định) | `⏵⏵ auto mode on` (vàng) | Thao tác an toàn chạy ngay. Thao tác còn lại do bộ phân loại hai giai đoạn duyệt, không hỏi người dùng: Jev (model System One của TypeSafe) sàng lọc, LLM xét kỹ phần bị gắn cờ |
| **Bypass** | `⏵⏵ bypass permissions on` (đỏ) | Không kiểm tra, trừ luật `deny`, luật `ask`, `rm` vào đường dẫn quan trọng, lệnh xoá đệ quy ra ngoài thư mục tạm và lệnh rủi ro ở bước 5 |

## Dùng

- `Shift+Tab` đổi mode theo vòng manual → auto → bypass → manual. Lần đầu vào bypass hiện cảnh báo cần đồng ý; lựa chọn được nhớ, từ chối thì sang manual. Bypass bị bỏ qua (vòng đi thẳng sang manual) khi chạy bằng root (trừ `IS_SANDBOX=1`) hoặc khi `permissions.disableBypassPermissionsMode` là `"disable"`.
- Mức thinking chuyển sang `Alt+T` (như Option+T của Claude Code; trên macOS terminal cần gửi Option như Alt — WezTerm mặc định với Option trái) hoặc `/thinking`.
- `/permissions` là menu duy nhất của cổng permission (thay `/auto-mode` cũ):

  ```
  Permissions · ⏵⏵ auto mode on
  ├─ Mode: auto — change…        chọn manual / auto / bypass (vào bypass vẫn qua cảnh báo)
  ├─ Classifier: <model> · <thinking>…
  │    tiêu đề: mode, model phân loại, timeout, Jev (nguồn key, số lần gọi, token, chi phí), số lần chặn, số luật
  │    └─ Change classifier model…   model đã đăng nhập → mức thinking; lưu settings.json, áp ngay
  ├─ Recently denied (N)          chọn một lệnh để duyệt cho một lần thử lại
  ├─ Rules…
  │    ├─ Your rules: allow / ask / deny (chỉ xem)
  │    └─ Built-in classifier rules (bộ luật mặc định của auto mode)
  └─ Test a command…              chạy thử quyết định cho một lệnh bash
  ```

  - **Recently denied**: lệnh bị bộ phân loại, luật hoặc chính bạn (manual) chặn. Chọn một lệnh để duyệt cho **một lần thử lại** đúng lệnh đó; Pi được báo "Permission granted for: …".
  - **Test a command** hoặc `/permissions test <lệnh bash>`: chạy thử quyết định. Chỉ ở auto mode mới gọi bộ phân loại (có thể tốn token) và in xác suất của Jev; manual và bypass chỉ báo lệnh sẽ được hỏi hay chạy.
  - Không có UI, `/permissions` gửi trạng thái như mục Classifier qua thông báo của extension, như `/auto-mode` cũ (print/JSON của Pi không hiện thông báo).
- Key Jev: biến môi trường `TYPESAFE_API_KEY`.
- Khởi động: `pi --permission-mode manual|auto|bypass` hoặc `pi --dangerously-skip-permissions`; mặc định lấy từ `permissions.defaultMode` (installer đặt `auto`). Nhận cả tên của Claude Code: `default` là manual, `bypassPermissions` là bypass; giá trị khác là `auto`. Mode bypass không bao giờ được khôi phục từ phiên cũ hay settings của project.

## Manual mode

Như mode default của Claude Code: lớp chính sách quyết định giống hệt auto (luật `deny` và git guard chặn, luật `ask` hỏi, lối đi nhanh ở bước 8 chạy ngay), nhưng mọi thứ auto gửi bộ phân loại (bước 9, kể cả phần đi thẳng giai đoạn 2) thì hỏi bạn. Không gọi Jev hay LLM để duyệt, nên không tốn token; probe prompt injection cũng không chạy.

- Hộp thoại `Allow <tool>: <tóm tắt>?` có ba lựa chọn. **Allow once** chạy lần này. **Allow for this session** chạy và không hỏi lại đúng lời gọi đó (cùng tool và cùng input sau chuẩn hóa, như khóa duyệt một lần của `/permissions`) tới hết phiên; lệnh khác dù chỉ một ký tự vẫn hỏi. **Deny** (hoặc Esc) chặn, agent được báo bạn đã từ chối và không được thử lại y nguyên hay lách; lần từ chối hiện trong `/permissions` → Recently denied.
- Lời gọi mà bypass vẫn hỏi (`rm` vào đường dẫn quan trọng, xoá đệ quy, lệnh rủi ro ở bước 5, deny đường dẫn không kiểm được) cũng hỏi ở manual, kèm ghi chú rủi ro trong hộp thoại.
- Luật `allow` có hiệu lực đầy đủ, kể cả luật cho chạy code tùy ý (`Bash(npm run *)`, `Bash(python *)`) mà auto bỏ qua.
- Không có UI (print, JSON, RPC không có client UI) thì lời gọi cần hỏi bị chặn và agent được báo lý do; chạy không người trông nên dùng `--permission-mode auto`.
- Subagent hỏi qua UI của phiên gốc (gắn nhãn `[subagent]`), và dùng chung danh sách "Allow for this session" với phiên gốc. Phiên gốc không có UI thì chặn.

## Auto mode quyết định thế nào

Mỗi tool call đi qua các bước sau, dừng ở bước đầu tiên có kết quả (thứ tự của Claude Code). Manual đi qua đúng các bước của auto; chỗ auto gửi bộ phân loại thì manual hỏi bạn.

1. **Luật `deny`** → chặn, ở mọi mode. Áp dụng cho tool file, đối số đường dẫn của lệnh shell (kể cả `$()`, `bash -c`, `sudo`, `xargs`) và tham số đường dẫn của MCP. Khi có deny đường dẫn áp dụng mà không kiểm được tập file, chặn trước `ask`, `allow`, bypass và bộ phân loại; xem giới hạn đọc bên dưới. Ngay sau luật deny là **git guard** (bash, `bg_run`): cũng chặn ở mọi mode, xem [Git guard](#git-guard).
2. **Luật `ask`** → hỏi người dùng (không có UI thì chặn).
3. **`rm`/`rmdir`/`find -delete` vào `/`, thư mục cấp đầu, `~`, thư mục con trực tiếp của `~`, thư mục làm việc hoặc thư mục cha của nó** → auto: gửi bộ phân loại kèm ghi chú; bypass: hỏi người dùng.
4. **Bypass, lệnh xoá đệ quy** (riêng pi-config) → hỏi người dùng. Nhận ra `rm -r`/`-R`/`--recursive` với mọi thứ tự cờ (`rm -fr`, `rm -r -f`, `/bin/rm`, `rm x -rf`), `find -delete` hoặc `-exec rm`, `git clean` (trừ `-n`/`--dry-run`), `rimraf`, `cmd /c rd /s`, `Remove-Item -Recurse`, kể cả trong `bash -c`, `$()`, `xargs` và qua `bg_run`. Không hỏi khi:
   - mọi đích nằm hẳn trong thư mục tạm của hệ thống (`os.tmpdir()`, thêm `/tmp` ngoài Windows). Đích phải là chữ thuần, không có `..`, tính theo đường dẫn thật (symlink trỏ ra ngoài không được miễn); glob chỉ ở thành phần cuối, và glob ngay dưới thư mục tạm phải có tiền tố (`/tmp/pi-test-*` được, `/tmp/*` thì không);
   - luật `allow` phủ đúng lệnh, vd `Bash(rm -rf node_modules)`.

   Ở auto, các lệnh này đi tiếp như mọi lệnh ghi, tới bộ phân loại.
5. **Lệnh rủi ro** (riêng pi-config, `lib/risks.ts`) → bypass: hỏi người dùng, trừ khi luật `allow` phủ đúng lệnh; auto: bộ phân loại kèm ghi chú, bỏ qua Jev và đi thẳng giai đoạn 2. Nhận ra tất định, kể cả trong `sudo`, `bash -c`, `$()` và sau `cd`:
   - **cài cơ chế tự chạy**:
     - ghi file khởi động của shell trong HOME (`~/.bashrc`, `~/.zshrc`, `~/.profile`, profile PowerShell…) hoặc thư mục autostart (`~/Library/LaunchAgents`, `~/.config/autostart`, `~/.config/systemd/user`);
     - ghi git hook (`.git/hooks/`, `.husky/`), `.git/config`, hoặc đặt `core.hooksPath`/`core.fsmonitor`;
     - `crontab FILE|-|-e`, `launchctl load|bootstrap`, `systemctl enable`, `schtasks /create`, khóa `Run` của registry, `sc create`;
     - file khởi động hoặc lịch chạy của hệ thống (`/etc/profile.d`, `/etc/cron.d`, `/etc/systemd`, `/Library/LaunchDaemons`…);
   - **tắt kiểm chứng chỉ TLS**:
     - `curl -k` (cả cụm cờ như `-fsSLk`), `--insecure`, `wget --no-check-certificate`;
     - `NODE_TLS_REJECT_UNAUTHORIZED=0`, `GIT_SSL_NO_VERIFY`, `PYTHONHTTPSVERIFY=0`, `git -c http.sslVerify=false`, `git config http.sslVerify false`, `strict-ssl=false` của npm/pnpm/yarn, `pip --trusted-host`.

     Không tính khi mọi URL là localhost/127.x/::1; host được lấy bằng bộ phân tích URL, nên `localhost@evil.example` không lọt;
   - **ghi đường dẫn hệ thống hoặc đĩa**:
     - ghi hoặc xoá dưới `/etc`, `/usr`, `/opt`, `/var`, `/System`, `/Library`, `C:\Windows`, `Program Files` (trừ thư mục tạm, HOME, thư mục làm việc và `additionalDirectories`);
     - ghi `/dev/sdX`, `/dev/nvme…`; `mkfs`, `fdisk`, `diskutil erase…`;
     - `chmod`/`chown -R` trên `/`, thư mục cấp đầu hoặc HOME.

   Đích ghi lấy từ chuyển hướng, `tee`, đích cuối của `cp`/`mv`/`install`/`ln`/`rsync`, `sed -i`, `perl -i`, `dd of=`, `curl -o`, `wget -O`, `chmod`/`chown`, `truncate`, `rm`. File nguồn (`cp ~/.bashrc backup`) và lệnh chỉ đọc không tính.
6. **Bypass** → cho chạy.
7. **Tự bảo vệ**: ghi vào `settings.json`, `keybindings.json`, `mcp.json`, `extensions/` của agent, thư mục trạng thái hoặc mã của chính extension → hỏi người dùng.
8. **Lối đi nhanh** (không gọi model):
   - `read`, `grep`, `find`, `ls` trong thư mục làm việc, `additionalDirectories`, thư mục tạm, thư mục skill đã cấu hình, tài liệu của Pi và agent dir; todo, `ask_user_question`, `web_enable`, `get_search_content`, advisor, xem tiến trình nền (`bg_status`, `bg_logs`);
   - `edit`/`write` trong thư mục làm việc, `additionalDirectories` hoặc thư mục tạm, trừ đường dẫn được bảo vệ (`.git/`, `.pi/`, `.claude/`, `.github/`, `.vscode/`, file rc của shell, `.npmrc`, `AGENTS.md`, `CLAUDE.md`…);
   - lệnh shell chứng minh được là chỉ đọc: toàn chữ thuần (không biến, `$()`, subshell, heredoc, gán biến môi trường), mọi lệnh con nằm trong danh sách đọc (`ls`, `cat`, `rg`, `git status/log/diff/show`, `gh pr view`…, `sed -n 1,20p`, `find` không `-exec/-delete`) và không có cờ ghi file (`sort -o`, `base64 -o`, `tree -o`, `yq -i`/`-s`, kể cả cụm cờ `-uoFILE` và tên dài viết tắt `--out=`), chuyển hướng chỉ tới `/dev/null`, và mọi đường dẫn nằm trong các thư mục đọc tự do ở trên;
   - `mkdir`/`touch`/`cp`/`mv` với mọi đích trong workspace (không có `cd` trong chuỗi lệnh);
   - luật `allow` hẹp. Khi ở auto mode, luật allow cho phép chạy code tùy ý bị bỏ qua (`Bash(*)`, `python *`, `node *`, `npm run *`, `bash`, `sudo`, `Agent`…), như Claude Code.
9. **Bộ phân loại** cho mọi thứ khác: đọc ngoài workspace (vd `grep` token trong `~/` — tool `grep` của Pi tìm cả file ẩn), lệnh shell còn lại, `bg_run`, `bg_kill` (dừng tiến trình nền), `fetch_content` (trừ domain trong allow), spawn `Agent`, từng lời gọi tool MCP (`mcp__<server>__<tool>`, khi bạn bật MCP dựng sẵn của Pi), sửa file ngoài workspace hoặc vào đường dẫn được bảo vệ, tool lạ.

### Git guard

Lớp chặn tất định cho lệnh git và `rm` phá huỷ (`lib/git-guard.ts`, theo `guard_git.py` của tstack, cùng bảng ca kiểm thử của bản gốc). Khác bộ phân loại, nó không đoán: luôn chặn cùng một tập lệnh, ở mọi mode, ở phiên chính và agent con, trước luật `ask`/`allow` và bộ phân loại. Chặn:

- `git push --force`/`-f` (cho phép `--force-with-lease`), `--all`, `--mirror`, `--delete`, refspec `+x` hoặc `:x`;
- push thẳng lên nhánh được bảo vệ, kể cả `git push origin HEAD`, tên nhánh tính lúc chạy (`$(git branch --show-current)`, `"$BRANCH"`) hay `git push` trơn khi đang đứng trên nhánh đó. Mặc định: `main`, `master`, `trunk`, `develop`, `production`, `prod`, `release`, `release/*`;
- bỏ qua hook: `--no-verify`, `commit -n`, `HUSKY=0`, `SKIP=...`, `-c core.hooksPath=...`, đặt `core.hooksPath` ra ngoài repo hoặc vào thư mục không có file hook;
- vứt việc: `reset --hard`, `clean -f`, `branch -D`, `checkout -f`, `switch --discard-changes`, `checkout .`/`restore .`/`rm -f .`, `stash drop/clear`, `worktree remove --force`;
- viết lại hoặc xoá lịch sử: `filter-branch`/`filter-repo`, `update-ref -d`, `reflog expire`, `gc --prune=now`;
- `rm -r` trên `/`, `~`, `$HOME`, `.`, `..`, `*`, `.git`.

Guard đọc lệnh như shell: chữ trong nháy, trong heredoc có delimiter trong nháy hoặc trong comment là dữ liệu (commit message nhắc tới `git reset --hard` vẫn qua); `$(...)`, backtick, heredoc hay `echo ... |` đưa vào `bash`/`sh` thì được kiểm như lệnh, cùng `sudo`, `env`, `timeout`, `xargs`, `flock`, `bash -c`, `eval`, hàm, vòng lặp và subshell. Tên lệnh viết khác (`g\it`, `"gi"t`, `gi''t`) hoặc lấy từ biến đã gán trong lệnh (`GIT=git; $GIT reset --hard`, `${GIT:-git}`) cũng được kiểm. Lỗi của bộ phân tích luôn cho qua. PowerShell không qua guard (cú pháp khác). Đây là dây an toàn chống tai nạn, không phải hàng rào chống người cố tình lách.

Khi bị chặn, agent nhận lý do kèm cách an toàn hơn; bạn tự chạy lệnh bằng `!<lệnh>` trong editor của Pi (lệnh `!` của người dùng không qua cổng). Lần chặn hiện trong `/permissions` với luật `git guard` và không tính vào giới hạn chặn của bộ phân loại.

Cấu hình duy nhất là `autoMode.gitGuard` trong `settings.json`: `false` hoặc `{"enabled": false}` tắt; `{"protectedBranches": ["main", "staging"]}` thay danh sách nhánh mặc định (mẫu chỉ hiểu `*` và `?`, vd `release/*`).

### Giới hạn đọc khi có deny đường dẫn

Luật `Path(...)`/`Read(...)` kiểm đường dẫn có trong lệnh, ở mọi mode:

- **Chặn khi có bằng chứng.** Đường dẫn chữ thuần khớp luật (kể cả `~user/` của chính bạn và phần đường dẫn của `<rev>:<path>`, vd `git show HEAD:.env`); glob hoặc chuyển hướng mở rộng (như bash mặc định, trên hệ file lúc gọi) ra file khớp luật; lệnh đọc nội dung cả cây (`grep -r`, `rg --hidden`/`-uu`, `diff` với thư mục, `git grep`) hoặc đóng gói/sao chép cả cây (`tar`, `zip`, `7z`, `cp -r`, `rsync`, `scp -r`; trừ đích cuối của lệnh sao chép) khi cây thật sự có file khớp luật. Mọi đường dẫn tương đối sau `cd`, `pushd`, `env -C`, `git -C`, `tar -C` được xét theo mọi thư mục có thể. Symlink được xét theo cả đích thật. Lý do chặn nêu file và luật.
- **Cho chạy khi không đọc được file bị deny.** `rg` mặc định bỏ file ẩn (`.env`) và file git bỏ qua (`.gitignore`, hỏi `git check-ignore` với đúng các file khớp luật); `find`, `tree`, `du`, `ls -R`, `rg --files` chỉ liệt kê tên; biến ở lệnh không đọc file (`echo $HOME`), phép gán `FOO=1 npm test`, wrapper `timeout`/`env`/`time` với đối số chữ thuần, heredoc.
- **Không kiểm được.** Đối số chỉ biết lúc chạy (`cat "$FILE"`, `$(...)`), brace expansion, `xargs`, `find -exec`, cờ grep/rg chưa nhận diện, danh sách file gián tiếp (`sort --files0-from`), cây quá 50.000 mục, PowerShell: auto mode giao bộ phân loại (lên thẳng giai đoạn 2, kèm ghi chú luật), manual và bypass hỏi bạn.
- **Tool của Pi.** `grep` được tìm cả thư mục; dòng thuộc file bị deny bị bỏ khỏi kết quả, kèm một dòng báo số dòng đã bỏ. `find`, `ls` chỉ trả tên. `read` vào file bị deny bị chặn.

Đây là kiểm theo argv lúc gọi tool, không phải sandbox: chương trình tùy ý (`node`, `python -c`, script) vẫn tự mở được file, và file có thể đổi sau lúc kiểm. Vì cấu hình mặc định có deny `.env`, `grep -r` ở gốc repo có `.env` sẽ bị chặn; dùng tool `grep` của Pi hoặc `rg` (bỏ file ẩn). `cat .env.example` vẫn dùng được nhờ ngoại lệ.

### Bộ phân loại

Hai giai đoạn như Claude Code: giai đoạn 1 sàng lọc nhanh và nghiêng về gắn cờ, chưa xét ủy quyền; chỉ hành động bị gắn cờ mới sang giai đoạn 2. Giai đoạn 2 là LLM có suy luận `low`, xét ngoại lệ và ý định người dùng. Chuỗi này cũng giống Codex, nơi guardian v2 cho một bộ chấm điểm nhanh cho qua phần rủi ro thấp và chỉ gọi reviewer đầy đủ khi điểm cao.

LLM mặc định là **Claude Sonnet 5.5** (`anthropic/claude-sonnet-5-5`):
- Claude Code 2.1.282 để server của Anthropic duyệt trong chính request model (model không công bố, Pi không dùng được). Khi server không duyệt, Claude Code tự gọi Sonnet 5, không theo `/model`, và dùng model của phiên khi Sonnet 5 không có.
- Codex dùng `codex-auto-review`, một model nhỏ riêng cho việc duyệt; model này không có trong catalog `openai-codex` của Pi.
- Eval 9/2026 với Sonnet 5 (chưa chạy lại với Sonnet 5.5; chạy bộ `cases.json` với model thật, không có Jev): 0/27 lệnh nguy hiểm lọt, 0/22 lệnh lành bị chặn, 36/49 sang giai đoạn 2, p50 3,9 s, p90 5,5 s; lệnh cho qua ở giai đoạn 1 mất khoảng 1,3–2,8 s.
- Request đi qua pi-anthropic-auth như request chính nên tính vào quota của gói Claude.

**Giai đoạn 1 bằng Jev** (khi đã lưu key TypeSafe):
- Jev là model System One của TypeSafe. Nó không sinh chữ: nhận một state và các câu hỏi có kiểu, trả xác suất.
- Mỗi hành động là một request. State chỉ gồm môi trường và đúng hành động đó:
  - môi trường: thư mục làm việc, thư mục tạm, remote git lúc mở phiên, các mục bạn thêm vào `autoMode.environment`;
  - hành động: lệnh, file ghi/sửa, URL hoặc tham số MCP;
  - nội dung hiện tại của script mà lệnh chạy (`python3 x.py`, `./x.sh`, tối đa 64 KB trong workspace) và lệnh của script `package.json` (`npm run deploy` → `vercel --prod`), để chấm đúng thứ sẽ chạy;
  - ghi chú khi `npx`/`bunx` chạy package đã có trong `node_modules/.bin` của project (không tải gì). Package chưa cài hoặc có ghim phiên bản thì không có ghi chú này.

  State không có tin nhắn, lời của agent hay kết quả tool.
- 17 câu hỏi có/không (noul), mỗi câu một loại rủi ro, cùng một thang mức hại 0–3 (score). Các loại rủi ro: rò rỉ dữ liệu, credential, xoá không hoàn tác, lịch sử git, chạy code tải về, cài phần mềm, production/hệ dùng chung, bỏ qua kiểm tra, làm yếu bảo mật, persistence, thay đổi hệ thống, sửa ngoài project, ghi ra dịch vụ ngoài, tự sửa quyền, đổi remote/registry, che giấu, tấn công.
- Code quyết định, không phải model (ngưỡng cố định trong `JEV_TUNING` của `lib/jev.ts`, hiệu chỉnh theo jev-1.13.0):
  - không câu nào ≥ 0,3 và P(mức hại ≥ "đáng kể") < 0,5 → cho chạy, không gọi LLM;
  - còn lại → giai đoạn 2.

  Jev không bao giờ tự chặn, vì nó không đọc tin nhắn của người dùng nên không biết lệnh có được yêu cầu hay không.
- Đi thẳng giai đoạn 2, không hỏi Jev:
  - lớp chính sách đã thấy rủi ro (`rm` vào đường dẫn quan trọng, ghi file được bảo vệ, lệnh rủi ro ở bước 5);
  - kể từ tin nhắn gần nhất của người dùng đã có kết quả tool nghi prompt injection (xem dưới).
- Phạm vi: `bash`, `bg_run`, `powershell`, đọc ngoài workspace, `write`/`edit`, `fetch_content`, lời gọi MCP. `Agent` và tool lạ vẫn qua giai đoạn 1 bằng LLM.
- Lỗi:
  - lỗi tạm thời (mạng, quá 5 giây, 429/529/5xx; thử lại một lần) → lần đó giai đoạn 1 bằng LLM; 3 lần liên tiếp thì tắt Jev tới hết phiên;
  - key bị từ chối hoặc câu trả lời sai kiểu → tắt Jev tới hết phiên và báo.

  Jev không bao giờ là đường tự cho qua khi lỗi.

**Không có key Jev** (hoặc `"jev": false`): giai đoạn 1 là LLM với cùng prompt của giai đoạn 2, không suy luận, trả lời `<block>yes|no</block>` trong vài token. Hai giai đoạn dùng chung tiền tố nên giai đoạn 2 gần như trúng cache.

- **Giai đoạn 2 chỉ thấy ý định và hành động**: tin nhắn người dùng gõ, câu trả lời `ask_user_question`, lệnh `!` người dùng tự chạy, và lệnh tool của agent. Lời của agent và mọi kết quả tool bị bỏ để agent không thuyết phục được bộ phân loại và nội dung bị chèn (prompt injection) không tới được nó. Tin nhắn do extension gửi thay, task subagent do agent cha viết và bản tóm tắt compaction được đánh dấu là không phải lời người dùng. AGENTS.md được gửi kèm như chỉ dẫn thường trực.
- **Ngữ cảnh**: thư mục làm việc, repo git và remote tại lúc mở phiên (remote thêm sau không được tin), `git status` trước lệnh xóa/reset/push.
- **Luật**: HARD (rò rỉ dữ liệu ra ngoài — không ghi đè được), 21 luật SOFT (phá lịch sử git, bỏ công việc chưa commit, xóa không hoàn tác, tài nguyên không phải của agent, chạy code tải từ mạng, deploy/hạ tầng, bỏ qua kiểm tra, làm yếu bảo mật, săn credential, lộ secret, persistence, tự sửa quyền, né bộ phân loại, publish, ghi hệ thống ngoài, đổi remote, thay đổi hệ thống, sửa ngoài project, hành động ngoài đời thực, tấn công bên thứ ba) và 11 ngoại lệ ALLOW (phát triển cục bộ, đọc mạng, dependency đã khai báo, commit/push không force lên remote của repo, tài nguyên agent tự tạo…). Luật SOFT chỉ được bỏ qua khi người dùng yêu cầu đúng thao tác và đích đó; câu hỏi, lời khuyến khích chung ("cứ làm đi") hay giá trị agent tự đoán không tính là đồng ý.
- **Lỗi thì chặn**: model lỗi, hết thời gian (`timeoutMs`, mặc định 60 giây, là hạn chung của cả lần kiểm: hai giai đoạn, một lần thử lại khi lỗi mạng/quá tải và model dự phòng; cộng tối đa khoảng 12 giây của Jev) hoặc trả lời không đọc được → lệnh không chạy, agent được báo "không phải phán quyết không an toàn, thử lại"; không tính vào giới hạn. Model giai đoạn 2 hết quota thì dùng model của phiên. Không có đường tự cho qua.

### Quét prompt injection trong kết quả tool

Đây là lớp đầu vào, theo probe prompt injection của Claude Code, chỉ chạy khi có Jev:
- Jev đọc trước khi agent thấy các kết quả mang nội dung bên ngoài: `fetch_content`, `get_search_content`, `web_search`, MCP, `Agent`/`get_subagent_result` (kết quả subagent trả về) và lệnh shell đọc mạng (`curl`, `wget`, `gh api`/`issue`/`pr`…).
- Chỉ quét kết quả dài từ 100 ký tự. Nội dung chia tối đa 8 đoạn × 3.000 ký tự; dài hơn thì giữ phần đầu và phần cuối. Mỗi đoạn là một request riêng, gửi song song: khi mọi đoạn nằm chung một request, Jev chấm cả trang nên đoạn có lệnh chèn không nổi rõ.
- Mỗi đoạn có hai câu hỏi độc lập: có lời nhắm vào AI đọc nó không (noul), và nó đang làm gì với AI (chiếm quyền / bàn luận / bình thường).
- Cả hai cùng cao (cùng ≥ 0,5) thì:
  - kết quả giữ nguyên nhưng kèm cảnh báo cho agent (coi là dữ liệu, không làm theo, cần thì hỏi người dùng);
  - người dùng được báo;
  - tới tin nhắn tiếp theo của người dùng, mọi hành động đi thẳng giai đoạn 2, và LLM được ghi chú là vừa có nội dung nghi injection.
- Bài viết giải thích prompt injection được xếp là "bàn luận" nên không bị cảnh báo. Lớp này chỉ cảnh báo, không chặn; Jev lỗi thì bỏ qua lớp này.

### Jev: key, dữ liệu gửi đi, chi phí

- **Key**: tạo ở [console.typesafe.ai](https://console.typesafe.ai), đặt biến môi trường `TYPESAFE_API_KEY` trong profile của shell, rồi mở terminal mới trước khi chạy `pi`:
  - macOS/Linux: thêm `export TYPESAFE_API_KEY="<key>"` vào `~/.zshrc` hoặc `~/.bashrc`. Windows: `setx TYPESAFE_API_KEY "<key>"`.
  - Đây là cách duy nhất tài liệu TypeSafe và SDK chính thức mô tả, và là cách phổ biến nhất trong các package Jev. Cùng biến này được pi-advisor-flow (bộ lọc Jev, mặc định tắt) đọc.
  - Đánh đổi: mọi lệnh agent chạy đều thấy biến môi trường, và key nằm dạng chữ trong file profile. Ở auto mode, lệnh in biến (`env`, `printenv`, `export -p`) phải qua bộ phân loại, và luật Secret Exposure chặn làm lộ key; ở bypass không có lớp nào chặn.
  - Key chỉ được gửi tới endpoint của TypeSafe (`https://api.typesafe.ai/v1/systemone`); không đổi được provider.
  - Kiểm tra: `pi-doctor` (in nguồn key, không in key), `/permissions` → Classifier.
- **Dữ liệu gửi cho TypeSafe**: giai đoạn 1 gửi môi trường và hành động; probe gửi nội dung kết quả tool. Secret dạng phổ biến được che trước khi gửi: token, API key, private key, mật khẩu trong URL, header `Authorization`, biến `*_TOKEN=`/`*_KEY=`.
  - Theo tài liệu của TypeSafe, họ không train trên dữ liệu khách hàng; việc lưu trữ theo Data Processing Agreement, và zero data retention chỉ có ở gói enterprise.
  - Không muốn gửi thì đặt `"jev": false`.
- **Chi phí** jev-1.13.0: $0,042 cho 1 triệu token đầu vào, đầu ra miễn phí. Một lần sàng lọc khoảng 2.400 token (≈ $0,0001). Probe khoảng 600 token cộng nội dung, tối đa khoảng 10.000 token. Đo từ một máy chủ ở Mỹ: p50 khoảng 120 ms, p90 khoảng 160–250 ms.
  - `/permissions` → Classifier hiện số lần gọi, token và chi phí của phiên chính (không gồm subagent).
  - Giới hạn hiện tại của TypeSafe là 1.200 request/phút và có thể đổi.

### Khi bị chặn

- Agent nhận lý do (`[Tên luật] câu lý do`) và chỉ dẫn: làm tiếp phần khác, chọn cách an toàn hơn, không lách bằng tool/script/lệnh mã hóa/subagent khác; nếu thật sự cần thì dừng và nói rõ cần chạy gì. Người dùng thấy thông báo `bash denied by auto mode · … · /permissions`, và lệnh vào `/permissions` → Recently denied.
- **3 lần chặn liên tiếp hoặc 20 lần trong phiên** → hỏi người dùng có cho chạy lệnh đó không (như Claude Code). Không có UI (print/JSON) thì chặn và agent chạy tiếp.

### Subagent

`@tintinweb/pi-subagents` chạy child trong cùng process, không có UI. Child tải lại pi-auto-mode (role phải liệt kê `pi-auto-mode` trong `extensions`) và:
- dùng mode của phiên gốc (manual, auto hoặc bypass); đổi mode ở phiên gốc áp dụng ngay cho child;
- bộ phân loại của child lấy tin nhắn của người dùng ở phiên gốc làm ý định, coi task và `steer_subagent` là lời của agent;
- câu hỏi (luật ask, chạm giới hạn, mọi câu hỏi của manual mode) hiện ở UI của phiên gốc, gắn nhãn `[subagent]`.

Spawn `Agent` luôn qua bộ phân loại (xét nội dung task); ở manual thì hỏi bạn. Trong auto và manual mode, agent `isolated: true`, `extensions: false` hoặc danh sách extension thiếu `pi-auto-mode` bị chặn vì child sẽ chạy không có cổng. Định nghĩa agent được đọc như pi-subagents nạp: `.pi/agents/`, `.agents/agents/` của thư mục làm việc và `agents/` của agent dir (theo thứ tự ưu tiên đó), tên agent là `name:` trong frontmatter (không có thì tên file), không phân biệt hoa thường; `isolated` của frontmatter thắng tham số của lời gọi. Liên kết cha–con dùng sự kiện `subagents:child:session-created` do bản vá runtime của pi-subagents phát.

## Cấu hình

`settings.json` của agent (settings của project không được đọc, để repo không tự nới quyền):

```json
{
  "permissions": {
    "defaultMode": "auto",
    "allow": ["web_search", "WebFetch(domain:github.com)", "Bash(npm test)"],
    "ask": ["Bash(git push *)"],
    "deny": ["Path(*.env)", "!Path(*.env.example)", "Path(~/.ssh/**)", "Bash(sudo *)"],
    "additionalDirectories": [],
    "disableBypassPermissionsMode": "disable"
  },
  "autoMode": {
    "model": "anthropic/claude-sonnet-5-5",
    "stage2Reasoning": "low",
    "timeoutMs": 60000,
    "environment": ["$defaults", "Trusted GitHub org: my-org"],
    "soft_deny": ["$defaults"],
    "hard_deny": ["$defaults"],
    "allow": ["$defaults", "Deploy Previews: deploying preview environments with vercel is fine."],
    "jev": { "model": "jev-1.13.0" },
    "log": false
  }
}
```

`autoMode.jev`: `false` (hoặc `{"enabled": false}`) tắt Jev, cả giai đoạn 1 lẫn probe; `model` ghim phiên bản, vì ngưỡng được chỉnh theo phiên bản; không dùng alias `jev-latest`. Ngưỡng (0,3/0,5 của giai đoạn 1, 0,5 của probe), thời gian chờ 5 giây và danh sách tool được probe quét là hằng số trong code (`JEV_TUNING`), không đổi bằng settings.

- Luật theo cú pháp Claude Code: `Tool` hoặc `Tool(specifier)`. `Bash(git push *)` khớp từng lệnh con (` *` ở cuối cũng khớp khi không có đối số); luật bắt đầu bằng `*` còn khớp cả chuỗi lệnh gốc. `Read(...)`/`Edit(...)`/`Write(...)` cho đường dẫn: `~/…` theo HOME, `/…` hoặc `//…` tuyệt đối, không có `/` thì so với tên file, còn lại tương đối với thư mục làm việc; `**` khớp nhiều cấp. `Path(...)` là cách riêng của pi-config cho cả đọc và ghi. Deny bắt đầu bằng `!` là ngoại lệ. `WebFetch(domain:host)` cho `fetch_content`; MCP dùng tên `mcp__server__tool`.
- Với `fetch_content`, xét mọi URL trong cả `url` và `urls`: deny/ask chỉ cần khớp một URL; auto chỉ dùng luật allow khi mọi URL đều được phủ. Ngoại lệ `!` áp dụng riêng từng URL.
- Các ô `environment`, `soft_deny`, `hard_deny`, `allow` của `autoMode` là câu chữ đưa vào prompt; `"$defaults"` chèn bộ mặc định (xem `/permissions` → Rules → Built-in classifier rules), bỏ nó đi là thay hẳn. Mỗi luật dạng `Tên: mô tả`.
- `model` và `stage2Reasoning` là model LLM của bộ phân loại và mức suy luận của giai đoạn 2 (mặc định `anthropic/claude-sonnet-5-5` / `low`). Đổi trong `/permissions` → Classifier → Change classifier model…: chọn trong các model đã đăng nhập, rồi mức thinking model hỗ trợ. Extension chỉ sửa hai khóa này trong `settings.json` (đọc-sửa-ghi dưới khóa `settings.json.lock` như Pi, ghi qua file tạm rồi đổi tên, giữ quyền file), áp ngay cho phiên và các subagent; cài lại giữ giá trị đã đổi. Hai khóa không còn thuộc `model-roles.json`/`/models`; bỏ trống `model` thì dùng model của phiên.
- `model` không dùng được thì dùng model của phiên và báo một lần: chưa đăng nhập hoặc không có trong catalog (ngay từ đầu), hay hết quota, rate limit, model bị từ chối (lúc chạy; chuyển luôn tới hết phiên như Claude Code). Model của phiên cũng lỗi thì chặn.
- `log: true` (hoặc `PI_AUTO_MODE_LOG=1`) ghi quyết định vào `<stateDir>/decisions.jsonl` (tên tool, cách quyết định, luật, lý do và điểm của Jev; không ghi input của tool). `PI_AUTO_MODE_DISABLE=1` tắt extension trong một lần chạy.
- Installer đặt luật deny cho file bí mật (`.env`, `~/.ssh`, `~/.aws`, `~/.gnupg`, `~/.kube/config`, `~/.netrc`, `~/.git-credentials`, token của `gh`/docker, `id_rsa*`, `*.pem`, auth của Pi/Claude/Codex, credential Firecrawl, backups), `sudo` và helper khóa Firecrawl. Cài lại giữ luật deny bạn đã thêm và thêm luật mới của installer, kể cả khi `settings.json` đã được Pi hoặc bạn sửa.
  - Thư mục chỉ chứa bí mật (`~/.ssh`, `~/.aws`, `~/.config/gcloud`, `~/.gnupg`, credential Firecrawl, backups) bị chặn cả chính thư mục và mọi cấp bên trong, vd `Path(~/.aws)` và `Path(~/.aws/**)`. Nhờ vậy lệnh đọc cả thư mục (`tar czf k.tgz ~/.ssh`, `cp -r ~/.aws`, `grep -r … ~/.ssh`) và file lồng nhiều cấp (token SSO trong `~/.aws/sso/cache/`) không lọt qua luật theo từng file. Đổi lại, `ls ~/.ssh` cũng bị chặn.
  - Bản cài trước dùng `~/.ssh/*`, `~/.aws/*`, `~/.config/gcloud/*` (chỉ khớp một cấp). Cài lại tự thêm các luật mới; luật mặc định cũ mà bản mới bỏ được xoá khỏi file, trừ lần cài đầu từ bản chưa lưu mặc định (`<root>/state/defaults`): khi đó luật cũ được giữ cạnh luật mới, vì deny chỉ thu hẹp quyền.
  - Luật `Bash(rm -rf *)` do bản cài cũ ghi bị bỏ khi cài lại: luật này chặn hẳn `rm -rf` (người dùng không duyệt được) nhưng để lọt `rm -fr`; bước 4 thay thế nó. Luật bạn tự thêm lại sau đó được giữ.
  - Giá trị khác trong `permissions` và `autoMode` bạn đã đổi được giữ; nếu mặc định mới cũng đổi giá trị đó, installer báo xung đột kèm mặc định mới.

## Giới hạn

- Bộ phân loại có thể sai. Claude Code công bố tỉ lệ bỏ lọt 17% trên các hành động quá đà thật (và 0,4% chặn nhầm) cho model và prompt của họ; pi-auto-mode chưa có số đo riêng. Không phải sandbox: lệnh được cho chạy có toàn quyền của người dùng. Với việc nhạy cảm, chạy Pi trong container/VM.
- Câu hỏi và ngưỡng được hiệu chỉnh với jev-1.13.0 thật (9/2026), trên hai bộ: `tests/auto-mode-eval/cases.json` và `tests/auto-mode-eval/screen-cases.json` (272 lệnh gắn nhãn theo rủi ro tự thân); test offline chỉ kiểm dữ liệu của hai bộ hợp lệ và các tình huống được luật hoặc lối đi nhanh quyết định (không gọi model) ra đúng nhãn. Gần một nửa bộ lệnh được viết sau, để kiểm độc lập; nó chỉ được dùng cho một lần sửa câu hỏi về credential.
  - Không lọt lệnh rủi ro nào: 27/27 và 141/141 bị gắn cờ. Lệnh rủi ro thấp nhất vẫn cao hơn ngưỡng khoảng 0,25.
  - Khoảng 11% lệnh thường (13/122) phải sang giai đoạn 2. Với bộ đánh giá, 7/22 hành động hợp lệ sang giai đoạn 2, trong đó 4 hành động (force-with-lease, cài công cụ, dừng tiến trình, migration) cần LLM xét ủy quyền.
  - Probe: 10/10 mẫu thật đúng. Trang hướng dẫn cho agent và bài viết về injection không bị cảnh báo; trang, issue và nội dung tiếng Việt có lệnh chèn đạt 0,94–1,00.
  - Bộ lệnh vẫn là tự viết. Hành vi thật của agent có thể khác, và khi TypeSafe ra phiên bản Jev mới, hiệu chỉnh lại trên hai bộ lệnh trước khi đổi `model` (script và harness chạy với model thật đã bỏ khỏi repo; lấy lại `scripts/auto-mode-eval.mjs` và `tests/auto-mode-eval/eval.ts` từ lịch sử git khi cần). Lỗi đáng lo là lệnh nguy hiểm được Jev cho qua; gắn cờ nhầm chỉ tốn một lần gọi giai đoạn 2.
- Jev đọc câu chữ theo nghĩa đen. Theo mục "jaggedness" của jev-1.13, nó yếu với lệnh nhiều tầng gián tiếp và với nội dung cố tình đánh lừa. Vì vậy Jev chỉ cho qua lệnh mà mọi câu hỏi rủi ro đều thấp, không tự chặn, và probe chỉ cảnh báo.
- Tiếng Anh là ngôn ngữ chính của Jev. Giai đoạn 1 không đọc tin nhắn người dùng nên không bị ảnh hưởng; probe trên nội dung không phải tiếng Anh kém chính xác hơn.
- Probe chỉ chạy khi có key Jev và chỉ với kết quả mang nội dung bên ngoài. File đọc trong workspace (kể cả repo vừa clone) không được quét. Nội dung dài hơn 24.000 ký tự chỉ được quét phần đầu và phần cuối.
- Kết quả subagent trả về được probe quét, nhưng không xét lại cả lịch sử hành động của subagent như Claude Code.
- Bước 4 chỉ nhận ra các lệnh shell ở trên. Script tự xoá thư mục (`python -c "shutil.rmtree(...)"`, `node -e`...) hoặc lệnh xoá trên máy khác (`ssh`, `docker exec`) không bị hỏi.
- Bước 5 cũng vậy:
  - chỉ thấy đích là chữ thuần, `$HOME/…` và đường dẫn tương đối sau `cd`;
  - script (`python -c`, `node -e`), công cụ tự ghi cấu hình (`husky init`, `pre-commit install`) và lệnh trên máy khác thì để bộ phân loại xét;
  - PowerShell chỉ được so theo mẫu trên chuỗi lệnh.
- Lệnh chưa chứng minh được là chỉ đọc đều tốn một lần gọi Jev (khoảng 100–250 ms) hoặc, khi không có Jev hay bị gắn cờ, một lần gọi LLM (vài trăm ms tới vài giây). Thêm luật `allow` hẹp cho lệnh hay dùng (`Bash(npm test)`, `Bash(cargo build *)`).
- Ranh giới người dùng đặt ra chỉ nằm trong transcript: compaction làm mất tin nhắn cũ thì bộ phân loại không còn thấy.

## Nguồn tham khảo

- Claude Code 2.1.280: bài "How we built Claude Code auto mode" của Anthropic, tài liệu permission modes/auto mode, và hành vi của bản cài (pipeline, giới hạn 3/20, transcript chỉ gồm tin nhắn người dùng và lệnh tool, hai giai đoạn, luật allow bị bỏ khi vào auto, cảnh báo bypass, dòng mode dưới ô nhập). Prompt và bộ luật của pi-auto-mode được viết riêng, không chép văn bản của Anthropic.
- OpenAI Codex 0.155.1 "Approve for me" (auto-review, Apache-2.0): thang rủi ro × mức ủy quyền, lỗi thì chặn, không cho model biết có reviewer nhưng dặn không lách, `/approve` duyệt một lần thử lại, và phần phụ thuộc sandbox cần thay khi không có sandbox. Guardian v2 trong mã nguồn Codex hiện tại thêm bộ chấm điểm nhanh cho qua phần rủi ro thấp và chỉ gọi reviewer đầy đủ khi điểm cao; đây là hình mẫu của chuỗi Jev → LLM.
- TypeSafe: tài liệu System One (state, noul/choice/score, confidence, "jaggedness" của jev-1.13, cookbook Guardrails for LLMs với ngưỡng review/action trong code) và API `POST /v1/systemone`. Client của pi-auto-mode viết riêng, không dùng SDK; key đọc từ biến môi trường.
- Các cách dùng Jev làm cổng permission đã công bố: cookbook "Auto-approve coding agent permission prompts with Jev" của OpenRouter, `jev-guard` (thang rủi ro, quét injection trong kết quả tool, phân biệt "bàn luận") và `pi-jev-auto-mode`. Chỉ lấy ý tưởng, không chép mã.
- Khảo sát khoảng 90 package permission của Pi. Ý tưởng lấy từ `@czottmann/pi-automode` (hành động nằm riêng, không cắt), `pi-approval-guardian` (nguồn gốc tin nhắn người dùng), `pi-permission-ai-guard` và `@erichll/pi-auto-review` (lỗi thì chặn), `one-code-extension` (bằng chứng tất định trước khi hỏi model). Không chép mã.
