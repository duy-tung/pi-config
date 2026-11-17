# Claude và native web search

## Đăng nhập và model

Parent mặc định là **Claude Opus 5.5/high** (`anthropic/claude-opus-5-5`, context 1M của catalog). Chạy `pi`, dùng `/login` và chọn **Anthropic** để đăng nhập gói Claude Pro/Max (OAuth), hoặc cung cấp `ANTHROPIC_API_KEY`. Vòng `Ctrl+P` gồm model của các vai (Opus 5.5, Fable 5.1, Sonnet 5.5).

Tài liệu Claude Code ghi OAuth của gói Pro/Max dành cho Claude Code và ứng dụng native của Anthropic, và Anthropic có thể thực thi giới hạn này không báo trước. Nếu Claude không dùng được, chọn model khác bằng `/model`; role của Agent mặc định cũng là Claude, đổi trong `/agents`. Bộ phân loại của auto mode chạy Claude Sonnet 5.5 qua cùng đăng nhập; khi Sonnet 5.5 lỗi, nó dùng model của phiên, nên sau khi đổi `/model` sang model của provider khác (vd GLM của OpenCode Go) thì auto mode duyệt được tiếp.

`@gotgenes/pi-anthropic-auth` 3.4.4 shape request OAuth (billing header, system prompt) cho mọi request đi qua provider `anthropic`, và tự thử lại khi Anthropic yêu cầu phiên bản Claude Code mới hơn. pi-config tắt cảnh báo extra usage lúc khởi động của Pi (`warnings.anthropicExtraUsage: false`), vì phiên chính, compaction và extension gọi qua `ctx.modelRegistry.streamSimple()` đều đi qua shaping; extension gọi thẳng `compat.streamSimple` của pi-ai thì không, và request đó có thể bị tính vào extra usage. Bật lại trong `/settings` → Warnings.

## Message threads

Pi 1.5.1 bật message threads cho provider `anthropic` trên `api.anthropic.com`, và pi-config giữ mặc định đó. Request đầu của phiên là request đầy đủ đã qua shaping OAuth, kèm `thread: {type: "create"}`. Các lượt sau chỉ gửi tin nhắn mới kèm `thread: {type: "continue"}` và bỏ `system`, `tools`: server giữ bản của lượt đầu, nên billing header không nằm trong body của các lượt đó.

Kiểm ngày 10/11/2026 bằng một phiên thật hai lượt (Opus 5.5, pi-anthropic-auth 3.4.4): lượt `continue` trả 200 ngay lần đầu, model nhớ nội dung lượt trước, và header `anthropic-ratelimit-unified-*` giống hệt lượt đầy đủ (cùng `representative-claim`, extra usage đang bị từ chối ở cấp tổ chức mà request vẫn qua). Tức là lượt `continue` được chấp nhận và tính vào gói; phép thử không cho biết quota được tính nặng hay nhẹ hơn.

- Khi `system` hay `tools` đổi (đổi model, compaction, pi-anthropic-auth đổi phiên bản trong billing header), Pi tự mở thread mới bằng một request đầy đủ.
- Server từ chối trường `thread` thì Pi gửi lại request đầy đủ và tắt threads cho phiên đó.
- Bộ phân loại của auto mode là request một lượt nên không tạo thread (`disableContinuation` trong `lib/completion.ts`); body của nó giống hệt trước, chỉ header `anthropic-beta` có thêm beta của threads.
- Tắt hẳn: tạo `~/.pi/agent/models.json` với `{ "providers": { "anthropic": { "compat": { "supportsMessageThreads": false } } } }`; khi đó request giống hệt Pi 1.5.0. Installer không sinh file này và giữ nguyên file bạn tự viết.

## Giữ ấm prompt cache

pi-config đặt `"cacheWarming": "idle"`, mặc định của Pi từ 1.5.1. Prompt cache của Anthropic hết hạn sau 5 phút không dùng; lượt kế tiếp khi đó ghi lại toàn bộ context với giá ghi cache thay vì giá đọc. Với `idle`:

