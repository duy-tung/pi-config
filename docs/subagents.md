# Agent theo công việc

Pi dùng tool `Agent` của `@tintinweb/pi-subagents` 0.19.0. Parent Claude Opus 5.5/high phân tích yêu cầu, chốt thiết kế, chia việc và nghiệm thu.

| Role | Model/effort | Quyền và trách nhiệm |
|---|---|---|
| `researcher` | GLM-5.3-Flash/max | Khảo sát code/docs/log và web (`web_search`, `fetch_content`); chỉ đọc và trả bằng chứng |
| `worker` | GPT-6 Sol/max | Triển khai phần việc đã chốt, sửa file và kiểm thử |
| `debugger` | GPT-6 Sol/max | Tái hiện, xác định nguyên nhân, sửa và kiểm hồi quy |
| `reviewer` | GPT-6 Astra/high | Review độc lập, chỉ đọc |

GLM dùng provider `opencode-go` trực tiếp trong Pi. Opus 5.5 và GLM dùng context 1M của catalog; Astra/Sol nâng lên 872K. File role nằm trong `agents/` của Pi. `pi-doctor` in model/thinking thật của từng role và đánh dấu role đã sửa so với bản cài.

## Giao việc

```text
@researcher Tìm luồng xử lý timeout và báo file/dòng.
@worker Thêm cơ chế retry theo thiết kế đã chốt, chạy test liên quan.
@debugger Tái hiện lỗi reconnect và kiểm tra bản sửa.
@reviewer Review diff, nêu lỗi có bằng chứng và mức nghiêm trọng.
```

Parent có thể gọi `Agent` với `subagent_type` tương ứng. Mỗi prompt giao việc cần mục tiêu, phạm vi file, ràng buộc và tiêu chí nghiệm thu. Researcher chuyển quyết định kiến trúc hoặc yêu cầu chưa rõ về parent.

Model/thinking ghim trong file role được ưu tiên hơn tham số tool. Chọn role theo công việc và kiểm model thực trong kết quả khi tùy chỉnh cấu hình.

`/agents` quản lý agent; `get_subagent_result` lấy kết quả; `steer_subagent` gửi bổ sung theo ID.

Gõ `@role nội dung` ở prompt (`agentMentions: "direct"`) khởi động agent ngay, lấy nội dung bạn gõ làm task, không gọi model parent; agent đang chạy thì nhận tin nhắn đó. Chế độ `"model"` của upstream nhờ một bản sao hội thoại viết prompt giao việc, nhưng phần sao chép này lỗi trên Pi 0.87 (tự quay về chạy thẳng) nên không dùng.

## Context và thực thi

Role dùng `inherit_context:false`, `prompt_mode:replace`, `isolated:false` và `persist_session:true`. Worker nhận prompt riêng; auth và cổng permission `pi-auto-mode` được giữ (role liệt kê `pi-auto-mode` trong `extensions`).

Role không giới hạn số lượt (`max_turns: 0` trong file role, `defaultMaxTurns: 0`); giá trị trong role thắng tham số `max_turns` của tool. Agent chạy tới khi xong; dừng bằng `/agents` → chọn agent → `x` hai lần (Esc dừng lời gọi foreground đang chờ). Parent theo dõi và dùng `steer_subagent` khi agent lạc hướng.

`backgroundByDefault:true`: researcher và reviewer chạy nền, lời gọi `Agent` trả ID ngay, thông báo completion mở lượt mới cho parent kèm trích đoạn kết quả; `get_subagent_result` lấy toàn văn. Worker và debugger ghim `run_in_background: false` nên luôn chạy foreground và trả kết quả ngay trong tool call; parent không đổi được. Background tối đa 4 agent, foreground tối đa 2; vượt giới hạn thì xếp hàng. Nhiều lời gọi `Agent` foreground trong cùng một lượt chạy song song; các phiên Pi quản lý pool riêng.

Worker và debugger nạp `pi-usage` để Codex fast mode (`service_tier: "priority"`) áp dụng cho request của GPT-6 Sol; bản vá của pi-config bỏ truy vấn quota và timer của pi-usage trong phiên không có UI. Reviewer dùng Astra, model chưa hỗ trợ fast.

Researcher nạp `pi-web-access`. Package này khai extension là thư mục `./dist`; bản vá pi-subagents cho entry thư mục khớp tên package, nếu không `extensions`/`ext:pi-web-access` của role không nạp được web tools.

## Quyền và nghiệm thu

Researcher/reviewer chỉ đọc. Worker/debugger dùng shell, write và edit qua cổng permission. Child dùng mode (auto/bypass) của phiên gốc; bộ phân loại của child lấy tin nhắn của người dùng ở phiên gốc làm ý định, coi task do parent viết là không phải lời người dùng. Khi cần hỏi (luật ask, chạm giới hạn chặn), câu hỏi hiện ở UI của phiên gốc. Trong auto mode, `Agent` với `isolated:true` hoặc danh sách extension thiếu `pi-auto-mode` bị chặn vì child sẽ chạy không có cổng.

Parent cần tránh giao trùng việc hoặc để nhiều writer sửa chồng file. Dùng ID của agent đang chạy để lấy kết quả hay điều chỉnh; parent kiểm evidence và test trước khi kết luận.

Khi gặp blocker quyền/auth/quota, báo nguyên nhân và giữ ranh giới đã được duyệt. Permission là lớp kiểm soát công cụ, không phải OS sandbox.

Project có thể override role. Với `scopeModels:true`, lựa chọn ngoài scope từ tham số tool bị chặn; model ghim trong role ngoài scope sẽ cảnh báo nhưng vẫn được dùng. Cần xem lại role và model thực khi trust hoặc tùy chỉnh project.

## Kiểm thử

`pi-test` hoặc `tests/agent-integration.mjs <root> main` dùng provider giả và chặn mạng để kiểm model/effort thực, context, quyền, web tools của researcher, fast mode trong request của worker/debugger, agent chạy quá 14 lượt, role không tồn tại và completion. Các test request payload kiểm provider OpenCode Go trên SDK đã ghim. Nghiệm thu chất lượng model trên công việc thật là bước riêng với ngân sách cụ thể.
