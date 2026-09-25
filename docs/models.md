# Model và thinking của từng vai

Model và mức thinking của mọi vai đặt ở một chỗ: `<agent-dir>/model-roles.json`. Installer sinh các file cấu hình gốc từ file này. Không cần sửa file role `.md`.

## Vai

| Vai | Dùng ở | File gốc installer sinh ra |
|---|---|---|
| `main` | Phiên chính (parent) | `settings.json` (`defaultProvider`, `defaultModel`, `defaultThinkingLevel`) và `executor` trong `advisor.json` |
| `researcher`, `worker`, `debugger`, `reviewer` | Agent của pi-subagents | dòng `model:`/`thinking:` trong `agents/<vai>.md` |
| `advisor` | pi-advisor-flow | `advisor`, `advisorEffort` trong `advisor.json` |
| `auditor`, `oracle` | Goal auditor và Oracle của pi-goal-x | `provider`/`model`/`thinkingLevel` và khối `oracle` trong `pi-goal-x-settings.json` |
| `autoMode` | Bộ phân loại LLM của auto mode | `autoMode.model`, `autoMode.stage2Reasoning` trong `settings.json` |

`enabledModels` (danh sách của Ctrl+P và `scopeModels` của pi-subagents) và `modelThinkingLevels` (mức thinking khi đổi sang một model) được suy ra từ các vai: model của `main` đứng đầu, model của auto mode không vào danh sách.

Vai `main` ghi cả `executor` của advisor: khi advisor luôn bật, mỗi lần mở phiên nó đặt model của phiên chính thành `executor`.

## Preset

Preset có sẵn nằm ở `assets/configs/model-presets.json` và cập nhật theo bản phát hành.

| Vai | `default` | `claude` |
|---|---|---|
| `main` | Claude Opus 5.5 / high | Claude Opus 5.5 / high |
| `researcher` | GLM-5.3-Flash / max | Claude Sonnet 5 / high |
| `worker`, `debugger` | GPT-6 Sol / max | Claude Opus 5.5 / high |
| `reviewer` | GPT-6 Astra / high | Claude Fable 5.1 / high |
| `advisor` | GPT-6 Astra / high | Claude Fable 5.1 / high |
| `auditor` | GPT-6 Astra / high | Claude Sonnet 5 / high |
| `oracle` | GPT-6 Astra / high | Claude Fable 5.1 / high |
| `autoMode` | Claude Sonnet 5 / low | Claude Sonnet 5 / low |

- **`default`:** cần đăng nhập Claude, Codex và OpenCode Go.
- **`claude`:** chỉ cần Claude. Reviewer, advisor và Oracle dùng một model khác với model viết code.

## model-roles.json

Installer tạo file này ở lần cài đầu với `{"preset": "default", "roles": {}}`. Từ đó file thuộc về bạn: installer không ghi đè và không lưu trữ nó. Chỉ ghi những gì khác preset:

```json
{
  "preset": "claude",
  "roles": {
    "worker": { "thinking": "max" },
    "researcher": { "model": "openai-codex/gpt-6-sol", "thinking": "low" }
  },
  "presets": {
    "claude-sonnet": { "description": "Claude, worker rẻ hơn", "extends": "claude", "roles": { "worker": { "model": "anthropic/claude-sonnet-5" } } }
  }
}
```

- **`preset`:** tên preset có sẵn, hoặc preset riêng trong `presets`.
- **`roles.<vai>`:** `model` dạng `provider/id` (xem `/model` hoặc `pi --list-models`), `thinking` là một trong `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`. Có thể đặt riêng từng trường.
- **`presets.<tên>`:** chỉ đặt những vai khác với preset nó kế thừa (`extends`, mặc định `default`). `extends` phải là preset có sẵn, và tên preset riêng không được trùng tên preset có sẵn.

Đổi file rồi chạy lại installer (lệnh cài đặt một dòng, hoặc `node install.mjs` với cùng tham số). Vai của pi-subagents đọc lại file role ở mỗi lần gọi `Agent`. Phiên chính, advisor, goal và auto mode nhận model mới ở phiên sau. `pi-models` chỉ xem, không ghi.

## Kiểm tra

Installer dừng trước khi ghi cấu hình khi:
- `model-roles.json` không phải JSON, có khóa, vai hay mức thinking không hỗ trợ, hoặc chọn preset không tồn tại. Installer báo từng lỗi.
- Model không có trong catalog của Pi. Catalog gồm model có sẵn, model khai báo trong `models.json` và catalog Pi đã tải về. Sai tên model rất tốn kém, vì pi-subagents sẽ lặng lẽ chạy vai đó bằng model của parent.

Mức thinking mà model không hỗ trợ không làm dừng installer. Installer chỉ báo mức Pi sẽ dùng; ví dụ GLM không có `medium`, nên dùng `high`. pi-goal-x chỉ nhận tới `xhigh`, nên `max` của `auditor` và `oracle` được ghi thành `xhigh`.

`pi-models` và `pi-doctor` in bảng model của mọi vai và kiểm catalog, bằng cách đọc file và không gọi mạng. Model sai tên là lỗi, kể cả model nằm trong file gốc.

## Giá trị đổi ngoài model-roles.json

Các giao diện sẵn có vẫn đổi được model:
- **`/model`:** Pi chỉ đổi cho phiên hiện tại (Ctrl+S mới lưu mặc định). Nhưng advisor luôn bật lưu model đó vào `executor`, nên phiên sau cũng dùng model này.
- **`/goal-settings`:** ghi `pi-goal-x-settings.json`.
- **`/agents`:** sửa file role.
- Sửa tay các file gốc.

Khi cài lại, giá trị đổi theo cách này được giữ, vì file gốc được gộp ba chiều. Nếu bạn cũng đổi chính vai đó trong `model-roles.json`, installer giữ giá trị trong file gốc và báo xung đột.

`pi-models` và `pi-doctor` hiện những vai lệch, ví dụ `worker: … theo agents/worker.md; model-roles.json: …`. Muốn giữ giá trị đó thì ghi vào `roles.<vai>`; không thì đổi lại trong file gốc.

## File role

Installer gộp file `agents/*.md` theo từng khóa của frontmatter. Phần prompt được gộp như một giá trị:
- Sửa dòng `model`, `thinking` hay `tools` không còn làm installer giữ nguyên cả file. Prompt mới của bản phát hành vẫn được cập nhật.
- Nếu bạn sửa phần prompt và bản mới cũng đổi phần đó, installer giữ bản của bạn và báo lại. Muốn nhận prompt mới: đổi tên file rồi cài lại.

## Nâng cấp từ bản cài trước

Ở bản cài chưa có `model-roles.json`, installer chuyển model/thinking bạn đã sửa trong `agents/*.md` thành ghi đè trong `model-roles.json`. Việc này chỉ làm một lần và installer báo lại. Giá trị bạn đã đổi trong `settings.json`, `advisor.json` và `pi-goal-x-settings.json` được giữ theo cách gộp ở trên.

## Giới hạn

- Role của project (`.pi/agents/*.md`) và `.pi/settings.json` của project không theo `model-roles.json`.
- Model Jev của bước 1 auto mode (`autoMode.jev.model`) và model tìm kiếm của pi-web-access không thuộc `model-roles.json`.
- `pi-test` kiểm cơ chế của bản cài với các model của preset `default`, vì provider giả chỉ có các model này. Model bạn chọn được `pi-doctor` kiểm trong catalog.
