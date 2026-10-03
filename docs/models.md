# Model và thinking của từng vai

Model và mức thinking của mọi vai đặt ở một chỗ: `<agent-dir>/model-roles.json`. Đổi bằng `/models` ngay trong Pi: menu ghi file này rồi áp ngay vào các file cấu hình gốc. Installer cũng sinh các file gốc từ file này. Không cần sửa file role `.md`.

## Vai

| Vai | Dùng ở | File gốc installer sinh ra |
|---|---|---|
| `main` | Phiên chính (parent) | `settings.json` (`defaultProvider`, `defaultModel`, `defaultThinkingLevel`) và `executor` trong `advisor.json` |
| `researcher`, `worker`, `debugger`, `reviewer` | Agent của pi-subagents | dòng `model:`/`thinking:` trong `agents/<vai>.md` |
| `advisor` | pi-advisor-flow | `advisor`, `advisorEffort` trong `advisor.json` |
| `autoMode` | Bộ phân loại LLM của auto mode | `autoMode.model`, `autoMode.stage2Reasoning` trong `settings.json` |

`enabledModels` (danh sách của Ctrl+P và `scopeModels` của pi-subagents) và `modelThinkingLevels` (mức thinking khi đổi sang một model) được suy ra từ các vai: model của `main` đứng đầu, model của auto mode không vào danh sách.

Vai `main` ghi cả `executor` của advisor: khi advisor luôn bật, mỗi lần mở phiên nó đặt model của phiên chính thành `executor`. Mọi preset đặt advisor khác `main` (hỏi chính mình không thêm góc nhìn). Chặn advisor trùng model của pi-advisor-flow (`advisorDisableSameModel`) được tắt trong `advisor.json`, vì fallback `advisorFallbackModel` (Opus 5.5, dùng khi request tới advisor lỗi) trùng model của phiên chính; hai khóa này không thuộc `model-roles.json`, `/models` không đổi chúng. Ảnh trong hội thoại cũng được gửi kèm cho advisor khi model advisor nhận ảnh.

## Advisor: gate và số lượt

Gate (thời điểm system prompt dặn phiên chính gọi `ask_advisor`) và số lần gọi tối đa mỗi phiên không thuộc `model-roles.json`. Installer ghi mặc định vào `advisor.json`: gate `failure` (sau hai lần thử giống nhau đều thất bại, hoặc hai bước liền không tiến triển) và `completion` (trước khi báo xong việc không nhỏ), tắt gate `plan`, tối đa 5 lần mỗi phiên. Đổi bằng `/advisor-settings` của pi-advisor-flow; cài lại giữ giá trị bạn đã đổi, vì `advisor.json` được gộp ba chiều.

Advisor không viết code: nó đọc hội thoại (lời gọi tool và kết quả), trả ý kiến kèm rủi ro và cách kiểm chứng; phiên chính quyết định áp dụng gì.

## Preset

Preset có sẵn nằm ở `assets/configs/model-presets.json` và cập nhật theo bản phát hành.

| Vai | `default` | `claude` |
|---|---|---|
| `main` | Claude Opus 5.5 / high | Claude Opus 5.5 / high |
| `researcher` | GLM-5.3-Flash / max | Claude Sonnet 5.5 / high |
| `worker`, `debugger` | GPT-6.1 Sol / max | Claude Opus 5.5 / high |
| `reviewer` | GPT-6 Astra / high | Claude Fable 5.1 / high |
| `advisor` | GPT-6 Astra / high | Claude Fable 5.1 / high |
| `autoMode` | Claude Sonnet 5.5 / low | Claude Sonnet 5.5 / low |

- **`default`:** cần đăng nhập Claude, Codex và OpenCode Go.
- **`claude`:** chỉ cần Claude. Reviewer và advisor dùng một model khác với model viết code.

