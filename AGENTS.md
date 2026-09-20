# Phát triển pi-config

Giao tiếp và tài liệu vận hành bằng tiếng Việt. Đây là installer public cho Windows, Linux, macOS.
Không đưa credential, API key, auth.json, session, transcript, log của máy nguồn hoặc đường dẫn cá nhân vào repo.
Không chạy installer vào cấu hình Pi đang dùng trên máy phát triển; dùng root/agent-dir/bin-dir tạm cho kiểm thử.
Ghim phiên bản dependency và commit nguồn. Giữ các profile riêng theo giới hạn tương thích; không nâng Pi hoặc extension ngoài phạm vi.
Mặc định Astra parent/Sol worker với high cho các model đã chọn; giữ các profile Opus hiện có khi xuất cấu hình.
Không bật compact-adviser/Jev, auditor, advisor auto, cache warming hoặc API trả phí khi cài.
Kiểm thử không dùng model thật hoặc credential người dùng. Dùng fixture cho provider và mạng.
Installer phải idempotent, không ghi đè tùy chỉnh/secret hiện có. Thay đổi managed file có drift phải báo rõ trước khi sửa.
Chạy kiểm tra Linux, Windows, macOS trong CI trước khi tuyên bố hỗ trợ. Không coi mock platform là nghiệm thu hệ điều hành thật.
