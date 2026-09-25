# Phát triển pi-config

Giao tiếp và tài liệu vận hành bằng tiếng Việt. Repo mô tả bộ cài và cấu hình Pi hiện hành cho Windows, Linux, macOS.

- Cấu hình chuẩn là preset `default` trong `assets/configs/model-presets.json` (người dùng chọn preset và ghi đè trong `<agent-dir>/model-roles.json`, bằng `pi-models` hoặc sửa file): parent Claude Opus 5.5/high; researcher GLM/max; worker, debugger GPT-6 Sol/max; reviewer, advisor, goal auditor và Oracle GPT-6 Astra/high; auto mode: Jev jev-1.13.0 sàng lọc (khi có key TypeSafe), Claude Sonnet 5/low xét kỹ phần bị gắn cờ. Preset `claude` chỉ dùng Claude. Agent không giới hạn số lượt. Một runtime Pi 0.87.1, một cấu hình main; dùng Agent của @tintinweb/pi-subagents và slash command trong cùng phiên.
- Ghim phiên bản dependency, nguồn skills và checksum bản vá. Chỉ đổi phiên bản hoặc phân vai theo phạm vi yêu cầu.
- Goal, shell jobs, rewind (pi-rewind) và advisor phải dùng được trong cùng phiên; background chỉ cung cấp shell jobs, model delegation dùng Agent. Giữ context riêng và quyền công cụ của từng role; model/thinking trong role được ưu tiên hơn tham số Agent.
- Giữ cache warming và workflow tính phí tự động tắt trong cấu hình mặc định. Ngoại lệ đã chọn: Codex fast mode (tắt bằng `/fast`); advisor luôn bật cho parent, gọi khi lỗi lặp lại và trước khi báo xong, tối đa 5 lần mỗi phiên, không có gate cứng chặn phiên; goal auditor và Oracle bật; auto mode dùng Jev (tính tiền theo token) cho giai đoạn 1 và quét prompt injection khi người dùng đã lưu key. Lệnh của auditor phải qua cổng permission như subagent.
- Repo không chứa credential, token, dữ liệu phiên, log riêng hoặc đường dẫn máy nguồn. Auth và tùy chỉnh người dùng phải được bảo toàn khi cài lại.
- Installer phải idempotent, kiểm quyền sở hữu file bằng manifest/checksum và báo rõ file đã được người dùng sửa. Chỉ lưu trữ tài nguyên thuộc installer, chưa sửa và không còn được tham chiếu.
- Dùng root, agent-dir và bin-dir tạm để kiểm thử; không chạy installer đè lên Pi đang dùng trên máy phát triển.
- Kiểm thử bằng fixture, chặn mạng model và không dùng credential thật. Chạy check, unit và smoke phù hợp; xác nhận CI trên ba hệ điều hành trước khi phát hành.
- Tài liệu trình bày hành vi, cấu hình, cách vận hành và giới hạn hiện tại. Giữ nội dung ngắn, thống nhất với manifest và source.
