# Model và thinking của từng vai

Model và mức thinking của mỗi vai nằm thẳng trong file cấu hình mà Pi và package đọc. Đổi bằng giao diện có sẵn của Pi và từng package. Không có file cấu hình vai riêng hay lệnh riêng của pi-config.

| Vai | Dùng ở | Đổi bằng | File |
|---|---|---|---|
| `main` | Phiên chính (parent) | `/model` của Pi | `settings.json` và `executor` trong `advisor.json` |
| `researcher`, `worker`, `reviewer` | Agent của pi-subagents | `/agents` → Agent types → chọn vai → **Model** / **Thinking** | dòng `model:`/`thinking:` trong `agents/<vai>.md` |
| `advisor` | pi-advisor-flow | `/advisor-models` | `advisor`, `advisorEffort` trong `advisor.json` |

- **Phiên chính.** `/model` của Pi chỉ đổi cho phiên hiện tại (Ctrl+S mới lưu mặc định), nhưng advisor luôn bật lưu model đó vào `executor` và đặt lại ở mỗi lần mở phiên. Vì vậy phiên sau cũng dùng model này. Thinking của phiên chính theo `settings.json`: installer không ghi `executorEffort`, nên advisor không đặt lại thinking. Chọn mức trong `/advisor-models` thì advisor lưu mức đó vào `executorEffort` và đặt lại thinking ở mỗi lần mở phiên.
- **Subagent.** Bản vá của pi-subagents thêm hai mục vào menu của mỗi agent có file:
  - **Model:** ô tìm trên cả catalog; model đang dùng đứng đầu, rồi đến model của provider đã đăng nhập. Chọn xong thì chọn tiếp thinking trong các mức model đó hỗ trợ.
  - **Thinking:** chỉ đổi mức thinking.

  Mỗi lần chọn chỉ ghi lại hai dòng `model:`/`thinking:` của file, phần còn lại giữ nguyên, và có hiệu lực từ lần gọi `Agent` kế tiếp. Mục **Edit** vẫn mở cả file để sửa tay.
- **Advisor.** `/advisor-models` của pi-advisor-flow chọn model advisor, model executor và fallback; có hiệu lực từ lần hỏi advisor kế tiếp.

