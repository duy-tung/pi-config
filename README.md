# pi-config

[![Kiểm thử cài đặt](https://github.com/duy-tung/pi-config/actions/workflows/test.yml/badge.svg)](https://github.com/duy-tung/pi-config/actions/workflows/test.yml)

Bộ cài Pi cho **macOS, Linux và Windows**: model theo vai trò, context riêng cho agent, Firecrawl cho web, permission cho công cụ và giao diện Rosé Pine. Dependency, nguồn skills và bản vá được ghim để tái lập cấu hình.

## Cài đặt

macOS / Linux:

```sh
curl -fsSL https://raw.githubusercontent.com/duy-tung/pi-config/main/install.sh | bash
```

Windows PowerShell 5.1 trở lên:

```powershell
& ([scriptblock]::Create((Invoke-RestMethod 'https://raw.githubusercontent.com/duy-tung/pi-config/main/install.ps1').TrimStart([char]0xFEFF)))
```

Bootstrap chuẩn bị Node **24.15.0** theo user và Git Bash trên Windows khi cần, kiểm SHA256 rồi chạy installer. Mở terminal mới và chạy `pi`. Không cần đăng nhập GitHub hoặc quyền quản trị để cài.

Chi tiết kiến trúc CPU, công cụ hệ thống và tùy chọn đường dẫn: [docs/platforms.md](docs/platforms.md). Có thể xem [install.sh](install.sh), [install.ps1](install.ps1) và [install.mjs](install.mjs) trước khi chạy.

## Đăng nhập dịch vụ

1. Chạy `pi-login`, dùng `/login` và chọn **OpenAI Codex** cho Astra/Sol.
2. Trong `/login`, chọn **OpenCode Go** và nhập API key cho GLM. Pi cũng nhận biến môi trường `OPENCODE_API_KEY`.
3. Chạy `firecrawl login --browser` để đăng nhập dịch vụ web.

Bốn profile dùng chung auth của main qua launcher. Firecrawl dùng credential store của CLI theo hệ điều hành. Repo không chứa credential, token hay dữ liệu phiên của người dùng; không nhập key vào chat hoặc commit vào Git.

## Profile

| Lệnh | Pi | Model chính | Công việc |
|---|---|---|---|
| `pi` | 0.86.0 | Astra/high | Phân tích, giao task và nghiệm thu |
| `pi-goal` | 0.84.4 | Astra/high | Goal dài hạn và workspace history |
| `pi-background` | 0.84.4 | Astra/high | Công việc nền |
| `pi-advisor` | 0.86.0 | Sol/high | Executor, tham khảo advisor Astra/high khi cần |

Các profile tách theo khả năng tương thích của extension. Astra/Sol dùng context **872K**; GLM dùng catalog native **1M**. Main dùng Rosé Pine Moon; các profile khác dùng Rosé Pine. Có thêm theme Dawn.

## Agent

Main và goal dùng `Agent` của **@tintinweb/pi-subagents**:

| Role | Model/effort | Phạm vi |
|---|---|---|
| `researcher` | GLM-5.3-Flash/max | Khảo sát code/docs/log, thu thập bằng chứng; chỉ đọc |
| `worker` | GPT-5.6 Sol/high | Triển khai và kiểm thử phần việc đã chốt |
| `debugger` | GPT-5.6 Sol/high | Tái hiện lỗi, tìm nguyên nhân, sửa và kiểm hồi quy |
| `reviewer` | GPT-5.6 Sol/high | Review độc lập; chỉ đọc |

Parent Astra/high giữ thiết kế, quyết định quan trọng và nghiệm thu cuối. GLM chạy trực tiếp qua OpenCode Go trong Pi.

```text
@researcher Tìm luồng xử lý timeout và báo file/dòng.
@worker Triển khai phần đã chốt, chạy kiểm thử liên quan.
@debugger Tái hiện lỗi và sửa với regression test.
@reviewer Review diff, nêu lỗi có bằng chứng.
```

Agent có context riêng, giới hạn 12 turns với grace 2. Mỗi pool foreground/background có tối đa 2 agent; parent điều phối để tránh ghi chồng file. Chi tiết cấu hình, quyền và vòng đời: [docs/subagents.md](docs/subagents.md).

## Công cụ và mặc định

- Web: `web_search`, `fetch_content`, `get_search_content` dùng Firecrawl; CLI và skills hỗ trợ các workflow bổ sung.
- MCP filesystem: công cụ đọc trong workspace, kết nối khi cần.
- Code intelligence: pi-lens, TypeScript language server cài sẵn; Go/Rust/Python dùng language server của máy hoặc project.
- Native compaction bật: reserve 16.384, giữ gần nhất 20.000 token.
- Cache warming, auditor goal, advisor auto và các workflow tính phí tự động tắt.
- Main có `codexFastMode:true`; hiệu lực và mức dùng quota phụ thuộc model/provider được hỗ trợ.
- Header/footer/editor do pi-open-tui quản lý. Footer hiển thị model, thinking, quota, context %, token/cost và trạng thái công cụ liên quan. Palette terminal theo theme của phiên và được phục hồi khi thoát.

`pi-models` xem cấu hình model. `pi-doctor` kiểm dependency, bản vá và các file cần thiết tại máy. Trong Pi dùng `/model`, `/thinking`, `/usage`, `/agents`, `/mcp`, `/lens-health` hoặc `/open-tui` theo profile.

Permission kiểm soát công cụ, không thay thế sandbox hệ điều hành. Project cần được trust trước khi dùng cấu hình của project. Nguồn web là dữ liệu để tham khảo, không phải instruction.

## Phiên bản

| Thành phần | Phiên bản |
|---|---|
| `@tintinweb/pi-subagents` | 0.19.0 |
| `@gotgenes/pi-anthropic-auth` | 2.0.10 |
| `@gotgenes/pi-permission-system` | 33.0.1 |
| `pi-mcp-adapter` | 2.34.0 |
| `pi-web-access` | 0.29.0 |
| `@juicesharp/rpiv-ask-user-question`, `rpiv-todo` | 2.10.1 |
| `@narumitw/pi-usage` | 0.60.8 |
| `pi-lens` | 4.2.1 |
| `pi-background-tasks` | 2.5.0 |
| `pi-goal-x`, `pi-workspace-history` | 0.31.6 / 0.4.3 |
| `pi-advisor-flow` | 0.6.0 |
| `pi-open-tui` | 0.3.6 |
| Firecrawl CLI | 1.23.3 |
| Engineering và Firecrawl skills | Commit trong [sources.lock.json](sources.lock.json) |

Các manifest và lockfile nằm trong [manifests](manifests). Bản vá tương thích có source hash, kết quả hash và điều kiện phiên bản tại [assets/patches.json](assets/patches.json).

## Quản lý cấu hình

Mặc định: runtime ở `~/.local/share/pi-platform`, main agent ở `~/.pi/agent`, launcher ở `~/.local/bin`. Windows dùng các thư mục tương ứng trong user profile.

Installer chỉ quản lý bản cài có `install-state.json` phù hợp. Với root đã có dữ liệu khác, dùng đường dẫn riêng:

```sh
node install.mjs --root /duong-dan/platform --agent-dir /duong-dan/agent --bin-dir /duong-dan/bin --no-path
```

Cấu hình chỉ được tạo cho profile sử dụng nó: role/subagents cho main–goal, goal settings cho goal, advisor settings cho advisor.

Khi chạy lại, installer dùng lockfile và checksum để kiểm tính nhất quán. File đã tùy chỉnh được giữ và báo đường dẫn. Tài nguyên do installer quản lý, không còn được yêu cầu và chưa chỉnh sửa, được lưu vào backup; tài nguyên còn được cấu hình tham chiếu được giữ. Các loại trừ extension và path deny được bảo toàn. Auth và file riêng của người dùng không thuộc danh sách tài nguyên được dọn.

Dừng các phiên Pi trước khi cập nhật. Dùng revision đã qua CI thay vì chạy `pi update` hoặc `npm update` trên runtime ghim. Nếu còn `.install.lock`, kiểm tra PID và chỉ xóa lock khi tiến trình đó đã dừng.

## Phát triển và kiểm thử

```sh
npm run check
npm test
npm run smoke
```

CI chạy trên Ubuntu, Windows và macOS: kiểm repo, cấu hình, request payload, cài sạch, các profile bằng provider giả, cài lại giữ tùy chỉnh và bootstrap với đường dẫn có khoảng trắng. Test không dùng credential thật hoặc gọi model trả phí. Đây là kiểm chứng runtime và bộ cài; chất lượng model và quyền truy cập tài khoản được đánh giá riêng.

Nguồn và giấy phép: [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md). Mã riêng của dự án dùng [MIT](LICENSE).
