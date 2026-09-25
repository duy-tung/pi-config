# Agent theo công việc

Pi dùng tool `Agent` của `@tintinweb/pi-subagents` 0.19.0. Parent Claude Opus 5.5/high phân tích yêu cầu, chốt thiết kế, chia việc và nghiệm thu.

| Role | Model/effort (preset `default`) | Quyền và trách nhiệm |
|---|---|---|
| `researcher` | GLM-5.3-Flash/max | Khảo sát code/docs/log và web (`web_search`, `fetch_content`); chỉ đọc và trả bằng chứng |
| `worker` | GPT-6 Sol/max | Triển khai phần việc đã chốt, sửa file và kiểm thử |
| `debugger` | GPT-6 Sol/max | Tái hiện, xác định nguyên nhân, sửa và kiểm hồi quy |
| `reviewer` | GPT-6 Astra/high | Review độc lập, chỉ đọc |

GLM dùng provider `opencode-go` trực tiếp trong Pi. Opus 5.5 và GLM dùng context 1M của catalog; Astra/Sol nâng lên 872K. File role nằm trong `agents/` của Pi; model/thinking của chúng sinh từ `model-roles.json` ([models.md](models.md)). `pi-doctor` in model/thinking thật của từng role, cảnh báo role lệch so với `model-roles.json` và đánh dấu role đã sửa so với bản cài.

## Giao việc

```text
@researcher Tìm luồng xử lý timeout và báo file/dòng.
@worker Thêm cơ chế retry theo thiết kế đã chốt, chạy test liên quan.
@debugger Tái hiện lỗi reconnect và kiểm tra bản sửa.
@reviewer Review diff, nêu lỗi có bằng chứng và mức nghiêm trọng.
```

Parent có thể gọi `Agent` với `subagent_type` tương ứng. Mỗi prompt giao việc cần mục tiêu, phạm vi file, ràng buộc và tiêu chí nghiệm thu. Researcher chuyển quyết định kiến trúc hoặc yêu cầu chưa rõ về parent.

Model/thinking ghim trong file role được ưu tiên hơn tham số tool. Model trong file role không dùng được thì pi-subagents lặng lẽ chạy role đó bằng model của parent; installer, `pi-models` và `pi-doctor` kiểm model trong catalog của Pi để bắt lỗi này. Chọn role theo công việc và kiểm model thực trong kết quả khi tùy chỉnh cấu hình.

`/agents` quản lý agent; `get_subagent_result` lấy kết quả; `steer_subagent` gửi bổ sung theo ID. Khi mở rộng (`Ctrl+O`), kết quả của `Agent`, thông báo completion và `get_subagent_result` hiện dạng Markdown (tiêu đề, danh sách, code, bảng); dạng thu gọn, lỗi và agent đang chạy giữ văn bản thô như trước. Đây là bản vá `src/index.ts` của pi-subagents, chỉ đổi phần hiển thị, không đổi nội dung trả cho model.

Gõ `@role nội dung` ở prompt để giao việc thẳng cho role; agent đang chạy thì nhận tin nhắn đó. Có hai chế độ:
- `"direct"` (mặc định): agent khởi động ngay, task là đúng nội dung bạn gõ, không gọi model parent. Agent không thấy hội thoại, nên nội dung cần tự đủ ý.
- `"model"`: một bản sao hội thoại (cùng model, system prompt và lịch sử của parent, chỉ có tool `Agent`, không nạp extension) viết prompt giao việc có đủ context, rồi khởi động agent. Cách này tốn thêm một lượt model parent, không hiện trong chat.

Ở cả hai chế độ, agent khởi động từ mention luôn chạy nền, kể cả worker/debugger, và kết quả về parent qua thông báo completion. Lời gọi `Agent` của mention không qua bộ phân loại vì chính người dùng đã gõ `@role`; agent con vẫn có cổng permission của role.

Bản vá `src/mention-clone.ts` của pi-subagents cho bản sao chạy được trên Pi 0.87; trước đó bản sao lỗi và tự quay về chạy thẳng. Đổi chế độ cho project bằng `/agents` → Settings → Agent mentions (lưu vào `.pi/subagents.json`), hoặc cho mọi project bằng `agentMentions` trong `subagents.json` của Pi.

