# Model và thinking của từng vai

Model và mức thinking của mọi vai đặt ở một chỗ: `<agent-dir>/model-roles.json`. Đổi bằng lệnh `pi-models`, bằng `/models` ngay trong Pi, hoặc sửa file này; các lệnh đó và installer sinh các file cấu hình gốc từ file này. Không cần sửa file role `.md`.

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

Chọn preset: `pi-models preset claude`, hoặc thêm `--models claude` vào lệnh cài (`curl … | bash -s -- --models claude`; Windows: thêm `--models claude` sau `& ([scriptblock]::Create(…))`).

## pi-models

| Lệnh | Việc |
|---|---|
| `pi-models` | Bảng model/thinking của mọi vai, vai lệch với `model-roles.json`, kiểm catalog, provider chưa đăng nhập |
| `pi-models list [provider]` | Provider trong catalog của Pi: đã đăng nhập chưa, số model, vai đang dùng. Kèm tên provider thì in từng model và mức thinking model hỗ trợ |
| `pi-models preset <tên>` | Chọn preset có sẵn hoặc preset riêng |
| `pi-models set <vai> [provider/id] [thinking]` | Ghi đè model và/hoặc thinking của một vai, vd `pi-models set worker anthropic/claude-opus-5-5 high` |
| `pi-models reset <vai>...` hoặc `--all` | Bỏ ghi đè; vai dùng lại giá trị của preset |
| `pi-models adopt [vai...]` | Chép giá trị đang chạy của các vai lệch (đổi qua `/model`, `/agents`...) vào `model-roles.json` |
| `pi-models apply [--reset]` | Áp `model-roles.json` vào file gốc sau khi bạn sửa tay file này; `--reset` ép cả vai đang lệch |