Chọn preset: `/models` → **Chọn preset…**. Lần cài đầu dùng `default`; muốn dùng `claude` ngay thì mở `pi`, đăng nhập Claude (`/login`) rồi chọn preset.

## /models

`/models` mở bảng các vai: giá trị theo `model-roles.json`, kèm giá trị đang chạy khi lệch. Chọn một vai để:
- đổi model: ô tìm trên cả catalog, model của provider đã đăng nhập xếp trước;
- đổi thinking: chỉ các mức model đó hỗ trợ;
- bỏ ghi đè (khi vai có ghi đè): vai dùng lại giá trị của preset.

Menu còn có mục chọn preset, và khi có vai lệch, mục đưa các vai lệch về `model-roles.json` ([xem dưới](#giá-trị-đổi-ngoài-model-rolesjson)). Mọi thay đổi được xem trước, và chỉ ghi khi bạn xác nhận. Phiên không có giao diện (vd chế độ RPC không có UI) thì `/models` chỉ in bảng các vai.

- **Áp ngay.** Thay đổi sửa `model-roles.json` rồi áp phần model vào `settings.json`, `advisor.json` và `agents/*.md`, không cần chạy lại installer. Cách gộp giống installer: phần khác bạn đã sửa trong các file đó được giữ, file bị ghi lại có backup trong `<root>/backups`, và lần cài sau không phải ghi lại gì.
- **Vai bị ép.** Vai mà thay đổi đổi giá trị (vai bạn chọn, hoặc các vai preset mới khác preset cũ) nhận giá trị mới trong file gốc kể cả khi bạn đã đổi vai đó qua `/model` hay `/agents`; bản xem trước in giá trị bị thay. Vai khác giữ giá trị bạn đã đổi.
- **Kiểm tra.** Kiểm như installer (xem [Kiểm tra](#kiểm-tra)), bằng catalog và credential mà phiên đang dùng; có lỗi thì không ghi gì. Provider chưa đăng nhập thì gợi ý `/login`.
- **Khóa.** `/models` và installer dùng chung khóa `<root>/.install.lock`, nên không ghi cùng lúc.
- **Có hiệu lực:**

  | Vai | Trong phiên chạy `/models` | Phiên Pi khác đang mở |
  |---|---|---|
  | `main` | Ngay: phiên này chuyển sang model và thinking mới. Nếu provider chưa đăng nhập thì phiên giữ model cũ và `/models` báo lại | Phiên Pi mở sau |
  | `autoMode` | Từ lần phân loại kế tiếp của auto mode | Phiên Pi mở sau |
  | `researcher`, `worker`, `debugger`, `reviewer` | Từ lần gọi `Agent` kế tiếp | Từ lần gọi `Agent` kế tiếp |
  | `advisor` | Từ lần hỏi advisor kế tiếp | Từ lần hỏi advisor kế tiếp |

  `/models` không tự chạy `/reload`, vì reload dừng các subagent đang chạy.

## model-roles.json

Installer tạo file này ở lần cài đầu với `{"preset": "default", "roles": {}}`. Từ đó file thuộc về bạn: installer không ghi và không lưu trữ nó. File chỉ ghi những gì khác preset:

```json
{
  "preset": "claude",
  "roles": {
    "worker": { "thinking": "max" },
    "researcher": { "model": "openai-codex/gpt-6.1-sol", "thinking": "low" }
  }
}
```

- **`preset`:** tên preset có sẵn (`default` hoặc `claude`). Preset riêng (khóa `presets`) không còn được hỗ trợ: installer và `/models` báo lỗi; chuyển các vai của preset riêng vào `roles`.
- **`roles.<vai>`:** `model` dạng `provider/id` (xem `/model` hoặc `pi --list-models`), `thinking` là một trong `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`. Có thể đặt riêng từng trường.
- Ghi đè của vai đã gỡ (`auditor`, `oracle`) không phải lỗi: installer, `/models` và `pi-doctor` bỏ qua và in một dòng cảnh báo; xoá khỏi file để hết cảnh báo.

Sửa tay file này xong thì chạy lại installer, hoặc mở `/models`: vai bạn sửa hiện là vai lệch, và mục đưa vai lệch về `model-roles.json` áp file vào các file gốc.

## Kiểm tra

Installer và `/models` dừng trước khi ghi cấu hình khi:
- `model-roles.json` không phải JSON, có khóa, vai hay mức thinking không hỗ trợ, hoặc chọn preset không tồn tại. Từng lỗi được báo riêng.
- Model không có trong catalog của Pi. Catalog gồm model có sẵn, model khai báo trong `models.json` và catalog Pi đã tải về. Sai tên model rất tốn kém, vì pi-subagents sẽ lặng lẽ chạy vai đó bằng model của parent.

Mức thinking mà model không hỗ trợ không làm dừng việc ghi; chỉ có báo mức Pi sẽ dùng; ví dụ GLM không có `medium`, nên dùng `high`.

`/models` và `pi-doctor` in bảng model của mọi vai và kiểm catalog, không gọi mạng. Model sai tên là lỗi, kể cả model nằm trong file gốc. `pi-doctor` không đọc `auth.json`; `/models` cảnh báo thêm provider của vai chưa đăng nhập theo credential của phiên.

## Giá trị đổi ngoài model-roles.json

Các giao diện sẵn có vẫn đổi được model:
- **`/model`:** Pi chỉ đổi cho phiên hiện tại (Ctrl+S mới lưu mặc định). Nhưng advisor luôn bật lưu model đó vào `executor`, nên phiên sau cũng dùng model này.
- **`/agents`:** sửa file role.
- Sửa tay các file gốc.

Khi cài lại, giá trị đổi theo cách này được giữ, vì file gốc được gộp ba chiều. Nếu bạn sửa tay chính vai đó trong `model-roles.json` rồi cài lại, giá trị trong file gốc vẫn được giữ và có báo xung đột.

`/models` và `pi-doctor` hiện những vai lệch, ví dụ `worker: … theo agents/worker.md; model-roles.json: …`. Muốn giữ giá trị đó: trong `/models`, chọn vai và đặt đúng giá trị ấy (nó thành ghi đè trong `model-roles.json`). Muốn dùng lại `model-roles.json`: `/models` → **Đưa … về model-roles.json**; mục này ép mọi vai về `model-roles.json` và in giá trị bị thay.

## File role

Installer gộp file `agents/*.md` theo từng khóa của frontmatter. Phần prompt được gộp như một giá trị:
- Sửa dòng `model`, `thinking` hay `tools` không còn làm installer giữ nguyên cả file. Prompt mới của bản phát hành vẫn được cập nhật.
- Nếu bạn sửa phần prompt và bản mới cũng đổi phần đó, installer giữ bản của bạn và báo lại. Muốn nhận prompt mới: đổi tên file rồi cài lại.

## Giới hạn

- Role của project (`.pi/agents/*.md`) và `.pi/settings.json` của project không theo `model-roles.json`.
- Model Jev của bước 1 auto mode (`autoMode.jev.model`) và model tìm kiếm của pi-web-access không thuộc `model-roles.json`.
- `pi-test` kiểm cơ chế của bản cài với các model của preset `default`, vì provider giả chỉ có các model này. Model bạn chọn được `pi-doctor` kiểm trong catalog.
- `/models` dựng cấu hình mới từ mặc định installer lưu ở lần cài trước (`<root>/state/defaults`). Thiếu bản lưu này thì `/models` báo lỗi khi ghi; chạy lại installer một lần.
- `/models` chỉ quản lý agent dir của bản cài; phiên chạy với `PI_CODING_AGENT_DIR` khác sẽ báo lỗi. Trong phiên đang mở, danh sách Ctrl+P (`enabledModels`) và mức thinking mặc định theo model chỉ cập nhật từ phiên sau.
