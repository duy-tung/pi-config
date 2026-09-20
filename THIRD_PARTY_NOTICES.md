# Thành phần của bên thứ ba

`pi-config` ghim dependency bằng npm lockfile và giữ giấy phép của từng package trong `node_modules`. Repo không phân phối credential, session hoặc toàn bộ bản cài từ máy nguồn.

## Mã được đóng gói hoặc có đoạn mã trong bản vá

| Thành phần | Phiên bản | Nguồn | Giấy phép kèm theo |
|---|---|---|---|
| Pi coding agent | 0.86.1 | [earendil-works/pi](https://github.com/earendil-works/pi) | [MIT — Mario Zechner](vendor/pi.LICENSE) |
| pi-permission-system | 33.0.1 | [gotgenes/pi-packages](https://github.com/gotgenes/pi-packages/tree/main/packages/pi-permission-system) | [MIT — MasuRii và Christopher D. Lasher](vendor/pi-permission-system.LICENSE) |
| pi-subagents | 0.19.0 | [tintinweb/pi-subagents](https://github.com/tintinweb/pi-subagents) | [MIT — tintinweb](vendor/pi-subagents.LICENSE) |
| pi-open-tui | 0.3.6 | [OldSuns/pi-open-tui](https://github.com/OldSuns/pi-open-tui) | [MIT — pi-open-tui contributors](vendor/pi-open-tui.LICENSE) |
| pi-advisor-flow | 0.6.0 | [philipbrembeck/pi-advisor](https://github.com/philipbrembeck/pi-advisor) | [MIT — Philip Brembeck](vendor/pi-advisor-flow.LICENSE) |

Các tarball `vendor/*-pi0861.tgz` giữ source npm và giấy phép gốc, chỉ bổ sung `0.86.1` vào peer metadata của pi-advisor-flow, pi-goal-x, pi-background-tasks, pi-workspace-history, pi-lens và pi-mcp-adapter. URL/integrity upstream và SHA256 bản đóng gói được ghi trong `manifests/current/package.json`. Script `scripts/rebuild-vendor.py` kiểm nguồn và tái tạo các tarball trên môi trường phát triển có Python 3.12 trở lên và curl; máy cài Pi không cần Python.

Nguồn bổ sung: [pi-goal-x](https://github.com/tmonk/pi-goal-x), [pi-background-tasks](https://github.com/ismailsaleekh/pi-background-tasks), [pi-workspace-history](https://github.com/wcldyx/pi-workspace-history). Giấy phép của các package nằm nguyên trong tarball.

Năm bản vá runtime: footer tối giản; chuẩn hóa MCP arguments cho permission; chuyển lifecycle child session cho permission; gọi advisor qua ModelRuntime; giới hạn background vào shell jobs với notification không tự đánh thức model mặc định. Background attribution entrypoint không được nạp; Claude auth do pi-anthropic-auth quản lý. Mọi bản vá kiểm phiên bản và SHA256 source/kết quả. Các tác giả upstream không bảo trợ hoặc chứng nhận bản phân phối này.

## Dependency được tải khi cài đặt

Các manifest `manifests/current`, `manifests/firecrawl` liệt kê phiên bản chính xác; `package-lock.json` ghi integrity và giấy phép dependency khi npm cung cấp metadata. Installer tải package trực tiếp từ registry npm, không tái cấp phép package của bên thứ ba. Override Axios 1.20.0 chỉ thuộc runtime Firecrawl CLI.

Các skill của [mattpocock/skills](https://github.com/mattpocock/skills) (MIT), [firecrawl/cli](https://github.com/firecrawl/cli) (ISC theo package manifest) và [firecrawl/firecrawl-workflows](https://github.com/firecrawl/firecrawl-workflows) (ISC) được tải từ commit ghim cùng repository và thông tin giấy phép gốc. Repo `pi-config` không chép skill vào mã installer.

## Màu giao diện

Ba theme Pi và extension đồng bộ màu terminal là cấu hình local dựa trên bảng màu [Rosé Pine](https://rosepinetheme.com/palette/). Nguồn tham khảo về màu và độ tương phản gồm [zed-rose-pine-recast](https://github.com/ng-hai/zed-rose-pine-recast), [rose-pine-blinksh](https://github.com/ng-hai/rose-pine-blinksh), [hyper-rose-pine-next](https://github.com/ng-hai/hyper-rose-pine-next), [rose-pine-doom-emacs](https://github.com/tamnd/rose-pine-doom-emacs) và [typora](https://github.com/tamnd/typora). Các ứng dụng/theme repository đó không được đóng gói trong installer.

Các JSON theme, extension palette, role prompt, AGENTS và mã installer tự xây dựng thuộc giấy phép [MIT của pi-config](LICENSE). Chúng không sao chép implementation theme từ các repository tham khảo.
