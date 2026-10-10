# pi-config

[![Kiểm thử cài đặt](https://github.com/duy-tung/pi-config/actions/workflows/test.yml/badge.svg)](https://github.com/duy-tung/pi-config/actions/workflows/test.yml)

Bộ cài **Pi 1.1.0** cho **macOS, Linux và Windows**: model theo vai trò, context riêng cho agent, native web search theo model (GPT, Claude) với Exa và Firecrawl dự phòng, quota Claude trong footer, permission kiểu Claude Code (manual, accept edits, auto mode và bypass) và giao diện Rosé Pine. Chỉ cài skill của công cụ (Firecrawl); không kèm bộ skill quy trình. Dependency, nguồn skills và bản vá được ghim để tái lập cấu hình.

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

1. Chạy `pi`, dùng `/login` và chọn **Anthropic** (gói Pro/Max), hoặc đặt `ANTHROPIC_API_KEY`. Mọi vai mặc định là Claude: parent và worker Opus 5.5, researcher Sonnet 5.5, reviewer và advisor Fable 5.1, bộ phân loại của auto mode Sonnet 5.5. Xem [docs/claude-setup.md](docs/claude-setup.md).
2. Tuỳ chọn, khi muốn đặt một vai sang GPT: `/login` → **OpenAI** → **Sign in with ChatGPT** (provider `openai`, dùng gói ChatGPT qua Responses API của `api.openai.com`), rồi chọn model `openai/…` (vd `openai/gpt-6.1-sol`). Đăng nhập mở trình duyệt và nhận callback ở cổng 1455 (cổng Codex CLI cũng dùng; Pi báo lỗi nếu cổng bận); máy không có trình duyệt thì dán URL chuyển hướng cuối vào Pi. **OpenAI Codex (legacy)** (`openai-codex`) vẫn dùng được cho vai đã đặt sang nó và là cách duy nhất có Codex fast mode. Model của OpenCode Go (vd GLM) cũng dùng được sau khi `/login` → **OpenCode Go** hoặc đặt `OPENCODE_API_KEY`.
3. Chạy `firecrawl login --browser` để đăng nhập dịch vụ web.
4. Tuỳ chọn: tạo API key TypeSafe tại [console.typesafe.ai](https://console.typesafe.ai), thêm `export TYPESAFE_API_KEY="<key>"` vào `~/.zshrc` hoặc `~/.bashrc` (Windows: `setx TYPESAFE_API_KEY "<key>"`) rồi mở terminal mới, để auto mode sàng lọc bằng Jev. Đây là cách tài liệu TypeSafe và đa số package Jev hướng dẫn. Chưa có key thì bộ phân loại LLM làm cả hai giai đoạn như trước.

Một cấu hình Pi dùng auth của agent directory. Firecrawl dùng credential store của CLI theo hệ điều hành. Repo không chứa credential, token hay dữ liệu phiên của người dùng; không nhập key vào chat hoặc commit vào Git.

## Một phiên Pi, các slash command

Chạy `pi` để mở Claude Opus 5.5/high với toàn bộ công cụ. Các workflow được điều khiển trong cùng phiên:

| Công việc | Lệnh |
|---|---|
| Shell job nền | `/bg --name "Dev server" npm run dev`, `/jobs`, `/logs`, `/kill` |
| Ý kiến cố vấn | `/advisor-manual`, `/advisor-settings`, `/advisor-off`, `/advisor` |
| Rewind code/hội thoại | `Esc Esc`, `/rewind` (`/checkpoint`, `/undo`), `/redo`; `/clear` mở phiên mới |
| Permission | `Shift+Tab` (manual → accept edits → [bypass] → auto), `/permissions` (mode, model phân loại, lệnh bị chặn, luật, `test <lệnh>`), `/add-dir` |
| Model và reasoning | `/model`, `/thinking`, `Alt+T` đổi mức thinking |
| Công cụ và giao diện | `/agents`, `/usage`, `/claude-usage`, `/open-tui` |

Advisor (pi-advisor-flow) luôn bật khi mở phiên: executor là Opus/high của phiên, advisor là Fable 5.1/high.
- System prompt dặn Opus gọi `ask_advisor` sau hai lần thử tương đương cùng thất bại và trước khi báo xong việc không nhỏ. Không giới hạn số lần mỗi phiên; không có gate cứng chặn phiên. Đổi gate và số lượt bằng `/advisor-settings`; cài lại giữ giá trị đã đổi.
- Advisor không có tool. Nó thấy tối đa 60.000 ký tự gồm hội thoại gần nhất và diff chưa commit (diff tối đa 20.000 ký tự, đã che secret); không gửi kèm `AGENTS.md` (`advisorAgentsMdContext: false`). Thay đổi lớn vẫn nên giao reviewer.
- Request tới advisor lỗi thì thử lại một lần với Opus 5.5 (`advisorFallbackModel`, cùng mức thinking của advisor), tính là một lượt. Fallback trùng model của phiên chính nên `advisorDisableSameModel` tắt: nếu đổi phiên chính sang chính model advisor, advisor vẫn được gọi thay vì bỏ qua.
- Bản vá giữ system prompt không đổi sau mỗi lần hỏi, để Opus không mất prompt cache.
- `/advisor-off` tắt hẳn, kể cả các phiên sau (bản vá: Pi tự bật mọi tool của extension khi mở phiên, nên advisor chỉ bật khi Always on kích hoạt được); bật lại ở `/advisor-settings` → Always on. Khi advisor đang bật, `/model` lưu model mới làm executor vào `advisor.json`; cài lại giữ giá trị này.
- Mở phiên khi chưa đăng nhập Claude thì Pi báo `Advisor models are not configured or available` và phiên chạy không có advisor; đăng nhập rồi chạy `/advisor`.

Background cung cấp shell jobs. Khi job kết thúc (xong, lỗi hoặc bị dừng), thông báo `<background-task-notification>` tự mở lượt mới cho phiên chính, nên model kết thúc lượt thay vì chờ hay hỏi trạng thái liên tục; không cần gửi tin để nó làm tiếp. Với dev server, watcher hoặc job không cần xử lý khi xong, model đặt `triggerOnCompletion:false`: thông báo vẫn vào hội thoại nhưng không đánh thức model. Model delegation dùng `Agent`.

Rewind (`pi-rewind`, extension của repo) theo giao diện `/rewind` của Claude Code: mỗi prompt có checkpoint; `Esc Esc` hoặc `/rewind` mở danh sách prompt kèm số dòng đã đổi, rồi chọn khôi phục code, hội thoại, cả hai, hoặc tóm tắt từ/đến prompt đó. File do `edit`/`write` sửa luôn được theo dõi; file do `bash`/`Agent` sửa được theo dõi trong git worktree. Mục Redo trong menu (hoặc `/redo`) hoàn tác lần rewind gần nhất, và ngay sau Redo có mục Undo redo để lấy lại việc đã làm sau lần rewind. `/clear` mở phiên mới như `/new`, và menu của phiên mới có mục quay lại phiên cũ. Nếu Pi thoát giữa lúc khôi phục code, menu cho hoàn tất hoặc hoàn tác lần khôi phục đó. Chi tiết và giới hạn: [docs/rewind.md](docs/rewind.md).

Permission (`pi-auto-mode`, extension của repo) có bốn mode như Claude Code. **Auto** là mặc định: thao tác đọc, lệnh chỉ đọc và sửa file trong project chạy ngay; đọc file ngoài project chỉ hỏi một lần đầu; lệnh khác qua bộ phân loại hai giai đoạn.
- Giai đoạn 1 là **Jev**, model System One của TypeSafe, khi có key. Jev không sinh chữ: mỗi lệnh là một request (khoảng 120 ms) trả xác suất cho 17 loại rủi ro và một thang mức hại, code so với ngưỡng. Lệnh thường chạy luôn, không gọi LLM. Khi hiệu chỉnh với Jev thật, cả 168 lệnh rủi ro đều bị gắn cờ; khoảng 1/10 lệnh thường phải gọi LLM.
- Giai đoạn 2 là Claude Sonnet 5.5 có suy luận, chỉ xét lệnh bị gắn cờ và chỉ thấy tin nhắn của người dùng cùng lệnh của agent. Không có key Jev thì Sonnet 5 làm cả hai giai đoạn.
- Jev cũng quét kết quả web, MCP và subagent để tìm prompt injection và cảnh báo agent.
- Lệnh bị chặn trả lý do cho agent để đi đường an toàn hơn; 3 lần chặn liên tiếp hoặc 20 lần trong phiên thì hỏi người dùng.

**Manual** (mode default của Claude Code) quyết định như auto nhưng hỏi bạn thay cho bộ phân loại, kể cả khi sửa file và đọc ngoài workspace (cho đọc cả thư mục tới hết phiên); không gọi model nào, không có UI thì chặn. Hộp hỏi có Yes; Yes, and don't ask again (lệnh shell lưu luật theo tiền tố cho repo, dùng chung mọi worktree, ngoài repo; sửa file thì chuyển sang accept edits); Yes, and switch to auto mode (lệnh shell); No (dừng lượt); No, and tell Pi what to do differently. **Accept edits** như manual nhưng sửa file và `mkdir`/`touch`/`rm`/`rmdir`/`mv`/`cp`/`sed -i` trong workspace chạy ngay.

**Bypass** như Claude Code: chỉ có khi mở Pi bằng `--dangerously-skip-permissions` (hoặc `--permission-mode bypass`, `--allow-dangerously-skip-permissions`); chạy mọi thứ trừ luật deny và ask. `rm` vào `/`, `~` hay thư mục làm việc thì hỏi bạn trước, ở auto và bypass có đếm ngược 2 phút. Không có lớp chặn riêng cho git phá huỷ: auto để bộ phân loại xét, manual hỏi, bypass chạy. `Shift+Tab` đổi mode; `/add-dir` thêm thư mục làm việc. `/permissions` là menu duy nhất: đổi mode, model phân loại, xem trạng thái và chi phí Jev, duyệt lại lệnh bị chặn, xem luật và chạy thử một lệnh. Chi tiết: [docs/auto-mode.md](docs/auto-mode.md).

Mọi model dùng context của catalog Pi (Opus 5.5 1M; `openai/…` qua Sign in with ChatGPT 272K); `openai-codex` (legacy) không còn override riêng. Theme Rosé Pine Moon.

## Agent

Pi dùng `Agent` của **@tintinweb/pi-subagents**:

| Role | Model/effort | Phạm vi |
|---|---|---|
| `researcher` | Claude Sonnet 5.5/high | Đọc code trong workspace, tra docs/log/web và lịch sử git, thu thập bằng chứng; chỉ đọc (bash cho lệnh đọc) |
| `worker` | Claude Opus 5.5/high | Triển khai và kiểm thử phần việc đã chốt; sửa lỗi: tái hiện, tìm nguyên nhân, sửa và kiểm hồi quy |
| `reviewer` | Claude Fable 5.1/high | Review độc lập; chỉ đọc, bash để chạy diff, test và script thử |

Parent Claude Opus 5.5/high giữ thiết kế, quyết định quan trọng và nghiệm thu cuối. Reviewer dùng Fable 5.1, khác model với worker.

Bảng trên là cấu hình mặc định. Đổi model và thinking bằng giao diện có sẵn: phiên chính bằng `/model`, researcher/worker/reviewer trong `/agents` → Agent types → chọn vai → Model/Thinking, advisor bằng `/advisor-models`. Muốn một vai dùng GPT hay GLM thì đăng nhập provider đó rồi đổi tại đây. Cài lại giữ giá trị bạn đã đổi. Xem [docs/models.md](docs/models.md). Model phân loại của auto mode (mặc định Claude Sonnet 5.5/low) không phải một vai: đổi trong `/permissions` → Classifier.

```text
@researcher Tìm luồng xử lý timeout và báo file/dòng.
@researcher Tra changelog của thư viện HTTP về timeout mặc định.
@worker Triển khai phần đã chốt, chạy kiểm thử liên quan.
@worker Tái hiện lỗi và sửa với regression test.
@reviewer Review diff, nêu lỗi có bằng chứng.
```

Agent có context riêng và không giới hạn số lượt; dừng agent bằng `/agents` → chọn agent → `x` hai lần. Khi parent gọi, researcher/reviewer chạy nền theo mặc định (tối đa 4 cùng lúc), worker chạy foreground (tối đa 2); vượt giới hạn thì xếp hàng. Parent điều phối để tránh ghi chồng file. Gõ `@role nội dung` thì agent chạy nền và báo kết quả cho parent khi xong. Task là đúng nội dung bạn gõ. Chi tiết cấu hình, quyền và vòng đời: [docs/subagents.md](docs/subagents.md).

## Công cụ và mặc định

- Web: `web_search` dùng native search của model hiện tại: provider `openai` cho GPT (Astra, Sol) qua Sign in with ChatGPT hoặc OpenAI Codex (legacy), `anthropic` cho Claude (bản vá pi-web-access); model khác (vd GLM) dùng Exa (endpoint MCP miễn phí, không cần key) rồi Firecrawl; lỗi mạng, quota, phản hồi hỏng chuyển sang provider kế tiếp. `fetch_content`, `get_search_content` dùng Firecrawl và kho kết quả. Phiên mới hiện `web_enable` để model bật web tools. CLI và skills hỗ trợ workflow bổ sung. Chi tiết: [docs/claude-setup.md](docs/claude-setup.md).
- MCP: không cài. MCP, codemode và `tool_search` dựng sẵn của Pi được tắt trong `extensions` của settings (`-builtin:mcp`, `-builtin:codemode`, `-builtin:tool-search`); provider llama.cpp dựng sẵn cũng tắt (`-builtin:llama.cpp`). Khi cần một server, bật MCP trong `pi config` (Built-in), thêm server bằng `pi mcp add` (ghi `<agent-dir>/mcp.json`) với `"exposure": "direct"`; mỗi tool là `mcp__<server>__<tool>` và đi qua cổng permission như tool khác.
- Giao diện fullscreen (mặc định từ Pi 1.0): cuộn bằng chuột/trackpad trong Pi (số dòng mỗi nấc theo `fullscreenWheelScrollLines` của Pi, mặc định `auto`), tìm trong transcript bằng **Alt+S** (Ctrl+Shift+F là ô tìm của WezTerm), khi thoát in lại transcript. Muốn giữ scrollback bình thường của terminal thì đặt `"tuiMode": "regular"` trong `settings.json` (cài lại vẫn giữ).
- Native compaction bật: reserve 16.384, giữ gần nhất 20.000 token. Với cửa sổ 1M, auto-compaction chạy rất muộn; xem context ở footer và chọn ranh giới pha quanh mép 150k.
- Cache warming tắt. Advisor bật như mô tả ở trên. Jev của auto mode chỉ chạy khi bạn đã lưu key TypeSafe (tính theo token đầu vào, khoảng $0,0001 mỗi lần sàng lọc). Background follow-up chỉ chạy theo thao tác/cấu hình đã chọn.
- Header/footer/editor do pi-open-tui quản lý. Footer hiển thị model, thinking, quota Claude (từ header phản hồi và `/api/oauth/usage` khi mở phiên, 15 phút một lần nếu header đã cũ; chi tiết bằng `/claude-usage`), context % kèm token/cửa sổ, token/cost và trạng thái công cụ liên quan (giữ màu extension đặt cho trạng thái). Palette terminal theo theme của phiên và được phục hồi khi thoát.
- Dán ảnh: `@pi-archimedes/image-paste`, dùng **Ctrl+V** trên macOS/Linux hoặc **Alt+V** trên Windows. Copy ảnh vào clipboard, dán để có marker `[Image #1]`, rồi gửi cùng prompt. Xóa marker để bỏ ảnh; giới hạn 20 MiB/ảnh. Preview chỉ hiện trong UI, ảnh được gửi tới model đúng một lần. Phím dán ảnh tích hợp của Pi được tắt trong `keybindings.json` để tránh xử lý trùng.
- Ảnh đọc qua clipboard native của pi-tui. Linux cần desktop X11/Wayland; `wl-clipboard`/`xclip` là các reader thay thế. Terminal không hỗ trợ ảnh inline vẫn gửi được ảnh, chỉ thiếu preview. Chỉ nạp image-paste; phần giao diện của bộ Archimedes không được nạp.
- Phím trùng phím mặc định của WezTerm được đổi: bảng hoạt động web **Alt+W** (thay Ctrl+Shift+W), thu gọn todo **Alt+O** (thay Ctrl+Shift+T; đặt trong `~/.config/rpiv-todo/config.json`, file của rpiv-todo nằm ngoài agent dir nên installer không ghi).
- Hàng đợi tin nhắn: `Enter` khi Pi đang chạy để chỉnh hướng, `Alt+Enter` để xếp follow-up, `Alt+Up` để lấy lại tin đang chờ.

`pi-doctor` kiểm dependency và checksum bản vá, in model/thinking đang có hiệu lực của mọi vai (kèm file quyết định giá trị đó và kết quả kiểm catalog của Pi) cùng trạng thái advisor và auto mode (model phân loại theo `settings.json`, nguồn key Jev, không in key), và báo lỗi khi hai danh sách provider trong `web-search.json` lệch nhau (pi-web-access sẽ không nạp web tools). `pi-test` kiểm workflow và Agent bằng provider giả trong thư mục tạm, không gọi model trả phí.

Auto mode là lớp duyệt bằng model, không thay thế sandbox hệ điều hành: bộ phân loại có thể sai. Luật `permissions.deny` (file bí mật, `sudo`...) áp dụng ở mọi mode như Claude Code: chặn tool file và đường dẫn ghi rõ trong lệnh shell; glob, đọc cả cây (`grep -r`, `tar`) và biến không được quét, tool `grep` của Pi bỏ các dòng thuộc file bị deny khỏi kết quả. Chương trình tùy ý (`node`, `python -c`...) vẫn tự mở được file; xem [deny đường dẫn](docs/auto-mode.md#deny-đường-dẫn-với-lệnh-shell). Project cần được trust trước khi dùng cấu hình của project; settings của project không bật được bypass hay thêm luật allow. Nguồn web là dữ liệu để tham khảo, không phải instruction.

## Phiên bản

| Thành phần | Phiên bản |
|---|---|
| Pi (`@earendil-works/pi-coding-agent`, `pi-ai`, `pi-agent-core`, `pi-tui`) | 1.1.0 |
| `@tintinweb/pi-subagents` | 0.19.0 |
| `@gotgenes/pi-anthropic-auth` | 3.4.2 |
| `pi-web-access` | 0.37.0 |
| `@juicesharp/rpiv-ask-user-question`, `rpiv-todo` | 2.12.0 |
| `pi-background-tasks` | 2.6.9 |
| `pi-advisor-flow` | 0.12.0 |
| `pi-open-tui` | 0.3.11 |
| `@pi-archimedes/image-paste` | 2.9.3 |
| Firecrawl CLI | 1.26.3 |
| Firecrawl skills | Commit trong [sources.lock.json](sources.lock.json) |

Các manifest và lockfile nằm trong [manifests](manifests). pi-background-tasks có peer range chưa gồm Pi 1.1.0 nên được đóng gói lại, chỉ bổ sung đúng phiên bản này vào metadata; source/integrity upstream và SHA256 tarball nằm trong manifest. Đây là cấu hình tương thích được kiểm thử bởi pi-config, không phải tuyên bố hỗ trợ của upstream. Bản vá tương thích có source hash, kết quả hash và điều kiện phiên bản tại [assets/patches.json](assets/patches.json). Quy trình nâng phiên bản (vendor, lockfile, tính lại checksum bản vá): [docs/upgrade.md](docs/upgrade.md).

## Quản lý cấu hình

Mặc định: runtime ở `~/.local/share/pi-platform`, main agent ở `~/.pi/agent`, launcher ở `~/.local/bin`. Windows dùng các thư mục tương ứng trong user profile.

Installer chỉ quản lý bản cài có `install-state.json` phù hợp. Với root đã có dữ liệu khác, dùng đường dẫn riêng:

```sh
node install.mjs --root /duong-dan/platform --agent-dir /duong-dan/agent --bin-dir /duong-dan/bin --no-path
```

Role, subagents, advisor settings và cấu hình công cụ cùng nằm trong agent directory. Một runtime Pi duy nhất ở `runtimes/current`; Firecrawl CLI ở `tools/firecrawl`.

Khi chạy lại, installer dùng lockfile và checksum để kiểm tính nhất quán; runtime được cài lại khi lockfile hoặc kết quả bản vá đổi, để bản vá luôn áp lên file gốc. Bản runtime và nguồn cũ được chuyển vào `<root>/backups` trong lúc cài và xoá khi cài xong (muốn quay lại thì cài lại commit cũ của repo); 3 lần gỡ tài nguyên gần nhất được giữ lại, bản sao file cấu hình trước khi ghi đè giữ 20 bản mới nhất cho mỗi file.

File JSON cấu hình trong agent directory, kể cả `settings.json` mà Pi ghi lại khi đổi model hay thinking, được gộp ba chiều với mặc định của lần cài trước (lưu ở `<root>/state/defaults`):
- Giá trị bạn chưa đổi nhận mặc định mới; giá trị bạn đã đổi được giữ. Nếu mặc định mới cũng đổi chính giá trị đó, installer giữ của bạn và báo xung đột kèm mặc định mới.
- Danh sách của `settings.json` (`permissions.allow/ask/deny`, `enabledModels`, `skills`, `themes`, `prompts`, `extensions`, `packages`) gộp theo từng mục: mục bạn thêm hoặc bỏ và loại trừ extension `-` được giữ, mục mặc định mới được thêm, `pi-auto-mode` luôn nạp sau cùng.
- Bản cài chưa lưu mặc định (trước khi có cơ chế này): file chưa sửa nhận mặc định mới như trước; file đã sửa lần đầu chỉ được thêm khóa và mục còn thiếu, mọi giá trị hiện có được giữ và giá trị khác mặc định mới được báo.
- File role `agents/*.md` cũng được gộp: mỗi khóa frontmatter (`model`, `thinking`, `tools`...) là một giá trị, phần prompt là một giá trị. Sửa một dòng không làm file đứng yên; prompt mới vẫn vào được.
- Installer in phần đã gộp và từng xung đột, backup file trước khi ghi lại; lần chạy không có gì mới thì không ghi gì.

Model và thinking của từng vai nằm thẳng trong các file trên (`settings.json`, `advisor.json`, `agents/*.md`) và được gộp như mọi giá trị khác. `model-roles.json` của bản trước được chuyển vào backups ở lần cài đầu sau khi nâng cấp, giữ model đang chạy ([docs/models.md](docs/models.md#chuyển-từ-model-rolesjson)).

File khác đã tùy chỉnh (`AGENTS.md`) được giữ và báo đường dẫn. Tài nguyên do installer quản lý, không còn được yêu cầu và chưa chỉnh sửa, được lưu vào backup; tài nguyên còn được cấu hình tham chiếu được giữ. Auth và file riêng của người dùng không thuộc danh sách tài nguyên được dọn.

`npm ci` của installer được tối đa 30 phút (lệnh khác 10 phút). Mạng tới registry npm chậm thì tăng bằng `PI_CONFIG_NPM_TIMEOUT_MINUTES`, ví dụ `PI_CONFIG_NPM_TIMEOUT_MINUTES=60 node install.mjs` (PowerShell: `$env:PI_CONFIG_NPM_TIMEOUT_MINUTES=60`); chạy lại cũng nhanh hơn vì gói đã tải nằm trong cache của npm.

Dừng các phiên Pi trước khi cập nhật. Dùng revision đã qua CI thay vì chạy `pi update` hoặc `npm update` trên runtime ghim. `.install.lock` còn sót từ lần cài bị ngắt được installer tự gỡ khi tiến trình ghi trong đó đã dừng; tiến trình còn chạy thì báo PID.

## Phát triển và kiểm thử

```sh
npm run check
npm test
npm run smoke
```

CI chạy trên Ubuntu và macOS (Windows không còn trong CI, xem [docs/platforms.md](docs/platforms.md)): kiểm repo, cấu hình, request payload, cài sạch, các lệnh slash và Agent trong cùng phiên bằng provider giả, cài lại gộp mặc định mới mà vẫn giữ tùy chỉnh, và bootstrap với đường dẫn có khoảng trắng. Bản vá file `.ts` không được thêm lỗi kiểu: smoke biên dịch source đã vá và bản gốc (dựng lại bằng cách đảo bản vá, kiểm `originalSha256`) bằng TypeScript ghim riêng (`manifests/typecheck`, chỉ cài khi kiểm thử, không nằm trong runtime) trên type của Pi đã cài. Test không dùng credential thật hoặc gọi model trả phí. Đây là kiểm chứng runtime và bộ cài; chất lượng model và quyền truy cập tài khoản được đánh giá riêng.

Nguồn và giấy phép: [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md). Mã riêng của dự án dùng [MIT](LICENSE).
