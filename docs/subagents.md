# Agent theo công việc

Pi dùng tool `Agent` của `@tintinweb/pi-subagents` 0.19.0. Parent Claude Opus 5.5/high phân tích yêu cầu, chốt thiết kế, chia việc và nghiệm thu.

| Role | Model/effort (mặc định) | Quyền và trách nhiệm |
|---|---|---|
| `researcher` | Claude Sonnet 5.5/high | Khảo sát code/docs/log, lịch sử git và web (`web_search`, `fetch_content`); chỉ đọc (bash cho lệnh đọc như `git log`, `rg`, `jq`) và trả bằng chứng |
| `worker` | Claude Opus 5.5/high | Triển khai phần việc đã chốt hoặc sửa lỗi (tái hiện, tìm nguyên nhân, sửa, kiểm hồi quy); sửa file và kiểm thử |
| `reviewer` | Claude Fable 5.1/high | Review độc lập, chỉ đọc; bash để chạy `git diff`, test sẵn có và script thử trong `/tmp` |

Claude dùng context của catalog; model Codex (Astra, Sol) của `openai-codex` nâng lên 872K khi một vai dùng chúng; `openai/…` (Sign in with ChatGPT) dùng 272K của catalog Pi. File role nằm trong `agents/` của Pi. Đổi model/thinking của role trong `/agents` → Agent types → chọn role → Model/Thinking ([models.md](models.md)); cài lại giữ giá trị đã đổi. `pi-doctor` in model/thinking đang có hiệu lực của từng role và kiểm trong catalog.

## Giao việc

```text
@researcher Tìm luồng xử lý timeout và báo file/dòng.
@worker Thêm cơ chế retry theo thiết kế đã chốt, chạy test liên quan.
@worker Tái hiện lỗi reconnect, sửa và thêm regression test.
@reviewer Review diff, nêu lỗi có bằng chứng và mức nghiêm trọng.
```

Parent có thể gọi `Agent` với `subagent_type` tương ứng. Mỗi prompt giao việc cần mục tiêu, phạm vi file, ràng buộc và tiêu chí nghiệm thu. Researcher chuyển quyết định kiến trúc hoặc yêu cầu chưa rõ về parent.

Model/thinking ghim trong file role được ưu tiên hơn tham số tool. Model trong file role không dùng được thì pi-subagents lặng lẽ chạy role đó bằng model của parent; `pi-doctor` kiểm model trong catalog của Pi để bắt lỗi này, và danh sách Agent types của `/agents` đánh dấu `(unavailable, fallback: inherit)`. Chọn role theo công việc và kiểm model thực trong kết quả khi tùy chỉnh cấu hình.

`/agents` quản lý agent, kể cả đổi model/thinking của từng agent (bản vá: Model chọn trong catalog có ô tìm, Thinking chỉ các mức model hỗ trợ; chỉ ghi hai dòng đó của file); `get_subagent_result` lấy kết quả; `steer_subagent` gửi bổ sung theo ID. Khi mở rộng (`Ctrl+O`), kết quả của `Agent`, thông báo completion và `get_subagent_result` hiện dạng Markdown (tiêu đề, danh sách, code, bảng); dạng thu gọn, lỗi và agent đang chạy giữ văn bản thô như trước. Đây là bản vá `src/index.ts` của pi-subagents, chỉ đổi phần hiển thị, không đổi nội dung trả cho model.

Gõ `@role nội dung` ở prompt để giao việc thẳng cho role; agent đang chạy thì nhận tin nhắn đó. Agent khởi động ngay, task là đúng nội dung bạn gõ, không gọi model parent (`agentMentions: "direct"`). Agent không thấy hội thoại, nên nội dung cần tự đủ ý. Agent khởi động từ mention luôn chạy nền, kể cả worker, và kết quả về parent qua thông báo completion. Lời gọi `Agent` của mention không qua bộ phân loại vì chính người dùng đã gõ `@role`; agent con vẫn có cổng permission của role.

## Context và thực thi

