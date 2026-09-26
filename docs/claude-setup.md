# Claude và native web search

## Đăng nhập và model

Parent mặc định là **Claude Opus 5.5/high** (`anthropic/claude-opus-5-5`, context 1M của catalog). Chạy `pi-login`, dùng `/login` và chọn **Anthropic** để đăng nhập gói Claude Pro/Max (OAuth), hoặc cung cấp `ANTHROPIC_API_KEY`. Vòng `Ctrl+P` gồm Opus 5.5, GPT-6 Sol, GPT-6 Astra và GLM; worker/debugger/reviewer vẫn cần đăng nhập OpenAI Codex.

Tài liệu Claude Code ghi OAuth của gói Pro/Max dành cho Claude Code và ứng dụng native của Anthropic, và Anthropic có thể thực thi giới hạn này không báo trước. Nếu Claude không dùng được, chọn model khác bằng `/model`; role của Agent không phụ thuộc Claude. Bộ phân loại của auto mode chạy Claude Sonnet 5 qua cùng đăng nhập; khi Sonnet 5 lỗi, nó dùng model của phiên, nên sau khi đổi `/model` sang model Codex thì auto mode duyệt được tiếp.

`@gotgenes/pi-anthropic-auth` 3.2.2 shape request OAuth (billing header, system prompt) cho mọi request đi qua provider `anthropic`, và tự thử lại khi Anthropic yêu cầu phiên bản Claude Code mới hơn. Cảnh báo extra usage của Pi vẫn bật (`warnings.anthropicExtraUsage`): request Claude không qua shaping có thể bị tính vào extra usage.

## Mức thinking (effort)

Opus 5.5 không tắt được thinking; `/thinking` (Alt+T) đổi effort `low`…`max`. Pi gửi effort theo lượt bằng một system message rỗng chỉ có `output_config`, và pi-anthropic-auth bỏ message rỗng khi shape request OAuth, nên mọi mức đều thành `high`. Bản vá trong [assets/patches.json](../assets/patches.json) đưa mức hiện tại vào `output_config.effort` của request. Đổi mức thinking giữa phiên làm mất prompt cache một lần. Với API key, request không qua shaping và giữ cơ chế gốc của Pi.

## Quota trong footer và `/claude-usage`

pi-usage chưa hỗ trợ Anthropic nên pi-config có extension `claude-usage`:

- Footer hiển thị phần trăm **còn lại** của phiên 5 giờ và của tuần, kèm đếm ngược tới reset, cùng kiểu với quota Codex, ví dụ `77% ↻ 2h10m 59% ↻ 4d3h`. `extra` nghĩa là request đang dùng extra usage; `limit` nghĩa là đã chạm giới hạn gói.
- Footer cập nhật từ header `anthropic-ratelimit-unified-*` của chính các phản hồi Claude qua OAuth, không tốn request. Footer ẩn khi chuyển sang model khác.
- Ngoài ra extension tự đọc `GET https://api.anthropic.com/api/oauth/usage` (endpoint Claude Code dùng, chưa công bố) bằng token OAuth khi mở phiên hoặc chuyển sang Claude, nên footer có số liệu ngay, không chờ phản hồi Claude đầu tiên.
  - Sau đó đọc lại 15 phút một lần, nhưng chỉ khi header gần nhất đã cũ hơn 15 phút: lúc đang làm việc, header đủ dùng nên hầu như không có request thêm.
  - Endpoint trả 429 thì khoảng chờ tăng lên 30 rồi 60 phút (theo `Retry-After` nếu có, tối đa 60 phút) và footer giữ số liệu cũ; đọc được thì về lại 15 phút.
  - Chỉ phiên có UI (TUI, RPC) mới đọc. Agent con, chế độ print, model khác Claude và đăng nhập bằng API key (không có quota gói) thì không.
- `/claude-usage` đọc endpoint đó ngay khi gọi và in thêm giới hạn tuần theo model và extra usage. Nếu endpoint trả 429, lệnh dùng dữ liệu gần nhất.

## Native web search

`web_search` (pi-web-access 0.31.0) định tuyến `["openai", "anthropic", "exa", "firecrawl"]` với `useCurrentModel: true`; mô tả tool ghi "OpenAI, Anthropic, Exa, Firecrawl":

| Model hiện tại | Cách tìm |
|---|---|
| Codex/OpenAI trên endpoint chính thức (Astra, Sol) | `openai`: hosted `web_search` của Responses API, dùng chính model và auth Codex |
| Claude của provider `anthropic` trên `api.anthropic.com` | `anthropic`: server tool `web_search_20250305` của Anthropic, tối đa 5 lượt tìm mỗi lần gọi |
| Model khác (GLM, gateway, Claude qua provider khác) | Exa (endpoint MCP miễn phí, không cần key; đặt `EXA_API_KEY` để dùng API có key), rồi Firecrawl |

