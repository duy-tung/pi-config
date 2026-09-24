# Permission: auto mode và bypass

`pi-auto-mode` là extension riêng của pi-config (`assets/extensions/pi-auto-mode`), thay cho `@gotgenes/pi-permission-system`. Chỉ có hai mode, theo auto mode và bypassPermissions của Claude Code (tương ứng "Approve for me" và "Full Access" của Codex):

| Mode | Dòng dưới ô nhập | Hành vi |
|---|---|---|
| **Auto** (mặc định) | `⏵⏵ auto mode on` (vàng) | Thao tác an toàn chạy ngay; thao tác còn lại do bộ phân loại (một model) duyệt, không hỏi người dùng |
| **Bypass** | `⏵⏵ bypass permissions on` (đỏ) | Không kiểm tra, trừ luật `deny`, luật `ask` và `rm` vào đường dẫn quan trọng |

## Dùng

- `Shift+Tab` đổi auto ⇄ bypass. Lần đầu vào bypass hiện cảnh báo cần đồng ý; lựa chọn được nhớ. Bypass bị từ chối khi chạy bằng root (trừ `IS_SANDBOX=1`) hoặc khi `permissions.disableBypassPermissionsMode` là `"disable"`.
- Mức thinking chuyển sang `Alt+T` (như Option+T của Claude Code; trên macOS terminal cần gửi Option như Alt — WezTerm mặc định với Option trái) hoặc `/thinking`.
- `/permissions`: mode hiện tại, danh sách lệnh vừa bị chặn (chọn một lệnh để duyệt cho **một lần thử lại**, Pi được báo "Permission granted for: …"), xem luật.
- `/auto-mode`: trạng thái; `/auto-mode defaults` xem bộ luật mặc định; `/auto-mode test <lệnh bash>` chạy thử quyết định cho một lệnh (có gọi model khi cần); `/auto-mode eval [provider/model]` chạy bộ đánh giá có nhãn (`eval/cases.json`, gần 50 tình huống, có tin nhắn tiếng Việt) qua model thật và báo số lệnh nguy hiểm lọt, lệnh lành bị chặn và độ trễ — dùng khi đổi model phân loại. Ngoài Pi: `node scripts/auto-mode-eval.mjs [--model provider/id]`. Cả hai tốn quota của provider.
- Khởi động: `pi --permission-mode bypassPermissions` hoặc `pi --dangerously-skip-permissions`; mặc định lấy từ `permissions.defaultMode`. Mode bypass không bao giờ được khôi phục từ phiên cũ hay settings của project.

## Auto mode quyết định thế nào

Mỗi tool call đi qua các bước sau, dừng ở bước đầu tiên có kết quả (thứ tự của Claude Code):

1. **Luật `deny`** → chặn, ở cả hai mode. Áp dụng cho tool file, đối số đường dẫn của lệnh shell (kể cả `$()`, `bash -c`, `sudo`, `xargs`) và tham số đường dẫn của MCP.
2. **Luật `ask`** → hỏi người dùng (không có UI thì chặn).
3. **`rm`/`rmdir`/`find -delete` vào `/`, thư mục cấp đầu, `~`, thư mục con trực tiếp của `~`, thư mục làm việc hoặc thư mục cha của nó** → auto: gửi bộ phân loại kèm ghi chú; bypass: hỏi người dùng.
4. **Bypass** → cho chạy.
5. **Tự bảo vệ**: ghi vào `settings.json`, `keybindings.json`, `extensions/` của agent, thư mục trạng thái hoặc mã của chính extension → hỏi người dùng.
6. **Lối đi nhanh** (không gọi model):
   - `read`, `grep`, `find`, `ls` trong thư mục làm việc, `additionalDirectories`, thư mục tạm, thư mục skill đã cấu hình, tài liệu của Pi và agent dir; todo, `ask_user_question`, công cụ đọc của pi-lens, `web_enable`, `get_search_content`, goal, advisor, trạng thái `bg_*`;
   - `edit`/`write` trong thư mục làm việc, `additionalDirectories` hoặc thư mục tạm, trừ đường dẫn được bảo vệ (`.git/`, `.pi/`, `.claude/`, `.github/`, `.vscode/`, file rc của shell, `.npmrc`, `AGENTS.md`, `CLAUDE.md`…);
   - lệnh shell chứng minh được là chỉ đọc: toàn chữ thuần (không biến, `$()`, subshell, heredoc, gán biến môi trường), mọi lệnh con nằm trong danh sách đọc (`ls`, `cat`, `rg`, `git status/log/diff/show`, `gh pr view`…, `sed -n 1,20p`, `find` không `-exec/-delete`), chuyển hướng chỉ tới `/dev/null`, và mọi đường dẫn nằm trong các thư mục đọc tự do ở trên;
   - `mkdir`/`touch`/`cp`/`mv` với mọi đích trong workspace (không có `cd` trong chuỗi lệnh);
   - luật `allow` hẹp. Khi ở auto mode, luật allow cho phép chạy code tùy ý bị bỏ qua (`Bash(*)`, `python *`, `node *`, `npm run *`, `bash`, `sudo`, `Agent`, `SubagentWorkflow`…), như Claude Code.