Role dùng `inherit_context:false`, `prompt_mode:replace`, `isolated:false` và `persist_session:true`. Worker nhận prompt riêng; auth và cổng permission `pi-auto-mode` được giữ (role liệt kê `pi-auto-mode` trong `extensions`).

Role không giới hạn số lượt (`max_turns: 0` trong file role, `defaultMaxTurns: 0`); giá trị trong role thắng tham số `max_turns` của tool. Agent chạy tới khi xong; dừng bằng `/agents` → chọn agent → `x` hai lần (Esc dừng lời gọi foreground đang chờ). Parent theo dõi và dùng `steer_subagent` khi agent lạc hướng.

`backgroundByDefault:true`: researcher và reviewer chạy nền, lời gọi `Agent` trả ID ngay, thông báo completion mở lượt mới cho parent kèm trích đoạn kết quả; `get_subagent_result` lấy toàn văn. Worker ghim `run_in_background: false` nên luôn chạy foreground và trả kết quả ngay trong tool call; parent không đổi được. Background tối đa 4 agent, foreground tối đa 2; vượt giới hạn thì xếp hàng. Nhiều lời gọi `Agent` foreground trong cùng một lượt chạy song song; các phiên Pi quản lý pool riêng.

Codex fast mode (`service_tier: "priority"`) áp dụng cho request của model `openai-codex` (legacy: GPT-6.1 Sol, GPT-6 Astra, GPT-6 Sol) khi một vai dùng chúng; model `openai/…` qua Sign in with ChatGPT không có fast. Bản vá pi-usage bọc `ModelRuntime` dùng chung của phiên chính, nên request không đi qua hook của phiên (advisor, agent con) cũng theo cài đặt fast và chọn hàng theo model của chính request. Worker và reviewer nạp `pi-usage` để chi phí của request fast được tính đúng; bản vá bỏ truy vấn quota và timer của pi-usage trong phiên không có UI.

Researcher nạp `pi-web-access`. Package này khai extension là thư mục `./dist`; bản vá pi-subagents cho entry thư mục khớp tên package, nếu không `extensions`/`ext:pi-web-access` của role không nạp được web tools.

## Quyền và nghiệm thu

Researcher và reviewer không có write/edit; shell của chúng dành cho lệnh đọc, chạy test và thu bằng chứng, và vẫn qua cổng permission. Worker dùng shell, write và edit qua cổng permission; chỉ commit khi brief cho phép rõ. Child dùng mode (manual/auto/bypass) của phiên gốc; bộ phân loại của child lấy tin nhắn của người dùng ở phiên gốc làm ý định, coi task do parent viết là không phải lời người dùng. Khi cần hỏi (luật ask, chạm giới hạn chặn, câu hỏi của manual mode), câu hỏi hiện ở UI của phiên gốc. Trong auto và manual mode, `Agent` với `isolated:true` hoặc danh sách extension thiếu `pi-auto-mode` bị chặn vì child sẽ chạy không có cổng.

Parent cần tránh giao trùng việc hoặc để nhiều writer sửa chồng file. Dùng ID của agent đang chạy để lấy kết quả hay điều chỉnh; parent kiểm evidence và test trước khi kết luận.

Khi gặp blocker quyền/auth/quota, báo nguyên nhân và giữ ranh giới đã được duyệt. Permission là lớp kiểm soát công cụ, không phải OS sandbox.

Project có thể override role. Với `scopeModels:true`, lựa chọn ngoài scope từ tham số tool bị chặn; model ghim trong role ngoài scope sẽ cảnh báo nhưng vẫn được dùng. Cần xem lại role và model thực khi trust hoặc tùy chỉnh project.

## Kiểm thử

`pi-test` hoặc `tests/agent-integration.mjs <root>` dùng provider giả và chặn mạng để kiểm model/effort thực, context, quyền, web tools của researcher, fast mode trong request của worker/reviewer, shell chỉ đọc của researcher, reviewer không ghi được file, advisor, agent chạy quá 14 lượt, role không tồn tại và completion. Các test request payload kiểm provider OpenCode Go trên SDK đã ghim. Nghiệm thu chất lượng model trên công việc thật là bước riêng với ngân sách cụ thể.