`anthropic` là provider do bản vá pi-web-access thêm vào. Mã nằm ở [assets/patches/pi-web-access/anthropic-search.js](../assets/patches/pi-web-access/anthropic-search.js); installer chèn nguyên file vào `dist/index.js` và kiểm SHA256 kết quả ([assets/patches.json](../assets/patches.json)). Tìm kiếm Claude là một request phụ theo cách WebSearch của Claude Code (prompt viết riêng), đi qua transport Anthropic của Pi nên dùng cùng auth và shaping OAuth. Model không tắt được thinking (Opus 5.x, Fable) tìm với effort `low`; model khác tắt thinking. Nguồn và trích dẫn được đọc từ luồng SSE rồi trả về như kết quả pi-web-access (`**Provider:** anthropic`).

Muốn phiên chạy model khác (ví dụ researcher GLM) cũng tìm bằng Claude, thêm vào `web-search.json` rồi mở lại Pi. Tuỳ chọn này tắt mặc định vì tốn quota Claude:

```json
"anthropicSearch": { "modelForNonClaude": "anthropic/claude-sonnet-5" }
```

Model phải là Claude chính thức và đã đăng nhập Anthropic; phiên đang dùng Claude vẫn tìm bằng chính model đó.

Lỗi mạng, lỗi tạm thời, quota, phản hồi không hợp lệ hoặc tài khoản không hỗ trợ web search chuyển sang provider kế tiếp (Exa, rồi Firecrawl). Lỗi xác thực và request sai được báo lại. `webSearch.allowedProviders` chỉ cho phép `openai`, `anthropic`, `exa` và `firecrawl`; `fetch_content` luôn dùng Firecrawl. Phiên mới chỉ hiện `web_enable`; model gọi tool này để bật các web tool.

## Nâng cấp bản cài cũ

Installer gộp mặc định mới vào các file JSON cấu hình (`settings.json`, `web-search.json`, `subagents.json`...) và in phần đã gộp; giá trị bạn đã đổi được giữ (xem [README](../README.md#quản-lý-cấu-hình)). Khi mặc định mới đổi đúng giá trị bạn đã đổi, installer báo `xung đột` kèm mặc định mới. Lần cài đầu từ bản chưa lưu mặc định (`<root>/state/defaults`), file đã sửa chỉ được thêm khóa và mục còn thiếu: giá trị cũ khác mặc định mới được giữ và báo xung đột; khóa và mục cũ không còn trong mặc định mới được giữ mà không báo. Đối chiếu với cấu hình mới:

- Model/thinking của mọi vai sinh từ `model-roles.json` ([models.md](models.md)); model bạn đã sửa trong `agents/*.md` được chuyển vào file này ở lần cài đầu. Chỉ có tài khoản Claude thì chọn `"preset": "claude"`.
- `settings.json`: `enabledModels` và `extensions` gộp theo mục (`claude-usage` được thêm, `pi-auto-mode` luôn nạp sau cùng). Xoá `<root>/assets/extensions/native-web-search` nếu còn: search Claude nay nằm trong bản vá pi-web-access.
- `agents/*.md` và `subagents.json`: `max_turns: 0`, `pi-usage` trong `extensions` của worker/debugger. File role được gộp theo từng khóa frontmatter, phần prompt là một giá trị.
- `web-search.json`: `searchRouting.providers` và `webSearch.allowedProviders` là `openai`, `anthropic`, `exa`, `firecrawl`; bỏ `provider: "firecrawl"`. Thiếu `anthropic` thì phiên Claude tìm bằng Exa.

`AGENTS.md` đã sửa vẫn được giữ nguyên và in đường dẫn: đổi tên file rồi chạy lại installer để nhận bản mới, sau đó chép lại phần tùy chỉnh cần giữ. `pi-doctor` in model thật của từng vai, cảnh báo vai lệch so với `model-roles.json`, cảnh báo khi `settings.json` còn `native-web-search` hoặc `web-search.json` thiếu `anthropic`, và báo lỗi khi `searchRouting.providers` có provider không nằm trong `webSearch.allowedProviders` (pi-web-access khi đó không nạp web tools). `web_enable` là safe tool của pi-auto-mode nên không cần luật `allow`.

## Chi phí và giới hạn

- Gói Claude hoặc ChatGPT tính lượt tìm vào quota của gói. Với API key, Anthropic tính phí mỗi lượt tìm cộng token của kết quả.
- Request phụ không nằm trong token/cost của footer; kết quả web chỉ vào context qua tool result.
- `pause_turn` từ Anthropic trả kết quả hiện có kèm ghi chú chưa đầy đủ.
- Kiểm thử: `tests/native-search.test.mjs`, `tests/patches.test.mjs`, `tests/claude-usage.test.mjs` (unit), `tests/native-search-wire.test.mjs`, `tests/claude-effort-wire.test.mjs` và `tests/profile-integration.mjs` (runtime đã cài, fetch giả, credential giả).
