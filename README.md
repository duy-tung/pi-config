# pi-config

[![Kiểm thử cài đặt](https://github.com/duy-tung/pi-config/actions/workflows/test.yml/badge.svg)](https://github.com/duy-tung/pi-config/actions/workflows/test.yml)

Cài cấu hình Pi cá nhân trên **macOS, Linux và Windows** bằng một lệnh. Ghim phiên bản, khóa dependency, kiểm checksum bản vá, giữ context riêng cho worker và giao diện Rosé Pine. Repo không chứa API key, auth, session hoặc lịch sử chat.

## Cài một lệnh

**macOS / Linux** — Terminal có Bash, curl và tar:

```sh
curl -fsSL https://raw.githubusercontent.com/duy-tung/pi-config/main/install.sh | bash
```

**Windows 10/11** — PowerShell 5.1 trở lên, không cần Administrator:

```powershell
& ([scriptblock]::Create((Invoke-RestMethod 'https://raw.githubusercontent.com/duy-tung/pi-config/main/install.ps1')))
```

Bootstrap tải Node **24.15.0** riêng theo user khi cần, kiểm SHA256; Windows còn chuẩn bị Git Bash portable nếu thiếu. Không dùng sudo, không thay Node hệ thống. Sau cài, mở terminal mới rồi chạy `pi`.

Có thể đọc [install.sh](install.sh), [install.ps1](install.ps1), [install.mjs](install.mjs) trước khi chạy. Lệnh trên theo nhánh `main`; dùng `PI_CONFIG_REF` để chọn tag/commit đã kiểm chứng. Chi tiết CPU, prerequisite và đường dẫn tùy chọn: [docs/platforms.md](docs/platforms.md).

Installer từ chối ghi đè một bản Pi có sẵn chưa được nó quản lý. Muốn thử song song, clone repo và dùng:

```sh
node install.mjs --root /duong-dan/pi-platform --agent-dir /duong-dan/pi-agent --bin-dir /duong-dan/bin --no-path
```

Các đường dẫn hỗ trợ khoảng trắng. Windows không hỗ trợ dấu `%`, `!`, `"` trong đường dẫn credential helper. Linux hiện nhắm glibc, không phải Alpine/musl.

## Đăng nhập trên máy mới

Credential không thể mang sang từ repo public. Sau khi cài:

1. `pi-login` → `/login` → chọn **OpenAI Codex** cho main Astra và worker Sol.
2. Nếu dùng các profile còn Opus, đăng nhập Anthropic riêng. Giữ kiểm soát Extra usage của tài khoản.
3. Web: `firecrawl login --browser`. Pi đọc key từ credential store của Firecrawl CLI theo từng OS.
4. Compact adviser được cài **Off**. Nếu muốn dùng Jev, mở `/compact-adviser` để lưu key qua UI và chủ động chọn Hint. Đây là API trả phí riêng, có gửi phần context đã chọn tới TypeSafe.

Không nhập token vào chat hoặc commit credential. Bốn profile dùng cùng auth mặc định qua launcher; không cần symlink có quyền đặc biệt trên Windows.

## Cấu hình được cài

| Lệnh | Pi | Model và nhiệm vụ |
|---|---|---|
| `pi` | 0.86.0 | Parent **GPT-6 Astra high**, lựa chọn nhanh Astra/Sol; cả hai 872K |
| `pi-goal` | 0.84.4 | Parent Opus 5 medium, goal dài hạn và workspace history |
| `pi-background` | 0.84.4 | Parent Opus 5 medium, background tasks |
| `pi-advisor` | 0.86.0 | Executor **GPT-5.6 Sol high**; advisor Opus 5 high, consultation mặc định tắt |

Bốn role `researcher`, `worker`, `debugger`, `reviewer` dùng **GPT-5.6 Sol high, 872K**, context riêng, tối đa 12 turns, concurrency 2. Researcher/reviewer chỉ đọc; researcher có Firecrawl; worker/debugger có shell và ghi file qua permission gate. Không bật nested delegation, workflow hay worktree tự động. Compat 0.84.4 chưa có Astra trong catalog tĩnh; không dùng Astra cho profile compat khi chưa bổ sung và nghiệm thu.

| Thành phần | Phiên bản |
|---|---|
| `@tintinweb/pi-subagents` | 0.19.0 |
| `@gotgenes/pi-anthropic-auth` | 2.0.10 |
| `pi-mcp-adapter` | 2.34.0 |
| `pi-web-access` | 0.29.0, backend Firecrawl |
| `@juicesharp/rpiv-ask-user-question`, `rpiv-todo` | 2.10.1 |
| `pi-background-tasks` | 2.5.0, profile riêng |
| `pi-lens` | 4.2.1; TypeScript LSP cài sẵn |
| `pi-goal-x`, `pi-workspace-history` | 0.31.6 / 0.4.3, profile riêng |
| `@gotgenes/pi-permission-system` | 33.0.1 |
| `@narumitw/pi-usage` | 0.60.8 |
| `pi-advisor-flow` | 0.6.0, peer metadata tương thích 0.86 được đóng gói riêng |
| `pi-open-tui` | 0.3.6, footer đã tinh giản |
| `compact-adviser` | 0.1.4, **Off** |
| Firecrawl CLI | 1.23.3 |
| Engineering skills + Firecrawl skills | Commit ghim trong [sources.lock.json](sources.lock.json) |

Main dùng **Rosé Pine Moon**, các profile khác Rosé Pine; có thêm Dawn. Footer giữ model, thinking, quota, thanh context/% và số liệu token/cost; loại phần usage trùng, provider, LSP inactive và MCP idle. Tình trạng lỗi/đang kết nối vẫn hiện. Palette terminal được đổi theo phiên Pi rồi trả lại khi thoát; không sửa theme toàn hệ thống hoặc cài font.

`codexFastMode:true` được giữ **chỉ main** theo cấu hình gốc; nó có thể dùng quota theo chế độ Fast của provider. Các API như Firecrawl/TypeSafe cần credential và ngân sách riêng. Cache warming, auditor goal, advisor auto và compact tự động của adviser đều tắt. Native compaction của Pi vẫn bật: reserve 16.384, giữ gần nhất 20.000 token.

## Dùng hằng ngày

```text
@researcher Khảo sát nguồn và đề xuất phương án; chỉ đọc.
@worker Triển khai phần đã chốt, chạy kiểm thử liên quan.
@debugger Tái hiện lỗi và sửa với regression test.
@reviewer Review độc lập; nêu lỗi có bằng chứng.
```

`pi-doctor` kiểm dependency/bản vá/config tại máy, không gọi model. `pi-models` xem model từng profile. `/model`, `/thinking`, `/usage`, `/mcp`, `/lens-health`, `/open-tui`, `/compact-adviser status` dùng trong Pi. Các lệnh đặc thù goal/background/advisor ở profile tương ứng.

MCP filesystem chỉ expose công cụ đọc và dùng cwd của project. LSP Go/Rust/Python cần language server riêng của project/máy; installer không hứa cài mọi toolchain ngôn ngữ. Permission extension là lớp kiểm soát tool, không phải OS sandbox. Một repo được trust hoặc lệnh shell được duyệt vẫn cần được xem xét phù hợp.

## Chạy lại, cập nhật và khôi phục

Chạy lại cùng installer giữ runtime nếu lockfile không đổi; vẫn kiểm checksum bản vá. File cấu hình đã tùy chỉnh, auth và key được giữ nguyên. Với bản mới, file managed chưa chỉnh sửa được cập nhật và có backup; file có drift được giữ lại và báo đường dẫn để bạn đối chiếu.

Mặc định cài ở `~/.local/share/pi-platform`, main agent `~/.pi/agent`, launcher `~/.local/bin`. Windows dùng vị trí tương ứng dưới user profile; Bash và Node portable có thư mục toolchain riêng. Installer thêm PATH theo user; `--no-path` bỏ bước này.

Nếu cài bị dừng, chạy lại cùng các đường dẫn để tiếp tục. Nếu tiến trình bị kill và còn `.install.lock`, kiểm PID trong file và chắc chắn installer cũ đã dừng trước khi xóa lock. Không xóa lock của installer đang chạy.

Không dùng `pi update` hoặc `npm update` trực tiếp trên runtime ghim: có thể mất các bản vá. Cập nhật qua revision mới của repo sau khi CI đạt. Muốn gỡ, bỏ launcher/PATH và root của bản cài; **sao lưu auth/session trong agent-dir trước**, không xóa thư mục Pi khác đang dùng.

## Kiểm thử và giới hạn

CI chạy trên **Ubuntu, Windows và macOS thật**: kiểm repo/secret, unit tests, cài sạch từ lockfile, auth chia sẻ, permission, subagent, MCP, goal/background/advisor bằng provider giả; kiểm cài lại giữ tùy chỉnh và credential giả. Bootstrap còn tải toolchain mới và thử đường dẫn có khoảng trắng.

```sh
npm run check
npm test
npm run smoke
```

Badge đầu trang là trạng thái nghiệm thu hiện tại. Test không gọi model/API tính phí và không chứng minh chất lượng model, OAuth của tài khoản bạn, hay quota. Các plugin đã được tách profile do giới hạn version; “toàn bộ” không có nghĩa nạp mọi extension xung đột vào một session.

Router Jev chọn role mới chỉ ở giai đoạn nghiên cứu, chưa phải tính năng đã bật của setup nguồn, nên installer không tự thêm dispatcher hoặc chạy benchmark tính phí.

Nguồn và giấy phép: [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md). Mã installer/config riêng dùng [MIT](LICENSE).
