# Rewind

`pi-rewind` là extension riêng của pi-config (`assets/extensions/pi-rewind`). Giao diện và hành vi theo `/rewind` của Claude Code: mỗi prompt có một checkpoint, chọn prompt để khôi phục code, hội thoại hoặc cả hai.

## Dùng

- `Esc Esc` khi editor trống và agent rảnh, hoặc `/rewind` (alias `/checkpoint`, `/undo`).
- Danh sách prompt trên nhánh hiện tại, cũ ở trên; dòng dưới mỗi prompt là thay đổi code trong lượt đó (`auth.ts +12 -3`, `3 files changed …`, `No code changes`). Prompt không có checkpoint hiện `⚠ No code restore`. Chọn `(current)` để đóng.
- Sau khi chọn prompt: `Restore code and conversation`, `Restore conversation`, `Restore code`, `Summarize from here`, `Summarize up to here`, `Never mind`. Hai lựa chọn tóm tắt nhận thêm chỉ dẫn (`add context (optional)`). Màn hình xác nhận ghi rõ số dòng và file sẽ được khôi phục. Lúc ghi, pi-rewind lập lại kế hoạch và so với màn hình đó: code đã đổi trong lúc hộp thoại mở thì không ghi gì và báo `The code changed since the preview (…)`; mở lại `/rewind` để xem kế hoạch mới. Redo, Undo redo và `/redo` cũng vậy.
- Hộp thoại là overlay neo đáy, rộng hết terminal (cả chế độ fullscreen mặc định của Pi lẫn chế độ thường) và không cao hơn terminal: terminal thấp thì bỏ dòng trống, chi tiết (các dòng sau của prompt, thời gian, cảnh báo bash) trước, luôn giữ mục đang chọn và dòng gợi ý phím.
- Khôi phục hội thoại đưa prompt đã chọn trở lại editor để sửa và gửi lại. Nhánh cũ vẫn còn trong `/tree`.
- **Redo** nằm dưới `(current)` khi có lần rewind để hoàn tác: đưa code về trạng thái ngay trước khi rewind và quay lại nhánh hội thoại cũ. Lệnh `/redo` làm cùng việc đó.
- **Undo redo** xuất hiện ngay sau một lần Redo (tới lần rewind hoặc Redo kế tiếp): đưa code và hội thoại về ngay trước lần Redo, nên việc đã làm sau lần rewind không bị Redo xoá mất. Undo redo được ghi lại như một lần rewind, nên Redo đưa về lại được.
- `/clear` mở phiên mới như `/new`. Trong phiên mới, `Esc Esc` hoặc `/rewind` có mục **Resume previous session** ở đầu danh sách để quay lại phiên vừa rời. Mục này cũng có sau `/new`. Phiên cũ phải đã có câu trả lời, vì Pi chỉ ghi phiên ra đĩa từ lúc đó.
- Nếu Pi thoát giữa lúc khôi phục code, lần mở Pi sau sẽ báo, và `/rewind` có mục **⚠ Interrupted code restore** với ba lựa chọn: `Finish the restore`, `Undo it` (về như trước khi khôi phục) hoặc `Dismiss` (để nguyên file). Chỉ file còn ở nội dung trước hoặc sau lần khôi phục mới được ghi; file đã bị sửa theo cách khác được để nguyên và báo tên.

`doubleEscapeAction` được đặt là `"none"` để `Esc Esc` mở Rewind thay cho `/tree`; `/tree`, `/fork` vẫn dùng bằng lệnh. Nếu đổi lại `doubleEscapeAction` trong `/settings`, `Esc Esc` làm theo lựa chọn đó của Pi và Rewind chỉ mở bằng `/rewind`.

## Theo dõi gì

| Nguồn thay đổi | Cách ghi nhận |
|---|---|
| Tool `edit`, `write` | Lưu nội dung trước lần sửa đầu tiên trong lượt, trước khi tool chạy |
| `bash`, `powershell`, `Agent` (foreground) trong git worktree | `git status` trước/sau tool; file đổi được lưu bản trước (file sạch lấy từ `HEAD` qua filter như checkout, nên kiểu xuống dòng theo `core.autocrlf`) |
| File đã theo dõi, đổi giữa hai prompt | Ảnh chụp đầu mỗi prompt ghi lại phiên bản mới |

Khôi phục code chỉ đụng tới file đã theo dõi trong phiên, giống Claude Code. Không theo dõi: sửa tay trên file chưa từng theo dõi, file bị `.gitignore` sửa bằng bash, bash ngoài git worktree, background agent/shell job, file lớn hơn 20 MiB và file chứa bí mật (`.env`, khóa, `auth.json`…). Symlink, thư mục cha đã đổi hoặc nội dung hiện tại không sao lưu được thì bỏ qua và báo tên file. Repo cần hơn 2 giây để chuẩn bị theo dõi (`git status` và chụp file bẩn), có hơn 500 file chưa commit (ví dụ `node_modules` chưa ignore) hoặc có file chưa commit cần chụp tổng cộng hơn 256 MiB (đo trước khi chụp, không tính file không được lưu như file quá 20 MiB) sẽ tắt theo dõi bash trong phiên và báo; edit/write vẫn được theo dõi.

