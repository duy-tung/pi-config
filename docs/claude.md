# Claude và native web search

## Đăng nhập và chọn model

Claude là tùy chọn. Chạy `pi-login`, dùng `/login` và chọn **Anthropic** để đăng nhập gói Claude Pro/Max (OAuth), hoặc cung cấp `ANTHROPIC_API_KEY`. Sau khi đăng nhập, chọn model Claude bằng `/model`; vòng `Ctrl+P` vẫn là Astra, Sol và GLM, thêm Claude bằng `/scoped-models` nếu cần.

`@gotgenes/pi-anthropic-auth` 3.2.2 shape request OAuth (billing header, system prompt) cho mọi request đi qua provider `anthropic`, và tự thử lại khi Anthropic yêu cầu phiên bản Claude Code mới hơn. Cảnh báo extra usage của Pi vẫn bật (`warnings.anthropicExtraUsage`): request Claude không qua shaping có thể bị tính vào extra usage.

## Quota trong footer và `/claude-usage`

pi-usage chưa hỗ trợ Anthropic nên pi-config có extension `claude-usage`:

- Footer hiển thị phần trăm **còn lại** của phiên 5 giờ và của tuần, kèm đếm ngược tới reset, cùng kiểu với quota Codex, ví dụ `77% ↻ 2h10m 59% ↻ 4d3h`. `extra` nghĩa là request đang dùng extra usage; `limit` nghĩa là đã chạm giới hạn gói.
- Dữ liệu lấy từ header `anthropic-ratelimit-unified-*` của chính các phản hồi Claude qua OAuth, không gửi thêm request. Footer có số liệu sau phản hồi Claude đầu tiên trong phiên và ẩn khi chuyển sang model khác.
- `/claude-usage` đọc `GET https://api.anthropic.com/api/oauth/usage` (endpoint Claude Code dùng, chưa công bố) để thêm giới hạn tuần theo model và extra usage. Endpoint có thể trả 429; khi đó lệnh dùng dữ liệu header gần nhất. Lệnh chỉ chạy khi người dùng gọi, không tự polling. API key không có quota gói.

## Native web search

`web_search` (pi-web-access 0.31.0) định tuyến `["openai", "firecrawl"]` với `useCurrentModel: true`:

| Model hiện tại | Cách tìm |
|---|---|
| Codex/OpenAI trên endpoint chính thức (Astra, Sol) | Hosted `web_search` của Responses API, dùng chính model và auth Codex |
| Claude của provider `anthropic` trên `api.anthropic.com` | Server tool `web_search_20250305` của Anthropic, tối đa 5 lượt tìm mỗi lần gọi |
| Model khác (GLM, gateway, Claude qua provider khác) | Firecrawl |

Tìm kiếm Claude là một request phụ theo cách WebSearch của Claude Code (prompt viết riêng), đi qua transport Anthropic của Pi nên dùng cùng auth và shaping OAuth. Model không tắt được thinking (Opus 5.x, Fable) tìm với effort `low`; model khác tắt thinking. Nguồn và trích dẫn được đọc từ luồng SSE rồi trả về như kết quả pi-web-access (`**Provider:** anthropic`).

Lỗi mạng, lỗi tạm thời, quota, phản hồi không hợp lệ hoặc tài khoản không hỗ trợ web search chuyển sang Firecrawl. Lỗi xác thực và request sai được báo lại. `webSearch.allowedProviders` chỉ cho phép `openai` và `firecrawl`; `fetch_content` luôn dùng Firecrawl. Phiên mới chỉ hiện `web_enable`; model gọi tool này để bật các web tool.

Cầu nối là extension `native-web-search` cùng bản vá `pi-web-access` trong [assets/patches.json](../assets/patches.json): bước `openai` chấp nhận model Claude và giữ `provider` do kết quả trả về.

## Nâng cấp bản cài cũ

Installer giữ file người dùng đã sửa và in đường dẫn. Nếu `settings.json` hoặc `web-search.json` được giữ nguyên, đối chiếu với cấu hình mới: thêm `<root>/assets/extensions/native-web-search` và `<root>/assets/extensions/claude-usage` vào `extensions`, trước `pi-auto-mode` (extension này phải nạp sau cùng); dùng `searchRouting` và `webSearch` mới, bỏ `provider: "firecrawl"`. Thiếu các phần này thì web search vẫn dùng Firecrawl và footer không có quota Claude. `web_enable` là safe tool của pi-auto-mode nên không cần luật `allow`.

## Chi phí và giới hạn

- Gói Claude hoặc ChatGPT tính lượt tìm vào quota của gói. Với API key, Anthropic tính phí mỗi lượt tìm cộng token của kết quả.
- Request phụ không nằm trong token/cost của footer; kết quả web chỉ vào context qua tool result.
- `pause_turn` từ Anthropic trả kết quả hiện có kèm ghi chú chưa đầy đủ.
- Mô tả tool của pi-web-access vẫn ghi "OpenAI, Firecrawl"; provider thực tế nằm trong kết quả.
- Kiểm thử: `tests/native-search.test.mjs`, `tests/claude-usage.test.mjs` (unit), `tests/native-search-wire.test.mjs` và `tests/profile-integration.mjs` (runtime đã cài, fetch giả, credential giả).