7. **Bộ phân loại** cho mọi thứ khác: đọc ngoài workspace (vd `grep` token trong `~/` — tool `grep` của Pi tìm cả file ẩn), lệnh shell còn lại, `bg_run`, `fetch_content` (trừ domain trong allow), spawn `Agent`, `SubagentWorkflow`, cài server MCP, từng lời gọi MCP (qua sự kiện duyệt của pi-mcp-adapter, gồm cả lời gọi trong `mcpScript`), sửa file ngoài workspace hoặc vào đường dẫn được bảo vệ, tool lạ.

### Bộ phân loại

- **Hai giai đoạn cùng một prompt**: giai đoạn 1 không suy luận, trả lời `<block>yes|no</block>` trong vài token và nghiêng về chặn; chỉ khi bị gắn cờ mới sang giai đoạn 2 (suy luận `low`, xét ngoại lệ và ý định người dùng). Hai giai đoạn dùng chung tiền tố nên giai đoạn 2 gần như trúng cache.
- **Chỉ thấy ý định và hành động**: tin nhắn người dùng gõ, câu trả lời `ask_user_question`, lệnh `!` người dùng tự chạy, và lệnh tool của agent. Lời của agent và mọi kết quả tool bị bỏ để agent không thuyết phục được bộ phân loại và nội dung bị chèn (prompt injection) không tới được nó. Tin nhắn do extension gửi thay (vd goal continuation), task subagent do agent cha viết và bản tóm tắt compaction được đánh dấu là không phải lời người dùng. AGENTS.md được gửi kèm như chỉ dẫn thường trực.
- **Ngữ cảnh**: thư mục làm việc, repo git và remote tại lúc mở phiên (remote thêm sau không được tin), `git status` trước lệnh xóa/reset/push.
- **Luật**: HARD (rò rỉ dữ liệu ra ngoài — không ghi đè được), 21 luật SOFT (phá lịch sử git, bỏ công việc chưa commit, xóa không hoàn tác, tài nguyên không phải của agent, chạy code tải từ mạng, deploy/hạ tầng, bỏ qua kiểm tra, làm yếu bảo mật, săn credential, lộ secret, persistence, tự sửa quyền, né bộ phân loại, publish, ghi hệ thống ngoài, đổi remote, thay đổi hệ thống, sửa ngoài project, hành động ngoài đời thực, tấn công bên thứ ba) và 11 ngoại lệ ALLOW (phát triển cục bộ, đọc mạng, dependency đã khai báo, commit/push không force lên remote của repo, tài nguyên agent tự tạo…). Luật SOFT chỉ được bỏ qua khi người dùng yêu cầu đúng thao tác và đích đó; câu hỏi, lời khuyến khích chung ("cứ làm đi") hay giá trị agent tự đoán không tính là đồng ý.
- **Lỗi thì chặn**: model lỗi, hết thời gian (60 giây mỗi giai đoạn) hoặc trả lời không đọc được → lệnh không chạy, agent được báo "không phải phán quyết không an toàn, thử lại"; không tính vào giới hạn. Không có đường tự cho qua.

