# Agent theo công việc

Pi dùng tool `Agent` của `@tintinweb/pi-subagents` 0.19.0. Parent Astra/high phân tích yêu cầu, chốt thiết kế, chia việc và nghiệm thu.

| Role | Model/effort | Quyền và trách nhiệm |
|---|---|---|
| `researcher` | GLM-5.3-Flash/max | Khảo sát code/docs/log, Firecrawl; chỉ đọc và trả bằng chứng |
| `worker` | GPT-5.6 Sol/high | Triển khai phần việc đã chốt, sửa file và kiểm thử |
| `debugger` | GPT-5.6 Sol/high | Tái hiện, xác định nguyên nhân, sửa và kiểm hồi quy |
| `reviewer` | GPT-5.6 Sol/high | Review độc lập, chỉ đọc |

GLM dùng provider `opencode-go` trực tiếp trong Pi. Astra/Sol có context 872K; GLM dùng catalog native. File role nằm trong `agents/` của Pi.

## Giao việc

```text
@researcher Tìm luồng xử lý timeout và báo file/dòng.
@worker Thêm cơ chế retry theo thiết kế đã chốt, chạy test liên quan.
@debugger Tái hiện lỗi reconnect và kiểm tra bản sửa.
@reviewer Review diff, nêu lỗi có bằng chứng và mức nghiêm trọng.
```

Astra có thể gọi `Agent` với `subagent_type` tương ứng. Mỗi prompt giao việc cần mục tiêu, phạm vi file, ràng buộc và tiêu chí nghiệm thu. Researcher chuyển quyết định kiến trúc hoặc yêu cầu chưa rõ về parent.

Model/thinking ghim trong file role được ưu tiên hơn tham số tool. Chọn role theo công việc và kiểm model thực trong kết quả khi tùy chỉnh cấu hình.

`/agents` quản lý agent; `get_subagent_result` lấy kết quả; `steer_subagent` gửi bổ sung theo ID.

## Context và thực thi

Role dùng `inherit_context:false`, `prompt_mode:replace`, `isolated:false` và `persist_session:true`. Worker nhận prompt riêng; permission/auth hooks được giữ.

Mỗi role giới hạn 12 turns với grace 2. Foreground và background có pool riêng, mỗi pool tối đa 2; các phiên Pi quản lý pool riêng.

`backgroundByDefault:false`: Agent chờ và trả kết quả ngay trong tool call. Foreground đánh dấu kết quả đã nhận, tránh thông báo completion bổ sung. Với công việc độc lập, parent có thể dùng `run_in_background:true`, tiếp tục việc khác và nhận thông báo khi worker xong.

## Quyền và nghiệm thu

Researcher/reviewer chỉ đọc. Worker/debugger dùng shell, write và edit qua permission. Yêu cầu quyền của child được chuyển lên UI parent.

Parent cần tránh giao trùng việc hoặc để nhiều writer sửa chồng file. Dùng ID của agent đang chạy để lấy kết quả hay điều chỉnh; parent kiểm evidence và test trước khi kết luận.

Khi gặp blocker quyền/auth/quota, báo nguyên nhân và giữ ranh giới đã được duyệt. Permission là lớp kiểm soát công cụ, không phải OS sandbox.

Project có thể override role. Với `scopeModels:true`, lựa chọn ngoài scope từ tham số tool bị chặn; model ghim trong role ngoài scope sẽ cảnh báo nhưng vẫn được dùng. Cần xem lại role và model thực khi trust hoặc tùy chỉnh project.

## Kiểm thử

`pi-test` hoặc `tests/agent-integration.mjs <root> main` dùng provider giả và chặn mạng để kiểm model/effort thực, context, quyền, role không tồn tại và completion. Các test request payload kiểm provider OpenCode Go trên SDK đã ghim. Nghiệm thu chất lượng model trên công việc thật là bước riêng với ngân sách cụ thể.
