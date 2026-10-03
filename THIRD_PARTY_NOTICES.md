# Thành phần của bên thứ ba

`pi-config` ghim dependency bằng npm lockfile và giữ giấy phép của từng package trong `node_modules`. Repo không phân phối credential, session hoặc toàn bộ bản cài từ máy nguồn.

## Mã được đóng gói hoặc có đoạn mã trong bản vá

| Thành phần | Nguồn | Giấy phép kèm theo |
|---|---|---|
| Pi coding agent | [earendil-works/pi](https://github.com/earendil-works/pi) | [MIT — Mario Zechner](vendor/pi.LICENSE) |
| pi-subagents | [tintinweb/pi-subagents](https://github.com/tintinweb/pi-subagents) | [MIT — tintinweb](vendor/pi-subagents.LICENSE) |
| pi-open-tui | [OldSuns/pi-open-tui](https://github.com/OldSuns/pi-open-tui) | [MIT — pi-open-tui contributors](vendor/pi-open-tui.LICENSE) |
| pi-advisor-flow | [philipbrembeck/pi-advisor](https://github.com/philipbrembeck/pi-advisor) | [MIT — Philip Brembeck](vendor/pi-advisor-flow.LICENSE) |
| @pi-archimedes/image-paste | [danielcherubini/pi-archimedes](https://github.com/danielcherubini/pi-archimedes) | [MIT](vendor/pi-archimedes.LICENSE) |
| pi-web-access | [nicobailon/pi-web-access](https://github.com/nicobailon/pi-web-access) | [MIT — Nico Bailon](vendor/pi-web-access.LICENSE) |
| @gotgenes/pi-anthropic-auth | [gotgenes/pi-anthropic-auth](https://github.com/gotgenes/pi-anthropic-auth) | [MIT — Christopher D. Lasher](vendor/pi-anthropic-auth.LICENSE) |
| @narumitw/pi-usage | [narumiruna/pi-extensions](https://github.com/narumiruna/pi-extensions) | [MIT — narumiruna](vendor/pi-usage.LICENSE) |

Các tarball `vendor/*-pi100.tgz` giữ source npm và giấy phép gốc, chỉ bổ sung `1.0.0` vào peer metadata của pi-background-tasks. Phiên bản của từng thành phần: bảng trong [README](README.md#phiên-bản). URL/integrity upstream và SHA256 bản đóng gói được ghi trong `manifests/current/package.json`. Script `scripts/rebuild-vendor.py` kiểm nguồn và tái tạo các tarball trên môi trường phát triển có Python 3.12 trở lên và curl; máy cài Pi không cần Python.

Nguồn bổ sung: [pi-background-tasks](https://github.com/ismailsaleekh/pi-background-tasks). Giấy phép của các package nằm nguyên trong package npm hoặc tarball.

`pi-rewind` (`assets/extensions/pi-rewind`) là mã riêng của pi-config (MIT). Nhãn và bố cục giao diện theo `/rewind` của Claude Code; ý tưởng kỹ thuật tham khảo [pi-workspace-history](https://github.com/wcldyx/pi-workspace-history) (MIT) nhưng không chép mã.

`pi-auto-mode` (`assets/extensions/pi-auto-mode`) là mã riêng của pi-config (MIT). Hành vi và giao diện theo các permission mode (default, auto, bypassPermissions) của Claude Code (tài liệu và bài viết kỹ thuật công khai của Anthropic), cùng ý tưởng duyệt tự động của OpenAI Codex auto-review và guardian v2; prompt, bộ luật và mã được viết riêng, không chép văn bản hay mã của Claude Code hoặc Codex. Giai đoạn 1 và probe prompt injection gọi API System One (model Jev) của TypeSafe, một dịch vụ bên ngoài dùng key của người dùng. Client, câu hỏi và ngưỡng được viết riêng theo tài liệu công khai của TypeSafe, không dùng SDK; ý tưởng tham khảo cookbook của OpenRouter, [jev-guard](https://github.com/leepokai/jev-guard) (MIT) và [pi-jev-auto-mode](https://github.com/jomatsu/pi-jev-auto-mode) (MIT), không chép mã.

`claude-usage` (`assets/extensions`) và provider `anthropic` của pi-web-access (`assets/patches/pi-web-access/anthropic-search.js`, installer chèn vào `dist/index.js` của pi-web-access) là mã riêng của pi-config (MIT). Tìm kiếm Claude dùng server tool `web_search_20250305` theo cách WebSearch của Claude Code (request phụ), với prompt viết riêng; trường của `/api/oauth/usage` và header `anthropic-ratelimit-unified-*` tham khảo Claude Code và [pi-usage-meters](https://github.com/Quigleybits/pi-usage-meters) (MIT), không chép mã.

Chín bản vá runtime: footer tối giản, quota Codex/Claude cạnh model, context kèm token/cửa sổ; chuyển lifecycle child session cho cổng permission (pi-auto-mode) và cho entry thư mục của package khớp tên package trong `extensions` của role; hiện kết quả subagent dạng Markdown khi mở rộng và thêm mục Model/Thinking vào menu agent của `/agents` (pi-subagents); gọi advisor qua ModelRuntime, giữ system prompt cố định khi đếm lượt advisor và chỉ bật advisor khi Always on kích hoạt được (hoặc `/advisor`); giới hạn background vào shell jobs và viết gọn mô tả `bg_run` (job xong vẫn tự đánh thức model như upstream); giữ image-paste preview ở UI để ảnh không vào context hai lần; thêm provider `anthropic` (native search Claude) vào pi-web-access; pi-usage không truy vấn quota hay đặt timer trong phiên không có UI (Agent con), thêm GPT-6 Astra và GPT-6.1 Sol vào Codex fast và áp fast cho request qua ModelRuntime dùng chung (advisor). pi-subagents chuyển `typebox` và `@sinclair/typebox` sang peer dependency để Pi 0.99 không cảnh báo dependency lúc khởi động; loader của Pi cấp bản typebox của nó. Background attribution entrypoint không được nạp; Claude auth do pi-anthropic-auth quản lý. Mọi bản vá kiểm phiên bản và SHA256 source/kết quả. Các tác giả upstream không bảo trợ hoặc chứng nhận bản phân phối này.

## Dependency được tải khi cài đặt

Các manifest `manifests/current`, `manifests/firecrawl` liệt kê phiên bản chính xác; `package-lock.json` ghi integrity và giấy phép dependency khi npm cung cấp metadata. Installer tải package trực tiếp từ registry npm, không tái cấp phép package của bên thứ ba. Override Axios 1.20.0 chỉ thuộc runtime Firecrawl CLI.

Các skill của [firecrawl/cli](https://github.com/firecrawl/cli) (ISC theo package manifest) được tải từ commit ghim cùng repository và thông tin giấy phép gốc.

## Git guard

Git guard của pi-auto-mode (`lib/git-guard.ts`) chuyển từ `hooks/guard_git.py` của tstack (mã riêng, MIT).

## Màu giao diện

Theme Pi và extension đồng bộ màu terminal là cấu hình local dựa trên bảng màu [Rosé Pine](https://rosepinetheme.com/palette/). Nguồn tham khảo về màu và độ tương phản gồm [zed-rose-pine-recast](https://github.com/ng-hai/zed-rose-pine-recast), [rose-pine-blinksh](https://github.com/ng-hai/rose-pine-blinksh), [hyper-rose-pine-next](https://github.com/ng-hai/hyper-rose-pine-next), [rose-pine-doom-emacs](https://github.com/tamnd/rose-pine-doom-emacs) và [typora](https://github.com/tamnd/typora). Các ứng dụng/theme repository đó không được đóng gói trong installer.

Các JSON theme, extension palette, role prompt, AGENTS và mã installer tự xây dựng thuộc giấy phép [MIT của pi-config](LICENSE). Chúng không sao chép implementation theme từ các repository tham khảo.
