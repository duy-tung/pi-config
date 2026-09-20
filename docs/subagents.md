# Giao việc trực tiếp bằng Agent

Main/goal dùng tool `Agent` của `@tintinweb/pi-subagents` 0.19.0. Astra/high phân tích, chốt phạm vi, giao task hữu hạn rồi kiểm tra kết quả. Background/advisor giữ workflow riêng.

| Role | Model/effort | Quyền |
|---|---|---|
| researcher | Sol/high | Đọc source, Firecrawl |
| worker | Sol/high | Đọc, sửa file, shell qua permission |
| debugger | Sol/high | Đọc, sửa file, shell qua permission |
| reviewer | Sol/high | Chỉ đọc |
| researcher-glm | GLM/max | Đọc source, Firecrawl |
| worker-glm | GLM/max | Đọc, sửa file, shell qua permission |
| debugger-glm | GLM/max | Đọc, sửa file, shell qua permission |

GLM chạy trực tiếp bằng provider `opencode-go/glm-5.3-flash` trong Pi. Bốn role không có hậu tố vẫn mặc định `openai-codex/gpt-5.6-sol` high. Astra/Sol giữ context 872K; GLM dùng catalog native. Phiên bản và auth hiện tại được giữ.

## Cách dùng

```text
@researcher Tìm luồng xử lý timeout, chỉ đọc và báo file/dòng.
@worker Triển khai thay đổi đã chốt và chạy kiểm thử liên quan.
@reviewer Review bản diff, nêu lỗi có bằng chứng.
@researcher-glm Tra cứu các giá trị config, chỉ đọc và báo nguồn.
@worker-glm Sửa các chuỗi đã liệt kê, kiểm tra diff và báo kết quả.
@debugger-glm Tái hiện lỗi đã mô tả và kiểm thử bản sửa.
```

Astra có thể gọi `Agent` với `subagent_type` tương ứng thay cho @mention. Prompt cần có mục tiêu, phạm vi file, ràng buộc và tiêu chí nghiệm thu.

Model/thinking trong file role được ưu tiên hơn tham số tool ở bản tintin này. Vì vậy chọn role `*-glm` để dùng GLM/max; truyền `model: glm` cho role `worker` vẫn giữ Sol/high. Các bài integration kiểm model/effort thực nhận bởi provider.

Dùng `/agents` để xem hoặc quản lý agent; `get_subagent_result` lấy kết quả, `steer_subagent` gửi bổ sung theo ID. Không cần bước bật routing.

## Vòng đời và giới hạn

Worker có context riêng, không sao chép toàn bộ hội thoại parent. Role ghim `inherit_context:false`, `isolated:false`, 12 turns và giữ permission/auth hooks. Cấu hình có grace 2; mỗi pool foreground/background giới hạn 2. Hai pool và các phiên Pi là các phạm vi riêng, không có giới hạn toàn máy bằng 2.

Mặc định `backgroundByDefault:false`: Agent chờ worker và trả kết quả ngay trong tool call. Native foreground đánh dấu kết quả đã nhận để tránh thông báo completion thêm lần nữa. Khi task độc lập, Astra có thể chọn `run_in_background:true`, rồi tiếp tục công việc khác và nhận thông báo khi xong.

Parent phải đọc bằng chứng và kiểm thử trước khi nghiệm thu. Khi bị chặn quyền/auth/quota, báo blocker; không đổi provider để vượt chặn. Permission là kiểm soát công cụ, không phải OS sandbox.

## Những phần đã gỡ

Không còn `pi-dispatch-router`, `dispatch_task`, `/routing`, routing policy hoặc routing state trong cấu hình mới. Không có Jev hoặc compact-adviser.

Khóa writer chung giữa các phiên, chống trùng bằng requestId, hard gate riêng cho model/role và timeout 15 phút của dispatcher cũng đã gỡ. Parent cần tránh giao trùng việc hoặc cho hai worker ghi chồng file. Dùng ID agent đang chạy để hỏi kết quả/điều chỉnh; các giới hạn lượt chạy và hủy dùng cơ chế native của tintin.

Project có thể override role. Native `scopeModels:true` chặn lựa chọn ngoài scope từ tham số tool; model ghim trong role ngoài scope sẽ cảnh báo nhưng vẫn chạy. Hãy xem model thực trong kết quả Agent khi tùy chỉnh role. Không coi các kiểm tra strict của dispatcher cũ là còn tồn tại.

## Nâng từ bản có dispatcher

Dừng task/Pi trước khi chạy lại installer. Installer gỡ đúng đường dẫn extension do bản cũ quản lý, sao lưu policy/state/source cũ và giữ theme/các trường settings tùy chỉnh. File custom có drift vẫn được báo để đối chiếu. Writer lock còn tồn tại sẽ chặn migration để người dùng kiểm tra task trước. Dữ liệu cũ trong backup không được nạp.

## Kiểm thử

`tests/agent-integration.mjs <root> main|goal` chạy Agent thật với provider giả và chặn mạng: Sol/high, ba role GLM/max, context riêng, read-only researcher, permission, ghi file được phép, reviewer Sol và completion foreground không tạo lượt parent thừa. Installer smoke kiểm cài sạch, migration bỏ dispatcher giữ theme/credential giả và cài lại trên Windows/Linux/macOS. Không dùng model thật, không suy ra mức tiết kiệm token hoặc chất lượng từ fixture.
