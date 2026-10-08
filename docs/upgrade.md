# Nâng phiên bản Pi và package

Mọi thứ cài vào runtime đều ghim: phiên bản trong `manifests/current/package.json`, integrity trong `package-lock.json`, tarball `vendor/*.tgz` theo sha256, và từng bản vá theo checksum source trước/sau (`assets/patches.json`). Nâng một package là cập nhật cả chuỗi này theo thứ tự dưới. Hai script làm phần tính toán; bước nào cũng chạy lại được.

## 1. Manifest

Sửa phiên bản trong `manifests/current/package.json` (`dependencies` và, với package vendor, `piPlatform.localPackages.<tên>`: `version`, `source`, `upstreamTarball`, `upstreamIntegrity` lấy từ `npm view <tên>@<phiên bản> dist.integrity`). Tên tarball vendor mang phiên bản Pi mà nó mở peer range, vd `pi-background-tasks-2.6.9-pi110.tgz`; đổi Pi thì đổi hậu tố và đường dẫn `file:` trong `dependencies`.

## 2. Tarball vendor

Package có peer range `@earendil-works/pi-*` chưa gồm phiên bản Pi đang ghim được đóng gói lại, chỉ thêm `|| <phiên bản Pi>` vào peer metadata:

```sh
python3 scripts/rebuild-vendor.py --write
```

Script tải tarball upstream, kiểm integrity, sửa peer metadata, đóng gói lại tất định (cùng byte trên Python 3.11–3.13) và in `sha256` mới cho package đã đổi; chép số đó vào `localPackages.<tên>.sha256`. Không `--write` thì script chỉ kiểm, và CI chạy đúng bước kiểm này để chứng minh tarball trong repo tái tạo được từ upstream. Package upstream đã gồm phiên bản Pi thì bỏ khỏi `localPackages` và dùng bản npm.

## 3. Lockfile

Tạo lockfile trong thư mục tạm có cùng bố cục (`manifests/current` và `vendor` cạnh nhau), không cài vào repo:

```sh
tmp=$(mktemp -d) && mkdir -p "$tmp/manifests" && cp -r manifests/current "$tmp/manifests/" && cp -r vendor "$tmp/"
(cd "$tmp/manifests/current" && npm install --package-lock-only --ignore-scripts --no-audit --no-fund)
cp "$tmp/manifests/current/package-lock.json" manifests/current/
```

Đọc diff của lockfile: chỉ các package định nâng và dependency của chúng được đổi.

## 4. Bản vá

```sh
node scripts/rehash-patches.mjs          # cài lockfile vào thư mục tạm, áp từng bản vá, báo neo không khớp
node scripts/rehash-patches.mjs --write  # ghi phiên bản và checksum mới vào assets/patches.json
```

`OK` là bản vá khớp như cũ; `NEW` là source đổi nhưng mọi neo `before` vẫn khớp đúng số lần, checksum mới được tính; `FAIL` là neo không còn khớp: đọc source mới, sửa `before`/`after` (hoặc file trong `assets/patches/`) rồi chạy lại. Bản vá upstream đã sửa thì xoá spec. `--modules <node_modules>` dùng một runtime có sẵn chưa vá.

## 5. Kiểm và tài liệu

- `npm run check`, `npm test` (gồm `patched-typecheck`: bản vá không thêm lỗi kiểu), `npm run smoke` (cài thật với provider giả).
- Rà breaking change trong CHANGELOG của Pi và từng package: API extension, tên tool, sự kiện, cấu hình mặc định.
- Cập nhật bảng phiên bản và đoạn về vendor trong README; `THIRD_PARTY_NOTICES.md` khi thêm/bỏ package hoặc vendor; `AGENTS.md` của repo và `docs/` khi hành vi đổi.
- Đẩy nhánh và chờ CI xanh trên cả ba hệ điều hành.