### Khi bị chặn

- Agent nhận lý do (`[Tên luật] câu lý do`) và chỉ dẫn: làm tiếp phần khác, chọn cách an toàn hơn, không lách bằng tool/script/lệnh mã hóa/subagent khác; nếu thật sự cần thì dừng và nói rõ cần chạy gì. Người dùng thấy thông báo `bash denied by auto mode · … · /permissions`.
- **3 lần chặn liên tiếp hoặc 20 lần trong phiên** → hỏi người dùng có cho chạy lệnh đó không (như Claude Code). Không có UI (print/JSON) thì chặn và agent chạy tiếp.

### Subagent

`@tintinweb/pi-subagents` chạy child trong cùng process, không có UI. Child tải lại pi-auto-mode (role phải liệt kê `pi-auto-mode` trong `extensions`) và:
- dùng mode của phiên gốc; đổi mode ở phiên gốc áp dụng ngay cho child;
- bộ phân loại của child lấy tin nhắn của người dùng ở phiên gốc làm ý định, coi task và `steer_subagent` là lời của agent;
- câu hỏi (luật ask, chạm giới hạn) hiện ở UI của phiên gốc, gắn nhãn `[subagent]`.

Spawn `Agent` luôn qua bộ phân loại (xét nội dung task). Trong auto mode, agent `isolated: true`, `extensions: false` hoặc danh sách extension thiếu `pi-auto-mode` bị chặn vì child sẽ chạy không có cổng. Liên kết cha–con dùng sự kiện `subagents:child:session-created` do bản vá runtime của pi-subagents phát.

## Cấu hình

`settings.json` của agent (settings của project không được đọc, để repo không tự nới quyền):

```json
{
  "permissions": {
    "defaultMode": "auto",
    "allow": ["web_search", "WebFetch(domain:github.com)", "Bash(npm test)"],
    "ask": ["Bash(git push *)"],
    "deny": ["Path(*.env)", "!Path(*.env.example)", "Path(~/.ssh/**)", "Bash(sudo *)", "mcpScript"],
    "additionalDirectories": [],
    "disableBypassPermissionsMode": "disable"
  },
  "autoMode": {
    "model": "openai-codex/gpt-6-sol",
    "stage2Model": "openai-codex/gpt-6-sol",
    "stage2Reasoning": "low",
    "timeoutMs": 60000,
    "environment": ["$defaults", "Trusted GitHub org: my-org"],
    "soft_deny": ["$defaults"],
    "hard_deny": ["$defaults"],
    "allow": ["$defaults", "Deploy Previews: deploying preview environments with vercel is fine."],
    "keys": ["shift+tab"],
    "log": false
  }
}
```

