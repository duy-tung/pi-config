# Thành phần của bên thứ ba

`pi-config` ghim dependency bằng npm lockfile và giữ giấy phép của từng package trong `node_modules`. Repo không phân phối credential, session hoặc toàn bộ bản cài từ máy nguồn.

## Mã được đóng gói hoặc có đoạn mã trong bản vá

| Thành phần | Phiên bản | Nguồn | Giấy phép kèm theo |
|---|---|---|---|
| Pi coding agent | 0.86.0 và 0.84.4 | [earendil-works/pi](https://github.com/earendil-works/pi) | [MIT — Mario Zechner](vendor/pi.LICENSE) |
| pi-permission-system | 33.0.1 | [gotgenes/pi-packages](https://github.com/gotgenes/pi-packages/tree/main/packages/pi-permission-system) | [MIT — MasuRii và Christopher D. Lasher](vendor/pi-permission-system.LICENSE) |
| pi-subagents | 0.19.0 | [tintinweb/pi-subagents](https://github.com/tintinweb/pi-subagents) | [MIT — tintinweb](vendor/pi-subagents.LICENSE) |
| pi-open-tui | 0.3.6 | [OldSuns/pi-open-tui](https://github.com/OldSuns/pi-open-tui) | [MIT — pi-open-tui contributors](vendor/pi-open-tui.LICENSE) |
| pi-advisor-flow | 0.6.0 | [philipbrembeck/pi-advisor](https://github.com/philipbrembeck/pi-advisor) | [MIT — Philip Brembeck](vendor/pi-advisor-flow.LICENSE) |

`vendor/pi-advisor-flow-0.6.0-pi086.tgz` là package npm 0.6.0 được bổ sung **chỉ** phạm vi peer metadata `0.86.0`; source runtime giữ nguyên trước các bản vá được theo dõi riêng trong `assets/patches.json`. SHA-256 của tarball: `6ac0352f3fc46b65a5961d2c2db54ca8e547b6fd6ee55c9ef966c85ee674b520`. Tarball chứa đầy đủ giấy phép MIT gốc. Profile compat dùng nguyên package npm 0.6.0.

Các bản vá local gồm: footer tối giản; chuẩn hóa MCP arguments cho permission; thông báo vòng đời child session cho permission; khóa auth theo đường dẫn canonical và chia sẻ auth mặc định qua biến môi trường; dùng Pi ModelRuntime cho advisor; backport header phiên OpenCode Go từ Pi 0.86.0 sang 0.84.4. Mọi bản vá kiểm tra phiên bản và SHA-256 source trước khi sửa. Các tác giả upstream không bảo trợ hoặc chứng nhận bản phân phối này.

## Dependency được tải khi cài đặt

Các manifest `manifests/current`, `manifests/compat`, `manifests/firecrawl` liệt kê phiên bản chính xác; `package-lock.json` ghi integrity và giấy phép dependency khi npm cung cấp metadata. Installer tải package trực tiếp từ registry npm, không tái cấp phép package của bên thứ ba. Các override peer của `pi-lens` và `pi-mcp-adapter` giới hạn trong đúng package; override Axios 1.20.0 chỉ thuộc runtime Firecrawl CLI.

Các skill của [mattpocock/skills](https://github.com/mattpocock/skills) (MIT), [firecrawl/cli](https://github.com/firecrawl/cli) (ISC theo package manifest) và [firecrawl/firecrawl-workflows](https://github.com/firecrawl/firecrawl-workflows) (ISC) được tải từ commit ghim cùng repository và thông tin giấy phép gốc. Repo `pi-config` không chép skill vào mã installer.

## Màu giao diện

Ba theme Pi và extension đồng bộ màu terminal là cấu hình local dựa trên bảng màu [Rosé Pine](https://rosepinetheme.com/palette/). Việc chọn màu và độ tương phản đã tham khảo [zed-rose-pine-recast](https://github.com/ng-hai/zed-rose-pine-recast), [rose-pine-blinksh](https://github.com/ng-hai/rose-pine-blinksh), [hyper-rose-pine-next](https://github.com/ng-hai/hyper-rose-pine-next), [rose-pine-doom-emacs](https://github.com/tamnd/rose-pine-doom-emacs) và [typora](https://github.com/tamnd/typora). Các ứng dụng/theme repository đó không được đóng gói trong installer.

Các JSON theme, extension palette, role prompt, AGENTS và mã installer tự xây dựng thuộc giấy phép [MIT của pi-config](LICENSE). Chúng không sao chép implementation theme từ các repository tham khảo.
