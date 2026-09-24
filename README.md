# pi-config

[![Kiểm thử cài đặt](https://github.com/duy-tung/pi-config/actions/workflows/test.yml/badge.svg)](https://github.com/duy-tung/pi-config/actions/workflows/test.yml)

Bộ cài **Pi 0.87.1** cho **macOS, Linux và Windows**: model theo vai trò, context riêng cho agent, native web search theo model (Codex, Claude) với Exa và Firecrawl dự phòng, quota Claude trong footer, permission kiểu Claude Code (auto mode và bypass) và giao diện Rosé Pine. Dependency, nguồn skills và bản vá được ghim để tái lập cấu hình.

## Cài đặt

macOS / Linux:

```sh
curl -fsSL https://raw.githubusercontent.com/duy-tung/pi-config/main/install.sh | bash
```

Windows PowerShell 5.1 trở lên:

```powershell
& ([scriptblock]::Create((Invoke-RestMethod 'https://raw.githubusercontent.com/duy-tung/pi-config/main/install.ps1').TrimStart([char]0xFEFF)))
```

Bootstrap chuẩn bị Node **24.15.0** theo user và Git Bash trên Windows khi cần, kiểm SHA256 rồi chạy installer. Mở terminal mới và chạy `pi`. Không cần đăng nhập GitHub hoặc quyền quản trị để cài.

Chi tiết kiến trúc CPU, công cụ hệ thống và tùy chọn đường dẫn: [docs/platforms.md](docs/platforms.md). Có thể xem [install.sh](install.sh), [install.ps1](install.ps1) và [install.mjs](install.mjs) trước khi chạy.

## Đăng nhập dịch vụ

1. Chạy `pi-login`, dùng `/login` và chọn **Anthropic** cho parent Claude Opus 5.5 (gói Pro/Max), hoặc đặt `ANTHROPIC_API_KEY`. Xem [docs/claude.md](docs/claude.md).
2. Trong `/login`, chọn **OpenAI Codex** cho worker/debugger (GPT-6 Sol), reviewer (GPT-6 Astra) và bộ phân loại của auto mode.
3. Trong `/login`, chọn **OpenCode Go** và nhập API key cho GLM. Pi cũng nhận biến môi trường `OPENCODE_API_KEY`.
4. Chạy `firecrawl login --browser` để đăng nhập dịch vụ web.
5. Tuỳ chọn: tạo API key TypeSafe tại [console.typesafe.ai](https://console.typesafe.ai) rồi chạy `pi-mcp-adapter key set systemone` (nhập ẩn, lưu vào keyring của hệ điều hành) để auto mode sàng lọc bằng Jev. Chưa có key thì bộ phân loại LLM làm cả hai giai đoạn như trước.

Một cấu hình Pi dùng auth của agent directory. Firecrawl dùng credential store của CLI theo hệ điều hành. Repo không chứa credential, token hay dữ liệu phiên của người dùng; không nhập key vào chat hoặc commit vào Git.

## Một phiên Pi, các slash command

Chạy `pi` để mở Claude Opus 5.5/high với toàn bộ công cụ. Các workflow được điều khiển trong cùng phiên:

| Công việc | Lệnh |
|---|---|
| Goal dài hạn | `/goal`, `/goal-status`, `/goal-pause`, `/goal-resume` |
| Shell job nền | `/bg --name "Dev server" npm run dev`, `/jobs`, `/logs`, `/kill` |
| Ý kiến cố vấn | `/advisor-manual`, `/advisor-settings`, `/advisor-off`, `/advisor` |
| Rewind code/hội thoại | `Esc Esc`, `/rewind` (`/checkpoint`, `/undo`), `/redo`; `/clear` mở phiên mới |
| Permission | `Shift+Tab` (auto ⇄ bypass), `/permissions`, `/auto-mode` |
| Model và reasoning | `/model`, `/thinking`, `Alt+T` đổi mức thinking |
| Công cụ và giao diện | `/agents`, `/usage`, `/claude-usage`, `/mcp`, `/lens-health`, `/open-tui` |

Advisor (pi-advisor-flow) luôn bật khi mở phiên: executor là Opus/high của phiên, advisor là GPT-6 Astra/high.
- System prompt dặn Opus gọi `ask_advisor` sau hai lần thử tương đương cùng thất bại và trước khi báo xong việc không nhỏ. Tối đa 5 lần mỗi phiên; không có gate cứng chặn phiên.
- Advisor không có tool. Nó thấy tối đa 60.000 ký tự gồm hội thoại gần nhất và diff chưa commit (diff tối đa 20.000 ký tự, đã che secret). Thay đổi lớn vẫn nên giao reviewer.
- Bản vá giữ system prompt không đổi sau mỗi lần hỏi, để Opus không mất prompt cache.
- `/advisor-off` tắt hẳn, kể cả các phiên sau (bản vá: Pi tự bật mọi tool của extension khi mở phiên, nên advisor chỉ bật khi Always on kích hoạt được); bật lại ở `/advisor-settings` → Always on. Khi advisor đang bật, `/model` lưu model mới làm executor vào `advisor.json`, nên lần cài lại installer sẽ báo file này đã sửa.
- Mở phiên khi chưa đăng nhập Claude hoặc Codex thì Pi báo `Advisor models are not configured or available` và phiên chạy không có advisor; đăng nhập rồi chạy `/advisor`.

Goal chỉ bắt đầu khi được yêu cầu. Mỗi lần tạo hoặc resume có tối đa 10 lượt tự tiếp tục do goal extension khởi động; giới hạn này không tính các tool call trong một lượt hay request do extension khác khởi động.
- Khi agent báo hoàn thành, auditor GPT-6 Astra/high kiểm tra độc lập trong phiên riêng (đọc file, chạy lệnh). Không duyệt thì goal vẫn mở kèm phản hồi. Tắt audit cho goal đang chọn bằng `Ctrl+Shift+A` hoặc trong hộp xác nhận goal.
- Lệnh của auditor qua cổng permission như subagent (bản vá pi-goal-x): theo mode của phiên chính, câu hỏi hiện ở UI phiên chính.
- Khi agent sắp chuyển goal sang blocked, Oracle Astra/high (chỉ đọc) được hỏi một lần cho mỗi vướng mắc.

Background cung cấp shell jobs; completion chỉ thông báo, không tự mở lượt model theo mặc định. Mô tả `bg_run` dặn model đặt `triggerOnCompletion:true` khi bước sau cần kết quả của job (test, build phải xem trước khi làm tiếp): job xong sẽ mở lượt mới, nên model kết thúc lượt thay vì chờ hay hỏi trạng thái liên tục. Dev server và watcher giữ mặc định. Model delegation dùng `Agent`.

Rewind (`pi-rewind`, extension của repo) theo giao diện `/rewind` của Claude Code: mỗi prompt có checkpoint; `Esc Esc` hoặc `/rewind` mở danh sách prompt kèm số dòng đã đổi, rồi chọn khôi phục code, hội thoại, cả hai, hoặc tóm tắt từ/đến prompt đó. File do `edit`/`write` sửa luôn được theo dõi; file do `bash`/`Agent` sửa được theo dõi trong git worktree. Mục Redo trong menu (hoặc `/redo`) hoàn tác lần rewind gần nhất. `/clear` mở phiên mới như `/new`, và menu của phiên mới có mục quay lại phiên cũ. Nếu Pi thoát giữa lúc khôi phục code, menu cho hoàn tất hoặc hoàn tác lần khôi phục đó. Chi tiết và giới hạn: [docs/rewind.md](docs/rewind.md).

Permission (`pi-auto-mode`, extension của repo) có hai mode như Claude Code. **Auto** là mặc định: thao tác đọc, lệnh chỉ đọc và sửa file trong project chạy ngay; lệnh khác qua bộ phân loại hai giai đoạn.
- Giai đoạn 1 là **Jev**, model System One của TypeSafe, khi có key. Jev không sinh chữ: mỗi lệnh là một request trả xác suất cho 17 loại rủi ro và một thang mức hại, code so với ngưỡng. Lệnh thường chạy luôn, không gọi LLM.
- Giai đoạn 2 là `gpt-6-sol` có suy luận, chỉ xét lệnh bị gắn cờ và chỉ thấy tin nhắn của người dùng cùng lệnh của agent.
- Jev cũng quét kết quả web, MCP và subagent để tìm prompt injection và cảnh báo agent.
- Lệnh bị chặn trả lý do cho agent để đi đường an toàn hơn; 3 lần chặn liên tiếp hoặc 20 lần trong phiên thì hỏi người dùng.

**Bypass** chạy mọi thứ trừ luật deny và `rm` vào đường dẫn quan trọng. `Shift+Tab` đổi mode, `/permissions` xem và duyệt lại lệnh bị chặn, `/auto-mode` xem trạng thái và chi phí Jev. Chi tiết: [docs/auto-mode.md](docs/auto-mode.md).

Opus 5.5 và GLM dùng context **1M** của catalog; Astra/Sol nâng lên **872K**. Theme mặc định Rosé Pine Moon, có thêm Rosé Pine và Dawn.

## Agent

Pi dùng `Agent` của **@tintinweb/pi-subagents**:

| Role | Model/effort | Phạm vi |
|---|---|---|
| `researcher` | GLM-5.3-Flash/max | Khảo sát code/docs/log, thu thập bằng chứng; chỉ đọc |
| `worker` | GPT-6 Sol/max | Triển khai và kiểm thử phần việc đã chốt |
| `debugger` | GPT-6 Sol/max | Tái hiện lỗi, tìm nguyên nhân, sửa và kiểm hồi quy |
| `reviewer` | GPT-6 Astra/high | Review độc lập; chỉ đọc |

Parent Claude Opus 5.5/high giữ thiết kế, quyết định quan trọng và nghiệm thu cuối. GLM chạy trực tiếp qua OpenCode Go trong Pi.

```text
@researcher Tìm luồng xử lý timeout và báo file/dòng.
@worker Triển khai phần đã chốt, chạy kiểm thử liên quan.
@debugger Tái hiện lỗi và sửa với regression test.
@reviewer Review diff, nêu lỗi có bằng chứng.
```

Agent có context riêng và không giới hạn số lượt; dừng agent bằng `/agents` → chọn agent → `x` hai lần. Researcher/reviewer chạy nền theo mặc định (tối đa 4 cùng lúc); worker/debugger luôn chạy foreground (tối đa 2); vượt giới hạn thì xếp hàng. Parent điều phối để tránh ghi chồng file. Chi tiết cấu hình, quyền và vòng đời: [docs/subagents.md](docs/subagents.md).

## Công cụ và mặc định

- Web: `web_search` dùng native search của model hiện tại: provider `openai` cho Codex/OpenAI (Astra, Sol), `anthropic` cho Claude (bản vá pi-web-access); model khác (GLM) dùng Exa (endpoint MCP miễn phí, không cần key) rồi Firecrawl; lỗi mạng, quota, phản hồi hỏng chuyển sang provider kế tiếp. `fetch_content`, `get_search_content` dùng Firecrawl và kho kết quả. Phiên mới hiện `web_enable` để model bật web tools. CLI và skills hỗ trợ workflow bổ sung. Chi tiết: [docs/claude.md](docs/claude.md).
- MCP filesystem: công cụ đọc trong workspace, kết nối khi cần. `mcp.json` đặt `allowInstall: false`: agent không tự cài thêm server MCP.
- Code intelligence: pi-lens, TypeScript language server cài sẵn; Go/Rust/Python dùng language server của máy hoặc project.
- Native compaction bật: reserve 16.384, giữ gần nhất 20.000 token.
- Cache warming tắt. Advisor, goal auditor và Oracle bật như mô tả ở trên. Jev của auto mode chỉ chạy khi bạn đã lưu key TypeSafe (tính theo token đầu vào, khoảng $0,0001 mỗi lần sàng lọc). Goal và background follow-up chỉ chạy theo thao tác/cấu hình đã chọn.
- Codex fast mode bật mặc định (`codexFastMode:true`): request của worker/debugger GPT-6 Sol đi hàng `priority`, nhanh hơn và tốn quota Codex nhiều hơn (Pi tính chi phí gấp đôi). GPT-6 Astra chưa hỗ trợ fast. Tắt bằng `/fast`; footer hiện `fast` khi phiên đang dùng model Codex có fast.
- Header/footer/editor do pi-open-tui quản lý. Footer hiển thị model, thinking, quota (Codex qua pi-usage; Claude đọc từ header phản hồi, chi tiết bằng `/claude-usage`), context % kèm token/cửa sổ, token/cost và trạng thái công cụ liên quan. Palette terminal theo theme của phiên và được phục hồi khi thoát.
- Dán ảnh: `@pi-archimedes/image-paste`, dùng **Ctrl+V** trên macOS/Linux hoặc **Alt+V** trên Windows. Copy ảnh vào clipboard, dán để có marker `[Image #1]`, rồi gửi cùng prompt. Xóa marker để bỏ ảnh; giới hạn 20 MiB/ảnh. Preview chỉ hiện trong UI, ảnh được gửi tới model đúng một lần. Phím dán ảnh tích hợp của Pi được tắt trong `keybindings.json` để tránh xử lý trùng.
- Clipboard native `@mariozechner/clipboard` được ghim và cài bên cạnh extension. Linux cần desktop X11/Wayland; `wl-clipboard`/`xclip` là các reader thay thế. Terminal không hỗ trợ ảnh inline vẫn gửi được ảnh, chỉ thiếu preview. Chỉ nạp image-paste; phần giao diện của bộ Archimedes không được nạp.

`pi-models` xem cấu hình model. `pi-doctor` kiểm dependency và checksum bản vá, in model của role, advisor, goal auditor và hai giai đoạn của auto mode (kèm nguồn key Jev, không in key). `pi-mcp-adapter key set|status|remove systemone` quản lý key Jev. `pi-test` kiểm workflow và Agent bằng provider giả trong thư mục tạm, không gọi model trả phí.

Auto mode là lớp duyệt bằng model, không thay thế sandbox hệ điều hành: bộ phân loại có thể sai. Luật `permissions.deny` (file bí mật, `sudo`...) áp dụng ở cả hai mode; bypass vẫn hỏi trước lệnh xoá đệ quy ra ngoài thư mục tạm (`rm -fr`, `find -delete`, `git clean`...). Project cần được trust trước khi dùng cấu hình của project; settings của project không bật được bypass hay thêm luật allow. Nguồn web là dữ liệu để tham khảo, không phải instruction.

## Phiên bản

| Thành phần | Phiên bản |
|---|---|
| `@tintinweb/pi-subagents` | 0.19.0 |
| `@gotgenes/pi-anthropic-auth` | 3.2.2 |
| `pi-mcp-adapter` | 2.37.0 |
| `pi-web-access` | 0.31.0 |
| `@juicesharp/rpiv-ask-user-question`, `rpiv-todo` | 2.11.0 |
| `@narumitw/pi-usage` | 0.61.0 |
| `pi-lens` | 4.2.1 |
| `pi-background-tasks` | 2.6.5 |
| `pi-goal-x` | 0.31.8 |
| `pi-advisor-flow` | 0.8.1 |
| `pi-open-tui` | 0.3.8 |
| `@pi-archimedes/image-paste` | 2.8.0 |
| `@mariozechner/clipboard` | 0.3.9 |
| Firecrawl CLI | 1.24.4 |
| Engineering và Firecrawl skills | Commit trong [sources.lock.json](sources.lock.json) |

Các manifest và lockfile nằm trong [manifests](manifests). Hai package có peer range chưa gồm Pi 0.87.1 (pi-lens, pi-background-tasks) được đóng gói lại, chỉ bổ sung đúng phiên bản này vào metadata; source/integrity upstream và SHA256 tarball nằm trong manifest. Đây là cấu hình tương thích được kiểm thử bởi pi-config, không phải tuyên bố hỗ trợ của upstream. Bản vá tương thích có source hash, kết quả hash và điều kiện phiên bản tại [assets/patches.json](assets/patches.json).

## Quản lý cấu hình

Mặc định: runtime ở `~/.local/share/pi-platform`, main agent ở `~/.pi/agent`, launcher ở `~/.local/bin`. Windows dùng các thư mục tương ứng trong user profile.

Installer chỉ quản lý bản cài có `install-state.json` phù hợp. Với root đã có dữ liệu khác, dùng đường dẫn riêng:

```sh
node install.mjs --root /duong-dan/platform --agent-dir /duong-dan/agent --bin-dir /duong-dan/bin --no-path
```

Role, subagents, goal settings, advisor settings và cấu hình công cụ cùng nằm trong agent directory. Một runtime Pi duy nhất ở `runtimes/current`; Firecrawl CLI ở `tools/firecrawl`.

Khi chạy lại, installer dùng lockfile và checksum để kiểm tính nhất quán; runtime được cài lại khi lockfile hoặc kết quả bản vá đổi, để bản vá luôn áp lên file gốc. File đã tùy chỉnh được giữ và báo đường dẫn. Tài nguyên do installer quản lý, không còn được yêu cầu và chưa chỉnh sửa, được lưu vào backup; tài nguyên còn được cấu hình tham chiếu được giữ. Các loại trừ extension và luật `permissions.deny` được bảo toàn; luật deny của pi-permission-system cũ được chuyển sang. Auth và file riêng của người dùng không thuộc danh sách tài nguyên được dọn.

Dừng các phiên Pi trước khi cập nhật. Dùng revision đã qua CI thay vì chạy `pi update` hoặc `npm update` trên runtime ghim. Nếu còn `.install.lock`, kiểm tra PID và chỉ xóa lock khi tiến trình đó đã dừng.

## Phát triển và kiểm thử

```sh
npm run check
npm test
npm run smoke
```

CI chạy trên Ubuntu, Windows và macOS: kiểm repo, cấu hình, request payload, cài sạch, các slash workflow và Agent trong cùng phiên bằng provider giả, cài lại giữ tùy chỉnh và bootstrap với đường dẫn có khoảng trắng. Test không dùng credential thật hoặc gọi model trả phí. Đây là kiểm chứng runtime và bộ cài; chất lượng model và quyền truy cập tài khoản được đánh giá riêng.

Nguồn và giấy phép: [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md). Mã riêng của dự án dùng [MIT](LICENSE).
