# Dispatcher trong Pi

Astra/high giữ parent, thiết kế và nghiệm thu. Task con chạy trực tiếp trong Pi: mặc định `openai-codex/gpt-5.6-sol` với `high`; parent có thể chọn `opencode-go/glm-5.3-flash` với `max`. Không cần Codex CLI, OpenCode CLI hoặc classifier bên ngoài.

Main/goal nạp dispatcher; cài mới mặc định `off`. Background/advisor giữ workflow riêng. Các role vẫn mặc định Sol/high và context riêng.

Trong Pi:

- `/routing manual`: bật dispatcher Sol/GLM.
- `/routing status`: xem trạng thái và model mặc định.
- `/routing explain <jobId>`: xem model thực, effort, nguồn chọn và trạng thái task.
- `/routing off`: ngừng dispatcher, yêu cầu dừng worker đang quản lý.

`record` là alias cũ của `manual`. Jev và compact-adviser đã gỡ. Không còn mode shadow/balanced, capability card, ngân sách classifier hoặc event gate.

## Giao task

`dispatch_task` cần `requestId` ổn định, `role`, `brief` và `acceptance`. Bỏ `candidate` hoặc dùng `auto` đều chọn Sol/high; `candidate:glm` chọn GLM/max tường minh. Reviewer giữ Sol. `taskClass` không bắt buộc; nếu khai báo `design`, task trả về parent để chốt thiết kế.

Mẫu yêu cầu: “Dùng dispatch_task với candidate glm, role researcher để đọc config và báo timeout đang dùng; chỉ đọc, không sửa.” Worker sử dụng quota của provider thật. Dispatcher không thêm request phân loại.

Parent cung cấp phạm vi, ràng buộc và tiêu chí nghiệm thu trong brief. `completed-unreviewed` chỉ có nghĩa worker đã kết thúc; parent phải kiểm evidence và kiểm thử trước khi nghiệm thu. Worker báo permission/auth/quota blocker thì không tự đổi model hoặc retry.

## Các giới hạn được giữ

Role được resolve theo project đã trust; loader chỉ dùng `@tintinweb/pi-subagents` 0.19.0 từ global config. Trước spawn, dispatcher kiểm role contract, model chính xác, credential sẵn sàng, effort, enabledModels và scope session. Cấu hình thay đổi trong lúc giao task sẽ chặn spawn.

Worker không kế thừa context parent, tối đa 12 turns, pool 2, grace 2; không giao việc lồng nhau. `isolated:false` giữ auth/permission hooks, không phải sandbox hệ điều hành.

Main/goal dùng lock chung, tối đa một writer (worker/debugger) trong một workspace. Timeout/hủy yêu cầu dừng đúng cả worker đang chờ và tiêu thụ thông báo kết thúc, tránh đánh thức parent lần nữa. Nếu chưa xác nhận worker dừng hoặc process bị kill, lock được giữ. Chỉ xóa lock trong `state/routing-writers` sau khi xác minh PID đã dừng. Task đi qua Agent/@mention ngoài dispatcher không chịu lock này.

`routing-state/` giữ job chống chạy trùng và audit metadata, không lưu raw brief hoặc worker output. Một requestId không dùng lại cho nhiệm vụ khác. File policy/state được bảo vệ khỏi công cụ agent; người dùng đổi mode bằng slash command.

## Cấu hình

```json
{
  "version": 2,
  "mode": "manual",
  "allowExplicitGlm": true,
  "timeoutMs": 900000
}
```

Installer thêm `writerLocksDir` tuyệt đối để main/goal dùng chung lock. `allowExplicitGlm:false` vô hiệu lựa chọn GLM qua dispatcher. Policy v1 cũ được đọc thành off/manual và loại mọi trường Jev; `/routing manual` lưu lại schema v2. Cấu hình v2 không chấp nhận shadow/balanced.

Native compaction/cache của Pi độc lập với dispatcher và vẫn giữ cấu hình hiện tại. Không có prompt-cache chia sẻ giữa provider.

## Kiểm thử

`npm test` kiểm policy và RPC. `tests/router-integration.mjs <root> main|goal` nạp extension/provider giả và RPC thật: Sol/high, GLM/max, context riêng, permission, scope, chống trùng, cấu hình legacy không gọi mạng. Smoke installer chạy bốn profile trên Windows/Linux/macOS trong CI, không dùng credential thật hoặc gọi model tính phí.