Model của bộ phân loại auto mode không phải một vai: đổi trong `/permissions` → Classifier → Change classifier model…, lưu vào `autoMode.model` và `autoMode.stage2Reasoning` của `settings.json` và áp ngay cho phiên. Mặc định là Claude Sonnet 5.5 / low. Xem [docs/auto-mode.md](auto-mode.md#cấu-hình).

## Mặc định

Installer ghi mặc định trong `assets/configs/model-defaults.json` vào các file trên. File này cập nhật theo bản phát hành.

| Vai | Mặc định |
|---|---|
| `main` | Claude Opus 5.5 / high |
| `researcher` | GLM-5.3-Flash / max |
| `worker` | GPT-6.1 Sol / max |
| `reviewer` | GPT-6 Astra / high |
| `advisor` | GPT-6 Astra / high |

`enabledModels` (danh sách của Ctrl+P) và `modelThinkingLevels` (mức thinking khi đổi sang một model) được suy ra từ các mặc định này, model của `main` đứng đầu. Đổi bằng `/scoped-models` của Pi.

Cài lại gộp ba chiều các file đó:
- Giá trị bạn đã đổi qua `/model`, `/agents` hay `/advisor-models` được giữ.
- Vai bạn chưa đổi nhận mặc định mới.
- Nếu bạn đã đổi một vai mà bản mới cũng đổi mặc định của vai đó, installer giữ giá trị của bạn và báo xung đột kèm mặc định mới.

Mặc định cần đăng nhập Claude, Codex và OpenCode Go. Chỉ có Claude thì sau khi cài, đăng nhập Claude (`/login`) rồi đổi các vai còn lại sang Claude, ví dụ:
- researcher dùng Sonnet 5.5;
- worker dùng Opus 5.5;
- reviewer và advisor dùng Fable 5.1, khác model với worker.

Model phân loại của auto mode mặc định đã là Claude.

Advisor mặc định khác `main`, vì hỏi chính mình không thêm góc nhìn. Tuy vậy, chặn advisor trùng model (`advisorDisableSameModel`) vẫn được tắt trong `advisor.json`, vì fallback `advisorFallbackModel` (Opus 5.5, dùng khi request tới advisor lỗi) trùng model của phiên chính. Ảnh trong hội thoại được gửi kèm cho advisor khi model advisor nhận ảnh.

## Advisor: gate và số lượt

Gate là thời điểm system prompt dặn phiên chính gọi `ask_advisor`. Installer ghi mặc định vào `advisor.json`:
- bật gate `failure`: sau hai lần thử giống nhau đều thất bại, hoặc hai bước liền không tiến triển;
- bật gate `completion`: trước khi báo xong một việc không nhỏ;
- tắt gate `plan`;
- tối đa 5 lần gọi mỗi phiên.

Đổi bằng `/advisor-settings` của pi-advisor-flow. Cài lại giữ giá trị bạn đã đổi.

Advisor không viết code: nó đọc hội thoại (lời gọi tool và kết quả) rồi trả ý kiến kèm rủi ro và cách kiểm chứng. Phiên chính quyết định áp dụng gì.

## Kiểm tra

`pi-doctor` in model đang có hiệu lực của mọi vai (kèm file quyết định giá trị đó) và kiểm trong catalog của Pi, không gọi mạng và không đọc `auth.json`. Catalog gồm model có sẵn, model khai báo trong `models.json` và catalog Pi đã tải về.
- **Model sai tên là lỗi, kèm chỗ đổi.** Sai tên rất tốn kém: pi-subagents sẽ lặng lẽ chạy vai đó bằng model của parent. Trong `/agents`, danh sách Agent types cũng đánh dấu model không dùng được là `(unavailable, fallback: inherit)`.
- **Mức thinking model không hỗ trợ chỉ là ghi chú,** kèm mức Pi sẽ dùng. Ví dụ GLM không có `medium` nên Pi dùng `high`.

Installer cũng kiểm các model mặc định trước khi ghi cấu hình.

## Chuyển từ model-roles.json

Bản trước có `<agent-dir>/model-roles.json` (mặc định + ghi đè, đổi bằng `/models`). Giá trị của file này đã nằm sẵn trong các file trên. Lần cài đầu sau khi nâng cấp, installer:
1. coi các giá trị đó là lựa chọn của bạn, nên chúng được giữ ở lần cài này và các lần sau;
2. chuyển `model-roles.json` vào `<root>/backups`;
3. in một dòng báo.

Bạn không cần làm gì thêm. Lệnh `/models` đã gỡ.

## File role

Installer gộp file `agents/*.md` theo từng khóa của frontmatter. Phần prompt được gộp như một giá trị:
- Sửa dòng `model`, `thinking` hay `tools` không làm installer giữ nguyên cả file. Prompt mới của bản phát hành vẫn được cập nhật.
- Nếu bạn sửa phần prompt và bản mới cũng đổi phần đó, installer giữ bản của bạn và báo lại. Muốn nhận prompt mới: đổi tên file rồi cài lại.

## Giới hạn

- Role của project (`.pi/agents/*.md`) và `.pi/settings.json` của project không theo mặc định của installer. `/agents` đổi model của chính file mà pi-subagents đang nạp, kể cả file của project.
- Model phân loại của auto mode (`autoMode.model`, đổi trong `/permissions`), model Jev của bước 1 (`autoMode.jev.model`) và model tìm kiếm của pi-web-access không phải vai.
- `pi-test` kiểm cơ chế của bản cài với các model mặc định, vì provider giả chỉ có các model này. Model bạn chọn được `pi-doctor` kiểm trong catalog.
