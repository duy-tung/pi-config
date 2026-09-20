# Routing trong Pi

Router dùng trực tiếp provider của Pi: `openai-codex/gpt-5.6-sol` với `high`, `opencode-go/glm-5.3-flash` với `max`. Astra/high giữ parent và nghiệm thu. Không gọi Codex CLI hoặc OpenCode CLI.

Installer nạp extension vào main/goal nhưng mặc định `off`; background/advisor giữ workflow riêng. Model menu ưu tiên Astra, Sol, rồi GLM. Context Astra/Sol giữ 872K; GLM dùng catalog native 1M. Các role mặc định vẫn Sol/high.

Trong Pi:

- `/routing status`: mode và ngân sách Jev đã dùng.
- `/routing record`: bật dispatcher, tự động giữ Sol; không gọi Jev.
- `/routing shadow`: Jev chỉ đưa đề xuất, model tự động vẫn Sol.
- `/routing balanced`: cho phép GLM ở nhóm có evidence được duyệt; thiếu evidence giữ Sol hoặc trả parent.
- `/routing explain <jobId>`: model thực, effort, nguồn chọn và trạng thái.
- `/routing off`: ngừng routing và yêu cầu dừng worker do router đang quản lý.

Hai mode gọi Jev yêu cầu `routing.json` có `jev.enabled:true`, `budgetUsd` và `maxCalls` đã được người dùng duyệt. Ngân sách là tổng tích lũy qua các lần mở Pi, không reset theo ngày/session. Timeout hoặc request lỗi giữ khoản dự phòng vì có thể đã tính tiền. Đổi giá Jev cần xem lại bộ đếm; giá đang ghim $0,042/M input theo bản 1.13.0. Không dùng bộ đếm như hóa đơn của provider.

`dispatch_task` nhận role, brief, acceptance, taskClass, requestId ổn định và candidate (auto/sol/glm). `candidate:glm` là lựa chọn tường minh và vẫn chịu scope/credential/permission; reviewer luôn giữ Sol. Một requestId không được dùng lại cho nhiệm vụ khác. Task bị chặn không tự chạy lại hoặc đổi provider.

Mẫu yêu cầu trong Pi: “Dùng dispatch_task với candidate glm, role researcher để đọc các file config và báo timeout đang dùng; chỉ đọc, không sửa.” Đây sử dụng quota GLM thật. `/routing record` chỉ tắt inference của Jev, không làm worker miễn phí.

Role được resolve từ project hiện tại. Router kiểm đúng contract tools/extensions, context riêng và giới hạn trước spawn, sau đó kiểm lại nếu cấu hình thay đổi. RPC giữ permission của Pi. `isolated:false` không phải sandbox filesystem. Agent/@mention thủ công vẫn tồn tại; router chỉ quản lý task đi qua dispatcher.

Router cho phép tối đa một writer (worker/debugger) trên một workspace qua lock dùng chung main/goal; reader vẫn theo pool 2. Hủy/timeout sẽ dừng đúng cả worker đang chờ và tiêu thụ thông báo kết thúc. Nếu process bị kill hoặc không xác nhận được worker đã dừng, lock được giữ để tránh writer chạy chồng. Chỉ xóa lock trong `state/routing-writers` sau khi kiểm PID trong file đã dừng. Các task đi ngoài dispatcher không chịu lock này.

`routing-capabilities.json` mặc định rỗng. Code không tự biến lời worker “xong” thành bằng chứng chất lượng. Auto GLM hiện giới hạn researcher + lookup/mechanical, cần card được duyệt cho đúng GLM/max, tối thiểu 12 mẫu đều đạt và còn hạn. Gate này chỉ dành cho pilot; nó không chứng minh chất lượng production. Ngưỡng Jev cũng là ngưỡng thử nghiệm cần hiệu chỉnh, không phải bảo đảm xác suất đúng.

Credential Jev được resolve tại máy từ `TYPESAFE_API_KEY`, file tuyệt đối `typesafeKeyFile` (dòng `TYPESAFE_API_KEY=...`, quyền 0600), hoặc saved key của compact-adviser. Extension không ghi key vào log hoặc truyền qua prompt. Nếu dùng env chung, tiến trình con khác có thể kế thừa env của shell; nên dùng file riêng hoặc saved credential. Brief gửi Jev có lọc một số dạng key phổ biến nhưng không bảo đảm loại mọi secret; chỉ giao brief chứa dữ liệu được phép gửi dịch vụ.

`routing-state/` chứa audit metadata, job chống trùng và ngân sách. Không log raw brief/tool result. Cache quyết định nằm trong bộ nhớ, khóa theo brief/policy/role/evidence và phiên bản Jev. Permission/auth/scope luôn kiểm lại trước spawn. Không cache hoặc chia sẻ prompt cache giữa các provider.

`completed-unreviewed` nghĩa worker đã kết thúc, parent chưa nghiệm thu. Task đọc file bị permission deny có thể vẫn kết thúc bằng báo cáo blocker; parent phải kiểm kết quả. Router không tự promote model, merge, commit hoặc đổi cấu hình.

Compact-adviser vẫn off và có ngân sách riêng nếu bật sau. Trong phép đo routing nên giữ nó off để tách tác dụng. Các file routing/policy/state được bảo vệ khỏi công cụ agent; chỉnh bằng editor hoặc slash command của người dùng.

Kiểm thử: `npm test` dùng fixture không mạng. `tests/router-integration.mjs <root> main|goal` nạp đầy đủ extension và RPC thật với provider giả, kiểm GLM/max, Sol/high, context, permission, model scope, chống chạy trùng và Jev có ngân sách. Smoke installer chạy bộ này trên Windows/Linux/macOS. Nghiệm thu API thật là bước riêng, cần credential và trần chi phí; không chạy trong CI public.
