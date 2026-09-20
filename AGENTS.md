# Phát triển pi-config

Giao tiếp và tài liệu vận hành bằng tiếng Việt. Repo mô tả bộ cài và cấu hình Pi hiện hành cho Windows, Linux, macOS.

- Cấu hình chuẩn: parent Astra/high; researcher GLM/max; worker, debugger, reviewer Sol/high. Main/goal dùng Agent của @tintinweb/pi-subagents. Background và advisor có workflow riêng.
- Ghim phiên bản dependency, nguồn skills và checksum bản vá. Chỉ đổi phiên bản hoặc phân vai theo phạm vi yêu cầu.
- Mỗi profile chỉ có cấu hình cho extension mà nó sử dụng. Giữ context riêng và quyền công cụ của từng role; model/thinking trong role được ưu tiên hơn tham số Agent.
- Giữ auditor, advisor auto, cache warming và workflow tính phí tự động tắt trong cấu hình mặc định.
- Repo không chứa credential, token, dữ liệu phiên, log riêng hoặc đường dẫn máy nguồn. Auth và tùy chỉnh người dùng phải được bảo toàn khi cài lại.
- Installer phải idempotent, kiểm quyền sở hữu file bằng manifest/checksum và báo rõ file đã được người dùng sửa. Chỉ lưu trữ tài nguyên thuộc installer, chưa sửa và không còn được tham chiếu.
- Dùng root, agent-dir và bin-dir tạm để kiểm thử; không chạy installer đè lên Pi đang dùng trên máy phát triển.
- Kiểm thử bằng fixture, chặn mạng model và không dùng credential thật. Chạy check, unit và smoke phù hợp; xác nhận CI trên ba hệ điều hành trước khi phát hành.
- Tài liệu trình bày hành vi, cấu hình, cách vận hành và giới hạn hiện tại. Giữ nội dung ngắn, thống nhất với manifest và source.
