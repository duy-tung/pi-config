# Chạy nhiều phiên Pi song song với Orca

[Orca](https://github.com/stablyai/orca) (MIT) là app desktop chạy nhiều agent CLI cùng lúc, mỗi task một git worktree, có diff/review/PR và app điện thoại. Orca hỗ trợ Pi sẵn: nó chạy đúng TUI của Pi, nên pi-open-tui, pi-auto-mode, pi-rewind và các extension khác giữ nguyên.

## Cài

```bash
brew install --cask stablyai/orca/orca
```

Cask tải DMG từ GitHub Releases của Orca và cài thêm CLI `orca`. Sau đó Orca tự cập nhật trong app.

Lần đầu mở:

- Chọn **Pi** làm agent mặc định.
- Bỏ **Yolo / Dangerously skip permissions**. Ô này chỉ tác động tới Claude Code, Codex và các agent tương tự; quyền của Pi do pi-auto-mode quản lý.
- Telemetry (PostHog, ẩn danh) bật sẵn. Tắt ở **Settings → Privacy & Telemetry**. Khi mở app bằng `open -a Orca --env DO_NOT_TRACK=1` thì Orca không gửi gì, nhưng nút tắt trong Settings bị khóa.
- **Settings → Terminal → Option as Alt: Both.** Mặc định là Auto, khi đó Option gõ ra ký tự đặc biệt (Option+T ra "†"), nên Alt+T và Alt+Up của Pi không chạy.

## Phím

| Phím | Trong Orca |
|---|---|
| Shift+Enter | Xuống dòng |
| Alt+T, Alt+Up, Shift+Tab, Esc | Chạy (cần Option as Alt) |
| Alt+Enter | Tới Pi thành Shift+Enter, tức chỉ xuống dòng. Dùng **Ctrl+Enter** để xếp follow-up |
| Ctrl+V | Dán ảnh qua `@pi-archimedes/image-paste`. Cmd+V do Orca xử lý: lưu ảnh ra file tạm rồi dán đường dẫn |

Terminal của Orca (xterm.js) gửi Alt+Enter dạng `ESC CR`. Khi đã bật kitty keyboard, Pi coi chuỗi này là Shift+Enter. Vì vậy installer gán thêm Ctrl+Enter cho `app.message.followUp`; phím mặc định của Pi (Alt+Enter, hoặc Ctrl+Q trên Windows/WSL) vẫn giữ.

Khi Orca khởi động lại hoặc gắn lại một pane, terminal quên chế độ kitty keyboard mà Pi đã bật, nên phím Alt không tới được Pi ([#10381](https://github.com/stablyai/orca/issues/10381)). Thoát Pi trong pane đó rồi mở lại bằng `pi --continue`.

## Trạng thái và thông báo

Orca ghi `orca-agent-status.ts`, `orca-titlebar-spinner.ts` và `orca-prefill.ts` (có marker `@orca-managed`) vào `~/.pi/agent/extensions/`. Ba file này chỉ chạy khi có `ORCA_PANE_KEY`, tức là trong terminal của Orca. Phiên Pi ở terminal khác không bị ảnh hưởng, và pi-doctor không báo lỗi về chúng.

Khi một extension mở hộp thoại, chẳng hạn hộp thoại hỏi quyền của auto mode hay `/models`, Pi phát `ui_prompt_start`. Orca bắt sự kiện này, đánh dấu phiên là **Needs input** và gửi thông báo macOS.

Orca cũng cài hook trạng thái cho các agent khác nó tìm thấy. Với Claude Code, đó là 13 hook trong `~/.claude/settings.json`; Codex và OpenCode cũng có hook tương ứng. Các hook này thoát ngay khi không chạy trong Orca. Xem trạng thái bằng `orca agent hooks status`.

## Worktree

- Orca tạo worktree trong `~/orca/workspaces/<repo>/<task>`. Đổi chỗ ở **Settings → General → Workspace Directory**.
- Pi nhóm phiên theo thư mục làm việc, nên mỗi worktree có phiên riêng và `pi --continue` mở lại đúng phiên đó. pi-rewind và pi-auto-mode cũng tính theo worktree.
- Script setup/archive và các file chép sang worktree (chẳng hạn `.env`) khai báo trong `orca.yaml` và `.worktreeinclude` ở gốc repo. Xem [tài liệu worktree của Orca](https://github.com/stablyai/orca/blob/main/docs/site/content/docs/model/worktrees.mdx).

## Lưu ý

- Orca giữ terminal chạy nền cả khi thoát app. Trước khi chạy `node install.mjs`, thoát mọi phiên Pi, kể cả phiên trong Orca.
- Các phiên song song dùng chung hạn mức Claude Max; footer hiển thị mức đã dùng.
- Trong Orca, Pi tắt ảnh inline và link OSC 8, vì `TERM_PROGRAM=Orca` không nằm trong danh sách Pi nhận diện ([#6880](https://github.com/stablyai/orca/issues/6880)). Có thể ép bật bằng `PI_HYPERLINKS` và `PI_IMAGE_PROTOCOL` (xem `docs/terminal-setup.md` của Pi), nhưng cách này chưa được thử với Orca.