- Luật theo cú pháp Claude Code: `Tool` hoặc `Tool(specifier)`. `Bash(git push *)` khớp từng lệnh con (` *` ở cuối cũng khớp khi không có đối số); luật bắt đầu bằng `*` còn khớp cả chuỗi lệnh gốc. `Read(...)`/`Edit(...)`/`Write(...)` cho đường dẫn: `~/…` theo HOME, `/…` hoặc `//…` tuyệt đối, không có `/` thì so với tên file, còn lại tương đối với thư mục làm việc; `**` khớp nhiều cấp. `Path(...)` là cách riêng của pi-config cho cả đọc và ghi. Deny bắt đầu bằng `!` là ngoại lệ. `WebFetch(domain:host)` cho `fetch_content`; MCP dùng tên `mcp__server__tool`.
- Các ô `environment`, `soft_deny`, `hard_deny`, `allow` của `autoMode` là câu chữ đưa vào prompt; `"$defaults"` chèn bộ mặc định (xem `/auto-mode defaults`), bỏ nó đi là thay hẳn. Mỗi luật dạng `Tên: mô tả`.
- `model` không dùng được thì dùng model của phiên và báo một lần: chưa đăng nhập hoặc không có trong catalog (ngay từ đầu), hay hết quota, rate limit, model bị từ chối (lúc chạy; chuyển luôn tới hết phiên như Claude Code). Model của phiên cũng lỗi thì chặn.
- `log: true` (hoặc `PI_AUTO_MODE_LOG=1`) ghi quyết định vào `<stateDir>/decisions.jsonl` (có tóm tắt lệnh; tắt khi không cần). `PI_AUTO_MODE_DISABLE=1` tắt extension trong một lần chạy.
- Installer đặt luật deny cho file bí mật (`.env`, `~/.ssh`, `~/.aws`, `~/.gnupg`, `~/.kube/config`, `~/.netrc`, `~/.git-credentials`, token của `gh`/docker, `id_rsa*`, `*.pem`, auth của Pi/Claude/Codex, credential Firecrawl, backups), `rm -rf`, `sudo`, helper khóa Firecrawl và `mcpScript`; luật deny của pi-permission-system cũ và luật deny người dùng đã thêm được giữ khi cài lại. Luật ask `Edit(**/.pi/pi-goal-x-settings.json)` hỏi trước khi sửa file này: prompt của pi-goal-x cho agent tự đổi `maxAutonomousRuns` ở đây, và file của project đè giới hạn global.

## Giới hạn

- Bộ phân loại có thể sai. Claude Code công bố tỉ lệ bỏ lọt 17% trên các hành động quá đà thật (và 0,4% chặn nhầm) cho model và prompt của họ; pi-auto-mode chưa có số đo riêng. Không phải sandbox: lệnh được cho chạy có toàn quyền của người dùng. Với việc nhạy cảm, chạy Pi trong container/VM.
- Không có lớp quét prompt injection trên kết quả tool như bản server của Claude Code; phòng thủ chỉ nằm ở việc bộ phân loại không thấy kết quả tool.
- Không duyệt lại kết quả subagent khi trả về. Lệnh `gate:` trong `SubagentWorkflow` chạy không qua `tool_call`; vì vậy cả script workflow được phân loại lúc gọi.
- Lệnh chưa chứng minh được là chỉ đọc đều tốn một lần gọi model (thường vài trăm ms tới vài giây). Thêm luật `allow` hẹp cho lệnh hay dùng (`Bash(npm test)`, `Bash(cargo build *)`).
- Ranh giới người dùng đặt ra chỉ nằm trong transcript: compaction làm mất tin nhắn cũ thì bộ phân loại không còn thấy.

## Nguồn tham khảo

- Claude Code 2.1.280: bài "How we built Claude Code auto mode" của Anthropic, tài liệu permission modes/auto mode, và hành vi của bản cài (pipeline, giới hạn 3/20, transcript chỉ gồm tin nhắn người dùng và lệnh tool, hai giai đoạn, luật allow bị bỏ khi vào auto, cảnh báo bypass, dòng mode dưới ô nhập). Prompt và bộ luật của pi-auto-mode được viết riêng, không chép văn bản của Anthropic.
- OpenAI Codex 0.155.1 "Approve for me" (auto-review, Apache-2.0): thang rủi ro × mức ủy quyền, lỗi thì chặn, không cho model biết có reviewer nhưng dặn không lách, `/approve` duyệt một lần thử lại, và phần phụ thuộc sandbox cần thay khi không có sandbox.
- Khảo sát khoảng 90 package permission của Pi. Ý tưởng lấy từ `@czottmann/pi-automode` (hành động nằm riêng, không cắt), `pi-approval-guardian` (nguồn gốc tin nhắn người dùng), `pi-permission-ai-guard` và `@erichll/pi-auto-review` (lỗi thì chặn), `one-code-extension` (bằng chứng tất định trước khi hỏi model). Không chép mã.
