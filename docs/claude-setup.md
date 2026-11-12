# Claude và native web search

## Đăng nhập và model

Parent mặc định là **Claude Opus 5.5/high** (`anthropic/claude-opus-5-5`, context 1M của catalog). Chạy `pi`, dùng `/login` và chọn **Anthropic** để đăng nhập gói Claude Pro/Max (OAuth), hoặc cung cấp `ANTHROPIC_API_KEY`. Vòng `Ctrl+P` gồm model của các vai (Opus 5.5, Fable 5.1, Sonnet 5.5); muốn dùng GPT thì `/login` → **OpenAI** → **Sign in with ChatGPT** (xem [README](../README.md#đăng-nhập-dịch-vụ)).

Tài liệu Claude Code ghi OAuth của gói Pro/Max dành cho Claude Code và ứng dụng native của Anthropic, và Anthropic có thể thực thi giới hạn này không báo trước. Nếu Claude không dùng được, chọn model khác bằng `/model`; role của Agent mặc định cũng là Claude, đổi trong `/agents`. Bộ phân loại của auto mode chạy Claude Sonnet 5.5 qua cùng đăng nhập; khi Sonnet 5.5 lỗi, nó dùng model của phiên, nên sau khi đổi `/model` sang model GPT (vd `openai/gpt-6.1-sol` qua Sign in with ChatGPT) thì auto mode duyệt được tiếp.

`@gotgenes/pi-anthropic-auth` 3.4.4 shape request OAuth (billing header, system prompt) cho mọi request đi qua provider `anthropic`, và tự thử lại khi Anthropic yêu cầu phiên bản Claude Code mới hơn. pi-config tắt cảnh báo extra usage lúc khởi động của Pi (`warnings.anthropicExtraUsage: false`), vì phiên chính, compaction và extension gọi qua `ctx.modelRegistry.streamSimple()` đều đi qua shaping; extension gọi thẳng `compat.streamSimple` của pi-ai thì không, và request đó có thể bị tính vào extra usage. Bật lại trong `/settings` → Warnings.

## Message threads

Pi 1.5.1 bật message threads cho provider `anthropic` trên `api.anthropic.com`, và pi-config giữ mặc định đó. Request đầu của phiên là request đầy đủ đã qua shaping OAuth, kèm `thread: {type: "create"}`. Các lượt sau chỉ gửi tin nhắn mới kèm `thread: {type: "continue"}` và bỏ `system`, `tools`: server giữ bản của lượt đầu, nên billing header không nằm trong body của các lượt đó.

Kiểm ngày 10/11/2026 bằng một phiên thật hai lượt (Opus 5.5, pi-anthropic-auth 3.4.4): lượt `continue` trả 200 ngay lần đầu, model nhớ nội dung lượt trước, và header `anthropic-ratelimit-unified-*` giống hệt lượt đầy đủ (cùng `representative-claim`, extra usage đang bị từ chối ở cấp tổ chức mà request vẫn qua). Tức là lượt `continue` được chấp nhận và tính vào gói; phép thử không cho biết quota được tính nặng hay nhẹ hơn.

- Khi `system` hay `tools` đổi (đổi model, compaction, pi-anthropic-auth đổi phiên bản trong billing header), Pi tự mở thread mới bằng một request đầy đủ.
- Server từ chối trường `thread` thì Pi gửi lại request đầy đủ và tắt threads cho phiên đó.
- Bộ phân loại của auto mode là request một lượt nên không tạo thread (`disableContinuation` trong `lib/completion.ts`); body của nó giống hệt trước, chỉ header `anthropic-beta` có thêm beta của threads.
- Tắt hẳn: tạo `~/.pi/agent/models.json` với `{ "providers": { "anthropic": { "compat": { "supportsMessageThreads": false } } } }`; khi đó request giống hệt Pi 1.5.0. Installer không sinh file này và giữ nguyên file bạn tự viết.

Pi 1.5.1 cũng đổi mặc định `cacheWarming` sang `"idle"` (làm mới cache tới 30 phút sau khi agent dừng). pi-config vẫn đặt `"cacheWarming": "off"` nên không bị ảnh hưởng.

## Mức thinking (effort)

Opus 5.5 không tắt được thinking; `/thinking` (Alt+T) đổi effort `low`…`max`. Pi ghim `output_config.effort` của request ở `low` (từ Pi 1.5.0; theo chú thích trong pi-ai, mức này thuộc prompt được cache nên cố định, và để thấp vì tổ chức có thể đặt trần effort) và gửi effort theo lượt bằng một system message rỗng chỉ có `output_config`; từ 3.3.2, pi-anthropic-auth giữ message đó khi shape request OAuth, nên mức `/thinking` của phiên có hiệu lực mà không cần bản vá (`tests/claude-effort-wire.test.mjs` kiểm điều này). Đổi mức thinking giữa phiên làm mất prompt cache một lần. Với API key, request không qua shaping và giữ cơ chế gốc của Pi.

## Quota trong footer và `/claude-usage`

pi-config có extension `claude-usage`:

- Footer hiển thị phần trăm **còn lại** của phiên 5 giờ và của tuần, kèm đếm ngược tới reset, ví dụ `77% ↻ 2h10m 59% ↻ 4d3h`. `extra` nghĩa là request đang dùng extra usage; `limit` nghĩa là đã chạm giới hạn gói.
- Footer cập nhật từ header `anthropic-ratelimit-unified-*` của chính các phản hồi Claude qua OAuth, không tốn request. Footer ẩn khi chuyển sang model khác.
- Ngoài ra extension tự đọc `GET https://api.anthropic.com/api/oauth/usage` (endpoint Claude Code dùng, chưa công bố) bằng token OAuth khi mở phiên hoặc chuyển sang Claude, nên footer có số liệu ngay, không chờ phản hồi Claude đầu tiên.
  - Sau đó đọc lại 15 phút một lần, nhưng chỉ khi header gần nhất đã cũ hơn 15 phút: lúc đang làm việc, header đủ dùng nên hầu như không có request thêm.
  - Endpoint trả 429 thì khoảng chờ tăng lên 30 rồi 60 phút (theo `Retry-After` nếu có, tối đa 60 phút) và footer giữ số liệu cũ; đọc được thì về lại 15 phút.
  - Chỉ phiên có UI (TUI, RPC) mới đọc. Agent con, chế độ print, model khác Claude và đăng nhập bằng API key (không có quota gói) thì không.
- `/claude-usage` đọc endpoint đó ngay khi gọi và in thêm giới hạn tuần theo model và extra usage. Nếu endpoint trả 429, lệnh dùng dữ liệu gần nhất.

## Native web search

`web_search` (pi-web-access 0.47.0) định tuyến `["openai", "anthropic", "exa"]` với `useCurrentModel: true`:

| Model hiện tại | Cách tìm |
|---|---|
| GPT trên endpoint chính thức (Astra, Sol): `openai` qua Sign in with ChatGPT, hoặc `openai-codex` | `openai`: hosted `web_search` của Responses API (`api.openai.com` hoặc endpoint Codex), dùng chính model và token đã đăng nhập |
| Claude của provider `anthropic` trên `api.anthropic.com` | `anthropic`: server tool `web_search_20250305` của Anthropic, tối đa 5 lượt tìm mỗi lần gọi |
| Model khác (GLM, gateway, Claude qua provider khác) | Exa (endpoint MCP miễn phí, không cần key; đặt `EXA_API_KEY` để dùng API có key) |

`anthropic` là provider do bản vá pi-web-access thêm vào. Mã nằm ở [assets/patches/pi-web-access/anthropic-search.js](../assets/patches/pi-web-access/anthropic-search.js); installer chèn nguyên file vào `dist/index.js` và kiểm SHA256 kết quả ([assets/patches.json](../assets/patches.json)). Tìm kiếm Claude là một request phụ theo cách WebSearch của Claude Code (prompt viết riêng), đi qua transport Anthropic của Pi nên dùng cùng auth và shaping OAuth. Model không tắt được thinking (Opus 5.x, Fable) tìm với effort `low`; model khác tắt thinking. Nguồn và trích dẫn được đọc từ luồng SSE rồi trả về như kết quả pi-web-access (`**Provider:** anthropic`).

Muốn phiên chạy model khác (ví dụ researcher GLM) cũng tìm bằng Claude, thêm vào `web-search.json` rồi mở lại Pi. Tuỳ chọn này tắt mặc định vì tốn quota Claude:

```json
"anthropicSearch": { "modelForNonClaude": "anthropic/claude-sonnet-5-5" }
```

Model phải là Claude chính thức và đã đăng nhập Anthropic; phiên đang dùng Claude vẫn tìm bằng chính model đó.

Lỗi mạng, lỗi tạm thời, quota, phản hồi không hợp lệ hoặc tài khoản không hỗ trợ web search chuyển sang Exa; Exa lỗi thì lỗi được báo lại, không còn provider nào sau nó. Lỗi xác thực và request sai được báo lại. `webSearch.allowedProviders` chỉ cho phép `openai`, `anthropic` và `exa`. `fetch_content` theo thứ tự mặc định của pi-web-access (không khai báo `fetchRouting`): tải thẳng trang đích và trích nội dung tại chỗ. pi-config không cấu hình dịch vụ trích xuất nào, nên không trang nào được gửi qua bên thứ ba và trang dựng bằng JavaScript có thể trả về ít nội dung; bước dự phòng Firecrawl hoặc crawl4ai của thứ tự đó chỉ chạy khi bạn tự đặt base URL của chúng (`firecrawlBaseUrl`/`FIRECRAWL_BASE_URL`, `crawl4aiBaseUrl`/`CRAWL4AI_BASE_URL`), dịch vụ hosted như Jina chỉ khi bạn bật `fetchRouting.allowRemoteHostedProviders`. Phiên mới chỉ hiện `web_enable`; model gọi tool này để bật các web tool.

## Chi phí và giới hạn

- Gói Claude hoặc ChatGPT tính lượt tìm vào quota của gói. Với API key, Anthropic tính phí mỗi lượt tìm cộng token của kết quả.
- Request phụ không nằm trong token/cost của footer; kết quả web chỉ vào context qua tool result.
- `pause_turn` từ Anthropic trả kết quả hiện có kèm ghi chú chưa đầy đủ.
- Kiểm thử: `tests/native-search.test.mjs`, `tests/patches.test.mjs`, `tests/claude-usage.test.mjs` (unit), `tests/native-search-wire.test.mjs`, `tests/claude-effort-wire.test.mjs` và `tests/config-integration.mjs` (runtime đã cài, fetch giả, credential giả).
