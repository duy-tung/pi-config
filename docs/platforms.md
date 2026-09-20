# Hệ điều hành và bootstrap

Installer cài vào thư mục của người dùng, không yêu cầu `sudo` hoặc Administrator. Bản Node được ghim **24.15.0**. Nếu Node đang có đúng phiên bản này thì dùng lại; nếu thiếu hoặc khác phiên bản, bootstrap tải bản riêng và kiểm SHA256 đã ghim trước khi chạy. Không thay Node của các dự án khác.

| Hệ điều hành | Kiến trúc có binary | Điều kiện |
| --- | --- | --- |
| macOS | Apple Silicon, Intel | `bash`, `curl`, `tar`, `shasum`; có sẵn trên macOS phù hợp với Node 24 |
| Linux | x64, ARM64 | `bash`, `curl`, `tar`, `sha256sum`; distro dùng glibc tương thích với Node 24 |
| Windows 10/11 | x64, ARM64 | PowerShell 5.1 trở lên; bootstrap tự cài Git for Windows portable nếu chưa có Git Bash |

Alpine/musl, Windows 32-bit và các CPU khác chưa hỗ trợ. Có binary ARM64 không đồng nghĩa đã kiểm thử đầy đủ trên ARM64 Linux/Windows: ma trận CI dùng runner do GitHub cấp, xem kiến trúc và kết quả thực ở mỗi run.

## Cài một lệnh

macOS/Linux:

```bash
curl -fsSL https://raw.githubusercontent.com/duy-tung/pi-config/main/install.sh | bash
```

Windows PowerShell:

```powershell
& ([scriptblock]::Create((Invoke-RestMethod 'https://raw.githubusercontent.com/duy-tung/pi-config/main/install.ps1').TrimStart([char]0xFEFF)))
```

Không cần đăng nhập GitHub. Hai lệnh lấy phiên bản hiện tại của nhánh `main`; để tái lập chính xác, thay `main` trong URL bằng commit đã kiểm chứng **và** đặt `PI_CONFIG_REF` cùng commit đó. Installer không mang theo đăng nhập, API key hoặc lịch sử của máy nguồn. Đăng nhập dịch vụ trên máy đích là bước riêng.

Lệnh Windows bỏ BOM trước khi thực thi chuỗi tải về. File `.ps1` giữ UTF-8 BOM để Windows PowerShell 5.1 đọc tiếng Việt đúng khi chạy từ file; không dùng `irm URL | iex` thiếu bước bỏ BOM.

## Tuỳ chỉnh và kiểm thử cô lập

Bootstrap chuyển nguyên tham số sang `install.mjs`, ví dụ:

```bash
PI_CONFIG_SOURCE="$PWD" bash install.sh --root "/tmp/pi test/platform" --agent-dir "/tmp/pi test/agent" --bin-dir "/tmp/pi test/bin" --no-path
```

```powershell
$env:PI_CONFIG_SOURCE = (Get-Location).Path
& .\install.ps1 --root "$env:TEMP\pi test\platform" --agent-dir "$env:TEMP\pi test\agent" --bin-dir "$env:TEMP\pi test\bin" --no-path
```

- `PI_CONFIG_SOURCE`: dùng checkout local, bỏ bước tải repo; hữu ích cho CI.
- `PI_CONFIG_REF`: commit, tag hoặc branch để tải; mặc định `main`.
- `PI_CONFIG_BOOTSTRAP_DIR`: nơi đặt Node/Git tải thêm. Mặc định Unix: `${XDG_DATA_HOME:-~/.local/share}/pi-config/bootstrap`; Windows: `%LOCALAPPDATA%\pi-config\bootstrap`.
- `PI_CONFIG_GIT_BASH`: Windows có thể trỏ đến `bash.exe` hiện có. Bootstrap không chọn `bash.exe` của WSL.
- `PI_CONFIG_FRESH_TOOLCHAIN=1`: bỏ qua Node/Git có sẵn trên `PATH`, dùng bản trong thư mục bootstrap. CI bật chế độ này để kiểm chứng cả đường tải mới, hash và giải nén; thư mục toolchain đã cài đúng vẫn được dùng lại.

Node nằm trong thư mục bootstrap phải còn tồn tại để launcher tiếp tục chạy. Thư mục repo tạm được xoá sau khi cài; các file runtime mà installer cần phải được đặt trong root đích.

Git portable Windows được ghim **2.55.0.5**, tải từ bản phát hành chính thức và kiểm SHA256 trước khi giải nén. Nó cung cấp Bash cùng công cụ Unix cho tool `bash` của Pi. Không cài WSL hoặc sửa cấu hình Git toàn máy.

## Phạm vi kiểm chứng

Workflow `.github/workflows/test.yml` chạy trên Ubuntu, Windows và macOS: kiểm tra repo, unit tests, cài package thật, kiểm runtime bằng provider giả và chạy bootstrap với đường dẫn có khoảng trắng. Bootstrap trong CI tải Node riêng trên cả ba hệ điều hành và tải Git portable trên Windows để không bỏ sót nhánh máy mới chưa có toolchain. Windows còn chạy lại script dạng chuỗi UTF-8 sau khi bỏ BOM qua `ScriptBlock::Create`, đúng cách dùng one-liner; các đường dẫn thử được truyền dưới dạng mảng để giữ nguyên khoảng trắng. Không dùng API key hoặc gọi model trả phí. Chỉ xem nền tảng đã nghiệm thu khi job tương ứng của commit cài đặt thành công; cấu hình workflow riêng chưa chứng minh tương thích.

Bootstrap kiểm hash Node/Git đã ghim; archive của chính repo dùng HTTPS và commit/ref lựa chọn, không có chữ ký phát hành riêng. Với cài đặt cần kiểm soát chặt, tải script về, kiểm source và ghim commit trước khi chạy.

Nguồn chính thức: [Node 24.15.0 SHA256](https://nodejs.org/dist/v24.15.0/SHASUMS256.txt), [Git for Windows 2.55.0.5](https://github.com/git-for-windows/git/releases/tag/v2.55.0.windows.5), [Node platforms](https://github.com/nodejs/node/blob/v24.15.0/BUILDING.md#platform-list).
