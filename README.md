# pi-config

[![Kiểm thử cài đặt](https://github.com/duy-tung/pi-config/actions/workflows/test.yml/badge.svg)](https://github.com/duy-tung/pi-config/actions/workflows/test.yml)

Bộ cài **Pi 0.99.2** cho **macOS, Linux và Windows**: model theo vai trò, context riêng cho agent, native web search theo model (Codex, Claude) với Exa và Firecrawl dự phòng, quota Claude trong footer, permission kiểu Claude Code (auto mode và bypass, kèm git guard) và giao diện Rosé Pine. Đi kèm bộ skill quy trình **tstack** (grill → spec → tickets → implement → prove → review → ship, chạy không giám sát bằng goal) đã chuyển sang Pi: [docs/workflow.md](docs/workflow.md). Dependency, nguồn skills và bản vá được ghim để tái lập cấu hình.

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

Hai lệnh trên lấy bản mới nhất của nhánh `main`. Để cài đúng một bản đã kiểm chứng, thay `main` trong URL bằng commit đó và đặt `PI_CONFIG_REF` cùng commit, vd `curl -fsSL https://raw.githubusercontent.com/duy-tung/pi-config/<commit>/install.sh | PI_CONFIG_REF=<commit> bash` ([platforms.md](docs/platforms.md)).

Chi tiết kiến trúc CPU, công cụ hệ thống và tùy chọn đường dẫn: [docs/platforms.md](docs/platforms.md). Có thể xem [install.sh](install.sh), [install.ps1](install.ps1) và [install.mjs](install.mjs) trước khi chạy.

## Đăng nhập dịch vụ

1. Chạy `pi`, dùng `/login` và chọn **Anthropic** cho parent Claude Opus 5.5 (gói Pro/Max) và bộ phân loại của auto mode (Claude Sonnet 5), hoặc đặt `ANTHROPIC_API_KEY`. Xem [docs/claude-setup.md](docs/claude-setup.md).
2. Trong `/login`, chọn **OpenAI Codex (legacy)** cho worker/debugger (GPT-6 Sol) và reviewer (GPT-6 Astra). Pi 0.99 đổi tên hiển thị; provider vẫn là `openai-codex`. "Sign in with ChatGPT" của provider **OpenAI** là provider khác (`openai`), preset không dùng.
3. Trong `/login`, chọn **OpenCode Go** và nhập API key cho GLM. Pi cũng nhận biến môi trường `OPENCODE_API_KEY`.
4. Chạy `firecrawl login --browser` để đăng nhập dịch vụ web.
5. Tuỳ chọn: tạo API key TypeSafe tại [console.typesafe.ai](https://console.typesafe.ai), thêm `export TYPESAFE_API_KEY="<key>"` vào `~/.zshrc` hoặc `~/.bashrc` (Windows: `setx TYPESAFE_API_KEY "<key>"`) rồi mở terminal mới, để auto mode sàng lọc bằng Jev. Đây là cách tài liệu TypeSafe và đa số package Jev hướng dẫn; muốn giữ key trong keyring của hệ điều hành thay vì biến môi trường thì chạy `pi-mcp-adapter key set systemone`. Chưa có key thì bộ phân loại LLM làm cả hai giai đoạn như trước.

Một cấu hình Pi dùng auth của agent directory. Firecrawl dùng credential store của CLI theo hệ điều hành. Repo không chứa credential, token hay dữ liệu phiên của người dùng; không nhập key vào chat hoặc commit vào Git.

## Một phiên Pi, các slash command

Chạy `pi` để mở Claude Opus 5.5/high với toàn bộ công cụ. Các workflow được điều khiển trong cùng phiên:

| Công việc | Lệnh |
|---|---|
| Quy trình làm việc (skills) | `/skill:work ?`, `/skill:grill-with-docs`, `/skill:implement`, `/skill:ship`, `/skill:afk`, `/skill:setup`… ([docs/workflow.md](docs/workflow.md)) |
| Goal dài hạn | `/goal`, `/goal-status`, `/goal-pause`, `/goal-resume` |
| Shell job nền | `/bg --name "Dev server" npm run dev`, `/jobs`, `/logs`, `/kill` |
| Ý kiến cố vấn | `/advisor-manual`, `/advisor-settings`, `/advisor-off`, `/advisor` |
| Rewind code/hội thoại | `Esc Esc`, `/rewind` (`/checkpoint`, `/undo`), `/redo`; `/clear` mở phiên mới |
| Permission | `Shift+Tab` (auto ⇄ bypass), `/permissions`, `/auto-mode` |
| Model và reasoning | `/model`, `/thinking`, `Alt+T` đổi mức thinking |
| Công cụ và giao diện | `/agents`, `/usage`, `/claude-usage`, `/mcp`, `/open-tui` |

Advisor (pi-advisor-flow) luôn bật khi mở phiên: executor là Opus/high của phiên, advisor là GPT-6 Astra/high.
- System prompt dặn Opus gọi `ask_advisor` sau hai lần thử tương đương cùng thất bại và trước khi báo xong việc không nhỏ. Tối đa 5 lần mỗi phiên; không có gate cứng chặn phiên.
- Advisor không có tool. Nó thấy tối đa 60.000 ký tự gồm hội thoại gần nhất và diff chưa commit (diff tối đa 20.000 ký tự, đã che secret). Thay đổi lớn vẫn nên giao reviewer.
- Bản vá giữ system prompt không đổi sau mỗi lần hỏi, để Opus không mất prompt cache.
- `/advisor-off` tắt hẳn, kể cả các phiên sau (bản vá: Pi tự bật mọi tool của extension khi mở phiên, nên advisor chỉ bật khi Always on kích hoạt được); bật lại ở `/advisor-settings` → Always on. Khi advisor đang bật, `/model` lưu model mới làm executor vào `advisor.json`; cài lại giữ giá trị này.
- Mở phiên khi chưa đăng nhập Claude hoặc Codex thì Pi báo `Advisor models are not configured or available` và phiên chạy không có advisor; đăng nhập rồi chạy `/advisor`.

Goal chỉ bắt đầu khi được yêu cầu. Mỗi lần tạo hoặc resume có tối đa 10 lượt tự tiếp tục do goal extension khởi động; giới hạn này không tính các tool call trong một lượt hay request do extension khác khởi động.
- Khi agent báo hoàn thành, auditor GPT-6 Astra/high kiểm tra độc lập trong phiên riêng (đọc file, chạy lệnh). Không duyệt thì goal vẫn mở kèm phản hồi. Tắt audit cho goal đang chọn bằng `Ctrl+Shift+A` hoặc trong hộp xác nhận goal.
- Lệnh của auditor qua cổng permission như subagent (bản vá pi-goal-x): theo mode của phiên chính, câu hỏi hiện ở UI phiên chính.
- Khi agent sắp chuyển goal sang blocked, Oracle Astra/high (chỉ đọc) được hỏi một lần cho mỗi vướng mắc.

Background cung cấp shell jobs. Khi job kết thúc (xong, lỗi hoặc bị dừng), thông báo `<background-task-notification>` tự mở lượt mới cho phiên chính, nên model kết thúc lượt thay vì chờ hay hỏi trạng thái liên tục; không cần gửi tin để nó làm tiếp. Với dev server, watcher hoặc job không cần xử lý khi xong, model đặt `triggerOnCompletion:false`: thông báo vẫn vào hội thoại nhưng không đánh thức model. Model delegation dùng `Agent`.

Rewind (`pi-rewind`, extension của repo) theo giao diện `/rewind` của Claude Code: mỗi prompt có checkpoint; `Esc Esc` hoặc `/rewind` mở danh sách prompt kèm số dòng đã đổi, rồi chọn khôi phục code, hội thoại, cả hai, hoặc tóm tắt từ/đến prompt đó. File do `edit`/`write` sửa luôn được theo dõi; file do `bash`/`Agent` sửa được theo dõi trong git worktree. Mục Redo trong menu (hoặc `/redo`) hoàn tác lần rewind gần nhất, và ngay sau Redo có mục Undo redo để lấy lại việc đã làm sau lần rewind. `/clear` mở phiên mới như `/new`, và menu của phiên mới có mục quay lại phiên cũ. Nếu Pi thoát giữa lúc khôi phục code, menu cho hoàn tất hoặc hoàn tác lần khôi phục đó. Chi tiết và giới hạn: [docs/rewind.md](docs/rewind.md).

Permission (`pi-auto-mode`, extension của repo) có hai mode như Claude Code. **Auto** là mặc định: thao tác đọc, lệnh chỉ đọc và sửa file trong project chạy ngay; lệnh khác qua bộ phân loại hai giai đoạn.
- Giai đoạn 1 là **Jev**, model System One của TypeSafe, khi có key. Jev không sinh chữ: mỗi lệnh là một request (khoảng 120 ms) trả xác suất cho 17 loại rủi ro và một thang mức hại, code so với ngưỡng. Lệnh thường chạy luôn, không gọi LLM. Khi hiệu chỉnh với Jev thật, cả 168 lệnh rủi ro đều bị gắn cờ; khoảng 1/10 lệnh thường phải gọi LLM.
- Giai đoạn 2 là Claude Sonnet 5 có suy luận (model Claude Code dùng cho bộ phân loại của nó), chỉ xét lệnh bị gắn cờ và chỉ thấy tin nhắn của người dùng cùng lệnh của agent. Không có key Jev thì Sonnet 5 làm cả hai giai đoạn.
- Jev cũng quét kết quả web, MCP và subagent để tìm prompt injection và cảnh báo agent.
- Lệnh bị chặn trả lý do cho agent để đi đường an toàn hơn; 3 lần chặn liên tiếp hoặc 20 lần trong phiên thì hỏi người dùng.

**Bypass** chạy mọi thứ trừ luật deny; lệnh không kiểm được với deny đường dẫn, `rm` vào đường dẫn quan trọng, lệnh xoá đệ quy và lệnh rủi ro (cài cơ chế tự chạy, tắt kiểm TLS, ghi đường dẫn hệ thống) thì hỏi bạn trước. `Shift+Tab` đổi mode, `/permissions` xem và duyệt lại lệnh bị chặn, `/auto-mode` xem trạng thái và chi phí Jev. Chi tiết: [docs/auto-mode.md](docs/auto-mode.md).

**Git guard** chặn tất định (không qua bộ phân loại, ở cả hai mode, cả agent con và goal auditor): force-push (trừ `--force-with-lease`), push thẳng lên nhánh bảo vệ (`main`, `master`, `release/*`…), `reset --hard`, `clean -f`, `branch -D`, bỏ qua hook (`--no-verify`, `HUSKY=0`…), viết lại lịch sử và `rm -r` trên `/`, `~`, `.`, `.git`. Cần thật thì bạn tự chạy bằng `!<lệnh>` trong editor. Cấu hình: [docs/auto-mode.md](docs/auto-mode.md#git-guard).

Opus 5.5 và GLM dùng context **1M** của catalog; Astra/Sol nâng lên **872K**. Theme mặc định Rosé Pine Moon, có thêm Rosé Pine và Dawn.

## Agent

Pi dùng `Agent` của **@tintinweb/pi-subagents**:

| Role | Model/effort | Phạm vi |
|---|---|---|
| `researcher` | GLM-5.3-Flash/max | Khảo sát docs/log/web và lịch sử git (cả code khi cần kèm nguồn ngoài), thu thập bằng chứng; chỉ đọc (bash cho lệnh đọc) |
| `explorer` | GLM-5.3-Flash/high | Đọc code trong workspace, trả bản đồ file/symbol/luồng gọi; chỉ đọc, không web |
| `worker` | GPT-6 Sol/max | Triển khai và kiểm thử phần việc đã chốt |
| `debugger` | GPT-6 Sol/max | Tái hiện lỗi, tìm nguyên nhân, sửa và kiểm hồi quy |
| `reviewer` | GPT-6 Astra/high | Review độc lập (cả ba trục của `interrogate`); chỉ đọc, bash để chạy diff, test và script thử |
| `verifier` | GPT-6 Astra/high | Chứng minh thay đổi trên sản phẩm thật bằng verify skill; VERIFIED / NOT VERIFIED / INCONCLUSIVE; không sửa code |

Parent Claude Opus 5.5/high giữ thiết kế, quyết định quan trọng và nghiệm thu cuối. GLM chạy trực tiếp qua OpenCode Go trong Pi.

Bảng trên là preset `default`. Model và thinking của mọi vai (parent, các role, advisor, goal auditor, Oracle, auto mode) đặt trong `<agent-dir>/model-roles.json` và đổi bằng `pi-models`, ví dụ `pi-models preset claude` (chỉ cần đăng nhập Claude), `pi-models preset tree` (quy trình agent tree: Opus làm, Fable trực advisor; [docs/workflow.md](docs/workflow.md#agent-tree)) hay `pi-models set worker anthropic/claude-opus-5-5 high`. Trong Pi, `/models` mở menu các vai và áp ngay cho phiên đang chạy. Xem [docs/models.md](docs/models.md).

```text
@explorer Tìm luồng xử lý timeout và báo file/dòng.
@researcher Tra changelog của thư viện HTTP về timeout mặc định.
@worker Triển khai phần đã chốt, chạy kiểm thử liên quan.
@debugger Tái hiện lỗi và sửa với regression test.
@reviewer Review diff, nêu lỗi có bằng chứng.
```

Agent có context riêng và không giới hạn số lượt; dừng agent bằng `/agents` → chọn agent → `x` hai lần. Khi parent gọi, explorer/researcher/reviewer chạy nền theo mặc định (tối đa 4 cùng lúc), worker/debugger/verifier chạy foreground (tối đa 2); vượt giới hạn thì xếp hàng. Parent điều phối để tránh ghi chồng file. Gõ `@role nội dung` thì agent chạy nền và báo kết quả cho parent khi xong. Mặc định task là đúng nội dung bạn gõ; chế độ `model` (`/agents` → Settings → Agent mentions) cho một bản sao hội thoại viết task có context. Chi tiết cấu hình, quyền và vòng đời: [docs/subagents.md](docs/subagents.md).

## Công cụ và mặc định

- Web: `web_search` dùng native search của model hiện tại: provider `openai` cho Codex/OpenAI (Astra, Sol), `anthropic` cho Claude (bản vá pi-web-access); model khác (GLM) dùng Exa (endpoint MCP miễn phí, không cần key) rồi Firecrawl; lỗi mạng, quota, phản hồi hỏng chuyển sang provider kế tiếp. `fetch_content`, `get_search_content` dùng Firecrawl và kho kết quả. Phiên mới hiện `web_enable` để model bật web tools. CLI và skills hỗ trợ workflow bổ sung. Chi tiết: [docs/claude-setup.md](docs/claude-setup.md).
- MCP: pi-mcp-adapter quản lý server qua `<agent-dir>/mcp-adapter.json`; pi-config không cài sẵn server nào, bạn tự thêm vào `mcpServers` khi cần (đặt `allowInstall: false`: agent không tự cài thêm server MCP). MCP, codemode và `tool_search` dựng sẵn của Pi 0.99 được tắt trong `extensions` của settings (`-builtin:mcp`, `-builtin:codemode`, `-builtin:tool-search`) để không có hai `/mcp` và để mọi lời gọi tool đi qua cổng permission như trước; bật lại trong `pi config` nếu cần.
- Native compaction bật: reserve 16.384, giữ gần nhất 20.000 token. Với cửa sổ 1M, auto-compaction chạy rất muộn; xem context ở footer và chọn ranh giới pha quanh mép 150k (smart zone, [docs/workflow.md](docs/workflow.md#ranh-giới-pha-và-smart-zone)).
- Cache warming tắt. Advisor, goal auditor và Oracle bật như mô tả ở trên. Jev của auto mode chỉ chạy khi bạn đã lưu key TypeSafe (tính theo token đầu vào, khoảng $0,0001 mỗi lần sàng lọc). Goal và background follow-up chỉ chạy theo thao tác/cấu hình đã chọn.
- Codex fast mode bật mặc định (`codexFastMode:true`): mọi request tới GPT-6 Sol (worker, debugger) và GPT-6 Astra (reviewer, advisor, goal auditor, Oracle) đi hàng `priority`; GPT-6.1 Sol cũng vậy khi bạn đặt một vai sang model này. Theo catalog của Codex, Sol nhanh khoảng 1,5 lần, Astra khoảng 2 lần; đổi lại tốn quota Codex nhiều hơn (Pi tính chi phí gấp đôi). Tắt bằng `/fast` khi phiên đang dùng model Codex, hoặc `/usage` → Settings → Codex Fast mode khi đang dùng Opus. Footer hiện `fast` khi phiên đang dùng model Codex có fast.
- Header/footer/editor do pi-open-tui quản lý. Footer hiển thị model, thinking, quota (Codex qua pi-usage; Claude từ header phản hồi và `/api/oauth/usage` khi mở phiên, 15 phút một lần nếu header đã cũ; chi tiết bằng `/claude-usage`), context % kèm token/cửa sổ, token/cost và trạng thái công cụ liên quan. Palette terminal theo theme của phiên và được phục hồi khi thoát.
- Dán ảnh: `@pi-archimedes/image-paste`, dùng **Ctrl+V** trên macOS/Linux hoặc **Alt+V** trên Windows. Copy ảnh vào clipboard, dán để có marker `[Image #1]`, rồi gửi cùng prompt. Xóa marker để bỏ ảnh; giới hạn 20 MiB/ảnh. Preview chỉ hiện trong UI, ảnh được gửi tới model đúng một lần. Phím dán ảnh tích hợp của Pi được tắt trong `keybindings.json` để tránh xử lý trùng.
- Clipboard native `@mariozechner/clipboard` được ghim và cài bên cạnh extension. Linux cần desktop X11/Wayland; `wl-clipboard`/`xclip` là các reader thay thế. Terminal không hỗ trợ ảnh inline vẫn gửi được ảnh, chỉ thiếu preview. Chỉ nạp image-paste; phần giao diện của bộ Archimedes không được nạp.
- Hàng đợi tin nhắn: `Enter` khi Pi đang chạy để chỉnh hướng, `Alt+Enter` hoặc **Ctrl+Enter** để xếp follow-up, `Alt+Up` để lấy lại tin đang chờ. Ctrl+Enter được thêm vì terminal của Orca gửi Alt+Enter thành Shift+Enter.
- Nhiều phiên song song, mỗi task một worktree: dùng Orca. Cài đặt, phím và các giới hạn xem [docs/orca.md](docs/orca.md).

`pi-models` in model/thinking của mọi vai theo `model-roles.json`, giá trị đang có hiệu lực khi khác, kiểm model trong catalog của Pi và cảnh báo provider chưa đăng nhập; `pi-models preset|set|reset|adopt|apply` đổi rồi áp ngay vào cấu hình, `pi-models list` liệt kê provider và model; `/models` làm việc đó ngay trong Pi. `pi-doctor` kiểm dependency và checksum bản vá, in cùng bảng model đó cùng trạng thái advisor, goal và auto mode (kèm nguồn key Jev, không in key), và báo lỗi khi hai danh sách provider trong `web-search.json` lệch nhau (pi-web-access sẽ không nạp web tools). `pi-mcp-adapter key set|status|remove systemone` quản lý key Jev trong keyring (cách thay cho `TYPESAFE_API_KEY`). `pi-test` kiểm workflow và Agent bằng provider giả trong thư mục tạm, không gọi model trả phí.

Auto mode là lớp duyệt bằng model, không thay thế sandbox hệ điều hành: bộ phân loại có thể sai. Luật `permissions.deny` (file bí mật, `sudo`...) áp dụng ở cả hai mode, theo đường dẫn có trong lệnh: glob hay tìm cả cây chạm tới file bị deny thì bị chặn, tool `grep` của Pi bỏ các dòng thuộc file đó khỏi kết quả, lệnh có tập đích không kiểm được (biến, `xargs`...) thì auto mode giao bộ phân loại, bypass hỏi bạn. Chương trình tùy ý (`node`, `python -c`...) vẫn tự mở được file; xem [giới hạn đọc](docs/auto-mode.md#giới-hạn-đọc-khi-có-deny-đường-dẫn). Bypass vẫn hỏi trước lệnh xoá đệ quy ra ngoài thư mục tạm (`rm -fr`, `find -delete`, `git clean`...) và lệnh rủi ro (`~/.bashrc`, git hook, crontab, `curl -k`, `/etc`...). Project cần được trust trước khi dùng cấu hình của project; settings của project không bật được bypass hay thêm luật allow. Nguồn web là dữ liệu để tham khảo, không phải instruction.

## Phiên bản

| Thành phần | Phiên bản |
|---|---|
| Pi (`@earendil-works/pi-coding-agent`, `pi-ai`, `pi-agent-core`, `pi-tui`) | 0.99.2 |
| `@tintinweb/pi-subagents` | 0.19.0 |
| `@gotgenes/pi-anthropic-auth` | 3.4.1 |
| `pi-mcp-adapter` | 4.0.0 |
| `pi-web-access` | 0.35.0 |
| `@juicesharp/rpiv-ask-user-question`, `rpiv-todo` | 2.12.0 |
| `@narumitw/pi-usage` | 0.61.1 |
| `pi-background-tasks` | 2.6.9 |
| `pi-goal-x` | 0.31.9 |
| `pi-advisor-flow` | 0.9.1 |
| `pi-open-tui` | 0.3.10 |
| `@pi-archimedes/image-paste` | 2.8.0 |
| `@mariozechner/clipboard` | 0.3.9 |
| Firecrawl CLI | 1.25.1 |
| Skills quy trình (tstack) | Trong repo: [assets/skills](assets/skills); skill theo stack (typescript, python, mobile) trong [assets/stack-skills](assets/stack-skills), `/skill:setup` chép vào repo dùng stack đó |
| Firecrawl skills | Commit trong [sources.lock.json](sources.lock.json) |

Các manifest và lockfile nằm trong [manifests](manifests). Hai package có peer range chưa gồm Pi 0.99.2 (pi-background-tasks, pi-goal-x) được đóng gói lại, chỉ bổ sung đúng phiên bản này vào metadata; source/integrity upstream và SHA256 tarball nằm trong manifest. Đây là cấu hình tương thích được kiểm thử bởi pi-config, không phải tuyên bố hỗ trợ của upstream. Bản vá tương thích có source hash, kết quả hash và điều kiện phiên bản tại [assets/patches.json](assets/patches.json). Quy trình nâng phiên bản (vendor, lockfile, tính lại checksum bản vá): [docs/upgrade.md](docs/upgrade.md).

## Quản lý cấu hình

Mặc định: runtime ở `~/.local/share/pi-platform`, main agent ở `~/.pi/agent`, launcher ở `~/.local/bin`. Windows dùng các thư mục tương ứng trong user profile.

Installer chỉ quản lý bản cài có `install-state.json` phù hợp. Với root đã có dữ liệu khác, dùng đường dẫn riêng:

```sh
node install.mjs --root /duong-dan/platform --agent-dir /duong-dan/agent --bin-dir /duong-dan/bin --no-path
```

Role, subagents, goal settings, advisor settings và cấu hình công cụ cùng nằm trong agent directory. Một runtime Pi duy nhất ở `runtimes/current`; Firecrawl CLI ở `tools/firecrawl`.

Khi chạy lại, installer dùng lockfile và checksum để kiểm tính nhất quán; runtime được cài lại khi lockfile hoặc kết quả bản vá đổi, để bản vá luôn áp lên file gốc. Bản runtime và nguồn cũ được chuyển vào `<root>/backups`; mỗi lần cài chỉ giữ bản gần nhất của mỗi loại (và 3 lần gỡ tài nguyên gần nhất), còn bản sao file cấu hình trước khi ghi đè thì giữ nguyên.

File JSON cấu hình trong agent directory và `<root>/config`, kể cả `settings.json` mà Pi ghi lại khi đổi model hay thinking, được gộp ba chiều với mặc định của lần cài trước (lưu ở `<root>/state/defaults`):
- Giá trị bạn chưa đổi nhận mặc định mới; giá trị bạn đã đổi được giữ. Nếu mặc định mới cũng đổi chính giá trị đó, installer giữ của bạn và báo xung đột kèm mặc định mới.
- Danh sách của `settings.json` (`permissions.allow/ask/deny`, `enabledModels`, `skills`, `themes`, `prompts`, `extensions`, `packages`) gộp theo từng mục: mục bạn thêm hoặc bỏ và loại trừ extension `-` được giữ, mục mặc định mới được thêm, `pi-auto-mode` luôn nạp sau cùng; luật deny của pi-permission-system cũ được chuyển sang.
- Bản cài chưa lưu mặc định (trước khi có cơ chế này): file chưa sửa nhận mặc định mới như trước; file đã sửa lần đầu chỉ được thêm khóa và mục còn thiếu, mọi giá trị hiện có được giữ và giá trị khác mặc định mới được báo.
- File role `agents/*.md` cũng được gộp: mỗi khóa frontmatter (`model`, `thinking`, `tools`...) là một giá trị, phần prompt là một giá trị. Sửa một dòng không làm file đứng yên; prompt mới vẫn vào được.
- Installer in phần đã gộp và từng xung đột, backup file trước khi ghi lại; lần chạy không có gì mới thì không ghi gì.

Model và thinking của các file trên sinh từ `<agent-dir>/model-roles.json`. File này thuộc về bạn: installer chỉ tạo khi chưa có (hoặc ghi preset khi cài với `--models <preset>`), kiểm model trong catalog của Pi trước khi ghi cấu hình, và dừng khi file sai. `pi-models` đổi file này và áp ngay theo cùng cách gộp ([docs/models.md](docs/models.md)).

File khác đã tùy chỉnh (`AGENTS.md`) được giữ và báo đường dẫn. Tài nguyên do installer quản lý, không còn được yêu cầu và chưa chỉnh sửa, được lưu vào backup; tài nguyên còn được cấu hình tham chiếu được giữ. Auth và file riêng của người dùng không thuộc danh sách tài nguyên được dọn.

Nâng cấp từ bản Pi 0.87.1: pi-mcp-adapter 3.x đọc `<agent-dir>/mcp-adapter.json` thay cho `mcp.json`. Installer ghi file mới; `mcp.json` cũ chưa sửa được lưu vào backup, còn nếu bạn đã thêm server vào đó thì file được giữ và adapter nhắc khi mở phiên: chuyển các server trong `mcpServers` sang `mcp-adapter.json` rồi xóa `mcp.json`.

`npm ci` của installer được tối đa 30 phút (lệnh khác 10 phút). Mạng tới registry npm chậm thì tăng bằng `PI_CONFIG_NPM_TIMEOUT_MINUTES`, ví dụ `PI_CONFIG_NPM_TIMEOUT_MINUTES=60 node install.mjs` (PowerShell: `$env:PI_CONFIG_NPM_TIMEOUT_MINUTES=60`); chạy lại cũng nhanh hơn vì gói đã tải nằm trong cache của npm.

Dừng các phiên Pi trước khi cập nhật. Dùng revision đã qua CI thay vì chạy `pi update` hoặc `npm update` trên runtime ghim. `.install.lock` còn sót từ lần cài bị ngắt được installer và `pi-models` tự gỡ khi tiến trình ghi trong đó đã dừng; tiến trình còn chạy thì báo PID.

## Phát triển và kiểm thử

```sh
npm run check
npm test
npm run smoke
```

CI chạy trên Ubuntu, Windows và macOS: kiểm repo, cấu hình, request payload, cài sạch, các slash workflow và Agent trong cùng phiên bằng provider giả, cài lại gộp mặc định mới mà vẫn giữ tùy chỉnh, và bootstrap với đường dẫn có khoảng trắng. Bản vá file `.ts` không được thêm lỗi kiểu: smoke biên dịch source đã vá và bản gốc (dựng lại bằng cách đảo bản vá, kiểm `originalSha256`) bằng TypeScript của runtime trên type của Pi đã cài. Test không dùng credential thật hoặc gọi model trả phí. Đây là kiểm chứng runtime và bộ cài; chất lượng model và quyền truy cập tài khoản được đánh giá riêng.

Nguồn và giấy phép: [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md). Mã riêng của dự án dùng [MIT](LICENSE).
