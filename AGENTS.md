# Phát triển pi-config

Giao tiếp và tài liệu vận hành bằng tiếng Việt. Đây là installer public cho Windows, Linux, macOS.
Không đưa credential, API key, auth.json, session, transcript, log của máy nguồn hoặc đường dẫn cá nhân vào repo.
Không chạy installer vào cấu hình Pi đang dùng trên máy phát triển; dùng root/agent-dir/bin-dir tạm cho kiểm thử.
Ghim phiên bản dependency và commit nguồn. Giữ các profile riêng theo giới hạn tương thích; không nâng Pi hoặc extension ngoài phạm vi.
Mặc định Astra parent/Sol worker high; goal/background dùng Astra high; advisor dùng Sol high executor và Astra high advisor. GLM-5.3-Flash là candidate native opencode-go với max, chỉ lựa chọn tường minh; không route qua Codex/OpenCode CLI.
Không cài Jev/compact-adviser. Không bật auditor, advisor auto, cache warming hoặc API trả phí khi cài.
Dispatcher chỉ có manual/off, Sol/high mặc định hoặc GLM/max tường minh; record là alias cũ. Pilot completion không chứng minh lợi ích thêm từ Jev nên đã gỡ runtime, config và dependency liên quan. Không thêm event gate hoặc gọi classifier trả phí.
Kiểm thử không dùng model thật hoặc credential người dùng. Dùng fixture cho provider và mạng.
Installer phải idempotent, không ghi đè tùy chỉnh/secret hiện có. Thay đổi managed file có drift phải báo rõ trước khi sửa.
Chạy kiểm tra Linux, Windows, macOS trong CI trước khi tuyên bố hỗ trợ. Không coi mock platform là nghiệm thu hệ điều hành thật.