## Context và thực thi

Role dùng `inherit_context:false`, `prompt_mode:replace`, `isolated:false` và `persist_session:true`. Worker nhận prompt riêng; auth và cổng permission `pi-auto-mode` được giữ (role liệt kê `pi-auto-mode` trong `extensions`).

Role không giới hạn số lượt (`max_turns: 0` trong file role, `defaultMaxTurns: 0`); giá trị trong role thắng tham số `max_turns` của tool. Agent chạy tới khi xong; dừng bằng `/agents` → chọn agent → `x` hai lần (Esc dừng lời gọi foreground đang chờ). Parent theo dõi và dùng `steer_subagent` khi agent lạc hướng.

`backgroundByDefault:true`: researcher và reviewer chạy nền, lời gọi `Agent` trả ID ngay, thông báo completion mở lượt mới cho parent kèm trích đoạn kết quả; `get_subagent_result` lấy toàn văn. Worker và debugger ghim `run_in_background: false` nên luôn chạy foreground và trả kết quả ngay trong tool call; parent không đổi được. Background tối đa 4 agent, foreground tối đa 2; vượt giới hạn thì xếp hàng. Nhiều lời gọi `Agent` foreground trong cùng một lượt chạy song song; các phiên Pi quản lý pool riêng.

Codex fast mode (`service_tier: "priority"`) áp dụng cho request của GPT-6 Sol (worker, debugger) và GPT-6 Astra (reviewer). Bản vá pi-usage bọc `ModelRuntime` dùng chung của phiên chính, nên request không đi qua hook của phiên (advisor, goal auditor, Oracle, agent con) cũng theo cài đặt fast và chọn hàng theo model của chính request. Worker, debugger và reviewer nạp `pi-usage` để chi phí của request fast được tính đúng; bản vá bỏ truy vấn quota và timer của pi-usage trong phiên không có UI.

Researcher nạp `pi-web-access`. Package này khai extension là thư mục `./dist`; bản vá pi-subagents cho entry thư mục khớp tên package, nếu không `extensions`/`ext:pi-web-access` của role không nạp được web tools.

## Quyền và nghiệm thu

Researcher/reviewer chỉ đọc. Worker/debugger dùng shell, write và edit qua cổng permission. Child dùng mode (auto/bypass) của phiên gốc; bộ phân loại của child lấy tin nhắn của người dùng ở phiên gốc làm ý định, coi task do parent viết là không phải lời người dùng. Khi cần hỏi (luật ask, chạm giới hạn chặn), câu hỏi hiện ở UI của phiên gốc. Trong auto mode, `Agent` với `isolated:true` hoặc danh sách extension thiếu `pi-auto-mode` bị chặn vì child sẽ chạy không có cổng.

Parent cần tránh giao trùng việc hoặc để nhiều writer sửa chồng file. Dùng ID của agent đang chạy để lấy kết quả hay điều chỉnh; parent kiểm evidence và test trước khi kết luận.

Khi gặp blocker quyền/auth/quota, báo nguyên nhân và giữ ranh giới đã được duyệt. Permission là lớp kiểm soát công cụ, không phải OS sandbox.

Project có thể override role. Với `scopeModels:true`, lựa chọn ngoài scope từ tham số tool bị chặn; model ghim trong role ngoài scope sẽ cảnh báo nhưng vẫn được dùng. Cần xem lại role và model thực khi trust hoặc tùy chỉnh project.

## Kiểm thử

`pi-test` hoặc `tests/agent-integration.mjs <root> main` dùng provider giả và chặn mạng để kiểm model/effort thực, context, quyền, web tools của researcher, fast mode trong request của worker/debugger/reviewer, advisor và goal auditor, agent chạy quá 14 lượt, role không tồn tại và completion. Các test request payload kiểm provider OpenCode Go trên SDK đã ghim. Nghiệm thu chất lượng model trên công việc thật là bước riêng với ngân sách cụ thể.