File có tên nhạy cảm bị loại kể cả khi đã track trong Git hoặc vừa bị xóa; đường dẫn còn phân giải qua symlink tới file nhạy cảm cũng bị loại. Git watcher kiểm trước khi đọc nội dung từ `HEAD`, và bước ghi buffer vào kho kiểm lại. `.env.example`, `.env.sample`, `.env.template` vẫn được sao lưu nếu không trỏ tới file bí mật. Đây là lọc theo tên file, không quét nội dung để phát hiện mọi loại secret; bản sửa không xóa blob đã có trong kho cũ.

## Lưu trữ

- Metadata checkpoint là custom entry `pi-rewind` trong file phiên (không vào context model), nên còn sau `/resume` và đi theo nhánh hội thoại.
- Nội dung file nằm trong kho theo SHA-256 tại `rewind.storageDir` (installer đặt `<root>/state/rewind`), quyền 0600. Tối đa mỗi ngày một lần, blob không được dùng trong 30 ngày (`retentionDays`) bị dọn; sau đó, nếu tổng dung lượng blob vượt `maxStorageBytes` (mặc định 2 GiB), blob lâu không được dùng nhất bị xóa tới khi còn 90% giới hạn. Blob mà nhật ký phục hồi còn cần không bị xóa, blob được dùng trong 24 giờ qua không bị xóa vì dung lượng, nên giới hạn là best-effort: kho vẫn vượt nếu một ngày lưu nhiều hơn giới hạn. Checkpoint cũ có blob đã bị xóa không khôi phục được file đó (báo thiếu bản lưu).
- Trước mỗi lần ghi file để khôi phục (rewind, Redo, Undo redo), pi-rewind ghi nhật ký phục hồi vào `journal/` trong thư mục đó: danh sách file cùng nội dung trước và sau. Nhật ký bị xóa khi xong, kể cả khi lỗi. Nhật ký còn lại mà process ghi nó đã chết là lần khôi phục bị gián đoạn. Nhật ký quá `retentionDays` bị dọn cùng blob.
- Khôi phục ghi mỗi file ra file tạm cùng thư mục, `fsync` rồi đổi tên đè, nên lỗi giữa chừng (đĩa đầy) để nguyên file cũ. Quyền của file (rwx) được khôi phục đủ. Hai trường hợp ghi tại chỗ như tool `write` của Pi: file có hard link (để các link vẫn chung nội dung), và khi không tạo được file tạm hoặc không đổi tên đè được (thư mục không ghi được, Windows đang khóa file). Nếu lỗi xảy ra lúc đang ghi tại chỗ, file được báo `partly written`; lần khôi phục vẫn được ghi lại để Redo (hoặc Undo redo) đưa file về bản trước đó.
- Ngay trước khi ghi từng file, pi-rewind đọc lại file: file đã đổi kể từ lúc lập kế hoạch (người dùng vừa lưu, process khác vừa ghi) được để nguyên, báo `file đổi trong lúc khôi phục`, và Redo không đụng tới nó.
- Các process Pi dùng chung `storageDir` giữ khóa `lock` trong đó (chứa pid) khi ghi code (rewind, Redo, Undo redo, phục hồi) và khi dọn kho. Khóa bận thì chờ tối đa 5 giây rồi báo `Another Pi process is restoring code (pid N)` và không ghi gì; lần dọn kho gặp khóa bận thì bỏ qua. Khóa của process đã chết hoặc cũ hơn 10 phút được gỡ. Phục hồi đọc lại nhật ký sau khi có khóa: process khác đã xử lý thì báo và dừng. Chụp checkpoint không cần khóa; blob bị dọn đúng lúc đang chụp được ghi lại.
- Nếu không lưu được checkpoint (đĩa đầy, `storageDir` không ghi được), `edit` và `write` bị chặn kèm lý do cho model và thông báo cho người dùng, để file vẫn khôi phục được. pi-rewind thử lưu lại ở mỗi tool call và chạy bình thường khi kho ghi được. Lệnh `bash` vẫn chạy nhưng thay đổi của nó không khôi phục được trong lúc đó. Muốn tiếp tục mà không có rewind thì đặt `rewind.enabled: false`.

## Cấu hình

Khối `rewind` trong `settings.json` của agent: `enabled`, `storageDir`, `retentionDays` (mặc định 30). Giới hạn dung lượng (file 20 MiB, kho 2 GiB) và danh sách tool được theo dõi (bash, powershell, Agent) cố định trong code. Esc Esc mở Rewind khi `doubleEscapeAction` là `none` (installer đặt sẵn). `PI_REWIND_DISABLE=1` tắt trong một lần chạy. Settings của project không đổi được các giá trị này.