- Pi gửi lại request cuối với 1 token output khoảng 4,5 phút một lần khi phiên nghỉ, tối đa 30 phút sau khi agent dừng. Request này chỉ đọc cache và không vào hội thoại; usage của nó được cộng vào tổng của phiên.
- Pi chỉ gửi khi ước tính có lợi (ít nhất 0,05 USD theo giá của model). Với context nhỏ nó tự dừng.
- Request đi qua `ModelRuntime` nên qua shaping OAuth như lượt thường, và tính vào quota của gói Claude.

Kiểm ngày 15/11/2026 bằng một phiên thật qua Claude OAuth (Pi 1.5.2, chế độ RPC, context khoảng 87 nghìn token): request giữ ấm chạy ở giây 273 và đọc đủ cache; lượt kế tiếp sau 6 phút 40 giây nghỉ đọc đủ cache và chỉ ghi 17 token.

Nghỉ quá 30 phút thì cache vẫn mất. Đặt `PI_CACHE_RETENTION=long` (cache 1 giờ, giá ghi gấp 2 lần input) thì Pi không gửi request giữ ấm nào, vì lần làm mới kế tiếp rơi ngoài giới hạn 30 phút; hai cách chỉ chọn một. Tắt giữ ấm bằng `"cacheWarming": "off"` trong `settings.json`; cài lại giữ giá trị bạn đã đổi.

## Mức thinking (effort)

Opus 5.5 không tắt được thinking; `/thinking` (Shift+Tab hoặc Alt+T) đổi effort `low`…`max`. Pi ghim `output_config.effort` của request ở `low` (từ Pi 1.5.0; theo chú thích trong pi-ai, mức này thuộc prompt được cache nên cố định, và để thấp vì tổ chức có thể đặt trần effort) và gửi effort theo lượt bằng một system message rỗng chỉ có `output_config`; từ 3.3.2, pi-anthropic-auth giữ message đó khi shape request OAuth, nên mức `/thinking` của phiên có hiệu lực mà không cần bản vá (`tests/claude-effort-wire.test.mjs` kiểm điều này). Đổi mức thinking giữa phiên làm mất prompt cache một lần. Với API key, request không qua shaping và giữ cơ chế gốc của Pi.

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

`web_search` (pi-web-access 0.47.0) định tuyến `["anthropic"]` với `useCurrentModel: true`, không có provider dự phòng:

| Model hiện tại | Cách tìm |
|---|---|
| Claude của provider `anthropic` trên `api.anthropic.com` | `anthropic`: server tool `web_search_20260209` của Anthropic, gọi thẳng (`allowed_callers: ["direct"]`), tối đa 5 lượt tìm mỗi lần gọi |
| Model khác (GLM, gateway, Claude qua provider khác) | Không tìm được: `web_search` báo không có provider nào dùng được. Đặt `anthropicSearch.modelForNonClaude` (bên dưới) để tìm bằng Claude |

`anthropic` là provider do bản vá pi-web-access thêm vào. Mã nằm ở [assets/patches/pi-web-access/anthropic-search.js](../assets/patches/pi-web-access/anthropic-search.js); installer chèn nguyên file vào `dist/index.js` và kiểm SHA256 kết quả ([assets/patches.json](../assets/patches.json)). Tìm kiếm Claude là một request phụ theo cách WebSearch của Claude Code (prompt viết riêng), đi qua transport Anthropic của Pi nên dùng cùng auth và shaping OAuth. Model không tắt được thinking (Opus 5.x, Fable) tìm với effort `low`; model khác tắt thinking. Nguồn và trích dẫn được đọc từ luồng SSE rồi trả về như kết quả pi-web-access (`**Provider:** anthropic`).

Muốn phiên chạy model khác (ví dụ researcher GLM) cũng tìm bằng Claude, thêm vào `web-search.json` rồi mở lại Pi. Tuỳ chọn này tắt mặc định vì tốn quota Claude:

```json
"anthropicSearch": { "modelForNonClaude": "anthropic/claude-sonnet-5-5" }
```