- **Áp ngay.** Các lệnh ghi sửa `model-roles.json` rồi áp phần model vào `settings.json`, `advisor.json`, `pi-goal-x-settings.json`, `agents/*.md` và `AGENTS.md`, không cần chạy lại installer. Cách gộp giống installer: phần khác bạn đã sửa trong các file đó được giữ, file bị ghi lại có backup trong `<root>/backups`, và lần cài sau không phải ghi lại gì.
- **Có hiệu lực.** Lệnh báo vai nào nhận giá trị mới khi nào. Với phiên Pi đang mở ở terminal khác: vai của pi-subagents từ lần gọi `Agent` kế tiếp, advisor từ lần hỏi kế tiếp; phiên chính, goal auditor, Oracle và auto mode từ phiên Pi mở sau. `/models` trong chính phiên đó áp ngay nhiều hơn (xem dưới).
- **Vai bị ép.** Vai mà lệnh đổi giá trị, và vai được nêu trong `set`/`reset`, nhận giá trị mới trong file gốc kể cả khi bạn đã đổi vai đó qua `/model` hay `/agents`; lệnh in giá trị bị thay. Vai khác giữ giá trị bạn đã đổi.
- **Kiểm tra.** Kiểm như installer (xem [Kiểm tra](#kiểm-tra)); có lỗi thì không ghi gì.
- **Xem trước.** Thêm `--dry-run` để in thay đổi mà không ghi file.
- **Khóa.** `pi-models` và installer dùng chung khóa `<root>/.install.lock`, nên không ghi cùng lúc.

## /models trong phiên

Trong Pi, `/models` làm đúng việc của `pi-models`: cùng lệnh con (`/models set worker anthropic/claude-opus-5-5 high`, `/models preset claude`, `--dry-run`…), cùng bước kiểm, cách gộp và khóa.

- **Menu.** `/models` không tham số mở bảng các vai: giá trị theo `model-roles.json`, kèm giá trị đang chạy khi lệch. Chọn một vai để:
  - đổi model: ô tìm trên cả catalog, model của provider đã đăng nhập xếp trước;
  - đổi thinking: chỉ các mức model đó hỗ trợ;
  - bỏ ghi đè.

  Menu còn có mục chọn preset, và giữ hoặc bỏ giá trị lệch (`adopt`, `apply --reset`). Mọi thay đổi được xem trước, và chỉ ghi khi bạn xác nhận.
- **Gợi ý tham số.** Gợi ý lệnh con, vai, preset, provider, model đã đăng nhập và mức thinking.
- **Catalog của phiên.** Model và trạng thái đăng nhập được kiểm bằng catalog và credential mà phiên đang dùng. Provider chưa đăng nhập thì gợi ý `/login`.
- **Áp ngay trong phiên:**

  | Vai | Có hiệu lực |
  |---|---|
  | `main` | Ngay: phiên này chuyển sang model và thinking mới. Nếu provider chưa đăng nhập thì phiên giữ model cũ và lệnh báo lại |
  | `autoMode` | Từ lần phân loại kế tiếp của auto mode |
  | `researcher`, `worker`, `debugger`, `reviewer` | Từ lần gọi `Agent` kế tiếp |
  | `advisor` | Từ lần hỏi advisor kế tiếp |
  | `auditor`, `oracle` | Từ phiên mới (`/new`, `/resume`) hoặc phiên Pi mở sau |

  `/models` không tự chạy `/reload`, vì reload dừng các subagent đang chạy.

## model-roles.json

Installer tạo file này ở lần cài đầu với `{"preset": "default", "roles": {}}` (hoặc preset của `--models`). Từ đó file thuộc về bạn: installer không lưu trữ nó và chỉ ghi `preset` khi bạn cài với `--models`. Chỉ ghi những gì khác preset:

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

Sửa tay file này xong thì chạy `pi-models apply`, `/models apply` hoặc chạy lại installer. Thời điểm có hiệu lực như ở trên.

## Kiểm tra

Installer và các lệnh ghi của `pi-models` dừng trước khi ghi cấu hình khi:
- `model-roles.json` không phải JSON, có khóa, vai hay mức thinking không hỗ trợ, hoặc chọn preset không tồn tại. Từng lỗi được báo riêng.
- Model không có trong catalog của Pi. Catalog gồm model có sẵn, model khai báo trong `models.json` và catalog Pi đã tải về. Sai tên model rất tốn kém, vì pi-subagents sẽ lặng lẽ chạy vai đó bằng model của parent.

Mức thinking mà model không hỗ trợ không làm dừng việc ghi; chỉ có báo mức Pi sẽ dùng; ví dụ GLM không có `medium`, nên dùng `high`. pi-goal-x chỉ nhận tới `xhigh`, nên `max` của `auditor` và `oracle` được ghi thành `xhigh`.

`pi-models` và `pi-doctor` in bảng model của mọi vai và kiểm catalog, bằng cách đọc file và không gọi mạng. Model sai tên là lỗi, kể cả model nằm trong file gốc.

`pi-models` còn cảnh báo provider của vai chưa đăng nhập (chạy `pi-login` rồi `/login`). Nó chỉ đọc tên provider và loại credential trong `auth.json`, không đọc giá trị; key từ biến môi trường được kiểm theo cách của Pi, không chạy lệnh `!…` của key đã lưu và không làm mới token.

## Giá trị đổi ngoài model-roles.json

Các giao diện sẵn có vẫn đổi được model:
- **`/model`:** Pi chỉ đổi cho phiên hiện tại (Ctrl+S mới lưu mặc định). Nhưng advisor luôn bật lưu model đó vào `executor`, nên phiên sau cũng dùng model này.
- **`/goal-settings`:** ghi `pi-goal-x-settings.json`.
- **`/agents`:** sửa file role.
- Sửa tay các file gốc.

Khi cài lại, giá trị đổi theo cách này được giữ, vì file gốc được gộp ba chiều. Nếu bạn sửa tay chính vai đó trong `model-roles.json` rồi cài lại hoặc chạy `pi-models apply`, giá trị trong file gốc vẫn được giữ và có báo xung đột. `pi-models preset/set/reset` và `--models` thì ép các vai chúng đổi.

`pi-models` và `pi-doctor` hiện những vai lệch, ví dụ `worker: … theo agents/worker.md; model-roles.json: …`. Muốn giữ giá trị đó: `pi-models adopt <vai>`. Muốn dùng lại `model-roles.json`: `pi-models apply --reset`.

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
- `pi-models` dựng cấu hình mới từ mặc định installer lưu ở lần cài trước (`<root>/state/defaults`). Thiếu bản lưu này thì lệnh ghi báo lỗi; chạy lại installer một lần.
- `AGENTS.md` bạn đã sửa được giữ nguyên, nên tên model trong đó có thể cũ.
- `/models` chỉ quản lý agent dir của bản cài; phiên chạy với `PI_CODING_AGENT_DIR` khác sẽ báo lỗi. Trong phiên đang mở, danh sách Ctrl+P (`enabledModels`) và mức thinking mặc định theo model chỉ cập nhật từ phiên sau.