Model phải là Claude chính thức và đã đăng nhập Anthropic; phiên đang dùng Claude vẫn tìm bằng chính model đó.

Mọi lỗi của native search (mạng, lỗi tạm thời, quota, phản hồi không hợp lệ, tài khoản không hỗ trợ web search, lỗi xác thực, request sai) được báo lại cho agent; truy vấn không được gửi cho provider nào khác. `webSearch.allowedProviders` chỉ cho phép `anthropic`. Muốn có dự phòng (ví dụ Exa, endpoint MCP miễn phí không cần key), thêm tên provider vào cả `webSearch.allowedProviders` và `searchRouting.providers`; cài lại giữ mục bạn thêm.

Bản `_20260209` mặc định chỉ cho model gọi `web_search` từ code execution để tự lọc kết quả. Lần thử thật ngày 2026-11-17 qua đăng nhập gói Claude: với mặc định đó (Sonnet 5.5), code execution trả `too_many_requests` và không lượt tìm nào chạy; khi cho gọi thẳng (Mythos 5.2), tìm kiếm chạy bình thường. Vì vậy pi-config đặt `allowed_callers: ["direct"]`: dùng bản tool mới nhưng không có bước tự lọc.

## Native web fetch

`fetch_content` theo `fetchRouting.providers: ["http", "anthropic"]`:

| Bước | Khi nào chạy |
|---|---|
| `http` | Luôn chạy trước: Pi tải thẳng trang đích và trích nội dung tại chỗ, không qua bên thứ ba |
| `anthropic` | Khi tải thẳng lỗi (ví dụ 403 vì trang chặn máy bạn) và có model Claude dùng được: server tool `web_fetch_20260209` của Anthropic, gọi thẳng, một lần, tối đa 50.000 token nội dung |

`anthropic` ở đây là provider fetch do cùng bản vá thêm vào. Request phụ chạy bằng `anthropicSearch.fetchModel` (mặc định `anthropic/claude-haiku-5-5`; model đó không dùng được thì theo model của phiên). Vì `fetchModel` là một model Claude cố định, bước này chạy cả khi phiên dùng model khác, miễn là đã đăng nhập Anthropic; bỏ khoá `fetchModel` thì chỉ phiên Claude mới dùng `web_fetch`. Model chỉ gọi tool rồi trả lời "done"; nội dung trang lấy nguyên từ kết quả tool. Lần thử thật ngày 2026-11-17 (Haiku 5.5, một trang nhỏ): 1,5 giây, 2.500 token input.

Giới hạn của `web_fetch`: không chạy JavaScript, không nhận URL dài hơn 250 ký tự, Anthropic từ chối một số domain, và PDF trả về dạng base64 mà provider này không chuyển thành văn bản. Các trường hợp đó được báo lại cùng lỗi của bước tải thẳng. Trang tải bằng `web_fetch` tính token hai lần: trong request phụ, rồi trong context của phiên khi kết quả trả về. Các lời gọi nội bộ của pi-web-access (trang tải kèm `web_search`) không dùng bước này. Không dịch vụ trích xuất nào khác nằm trong thứ tự; muốn dùng một dịch vụ tự host (ví dụ crawl4ai), thêm tên provider vào `fetchRouting.providers` và đặt base URL của nó.

## Chi phí và giới hạn

- Gói Claude tính lượt tìm vào quota của gói. Với API key, Anthropic tính phí mỗi lượt tìm cộng token của kết quả.
- Request phụ không nằm trong token/cost của footer; kết quả web chỉ vào context qua tool result.
- `pause_turn` từ Anthropic trả kết quả hiện có kèm ghi chú chưa đầy đủ.
- Kiểm thử: `tests/native-search.test.mjs`, `tests/patches.test.mjs`, `tests/claude-usage.test.mjs` (unit), `tests/native-search-wire.test.mjs`, `tests/claude-effort-wire.test.mjs` và `tests/config-integration.mjs` (runtime đã cài, fetch giả, credential giả).
