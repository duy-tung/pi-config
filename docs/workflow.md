# Quy trình làm việc: skills trên Pi

pi-config cài sẵn bộ skill quy trình **tstack**, chuyển từ Claude Code sang Pi và gắn với các thành phần của pi-config: vai model, goal, auto mode, pi-lens và rewind. tstack gộp phần tốt nhất của hai bộ skill mã nguồn mở:
- **`skills` của Matt Pocock**: căn chỉnh trước khi build, ở trong smart zone, spec → tickets → TDD, review tách trục, ngôn ngữ domain.
- **`pstack` của Lauren Tan**: chứng minh trên sản phẩm thật, kỷ luật bằng chứng, mã hoá bài học vào cấu trúc, chạy không giám sát có hợp đồng, review đối kháng.

Skill nằm trong `assets/skills/` của repo và được cài vào `<root>/assets/skills/`. Nguồn gốc và giấy phép ở cuối trang.

## Năm trụ cột và cơ chế trên Pi

| Trụ cột | Trên Pi |
|---|---|
| **Căn chỉnh trước khi build** | `/skill:grill-with-docs` hỏi từng vòng, mỗi câu có đáp án đề xuất. Sự thật do agent tự tra (giao `researcher`), quyết định là của người. Câu "cách nào tốt hơn" mà chạy thử trả lời được thì agent tự làm prototype. |
| **Ở trong smart zone** | Footer báo vùng context theo mép 150k: xanh, vàng khi gần mép, đỏ khi quá mép. `/context-budget` đo phần luôn-bật. Việc đọc rộng giao `researcher`. Hết một pha thì chọn: tiếp tục, `/clear`, handoff, subagent hoặc `/compact`. |
| **Chứng minh trên sản phẩm thật** | Mỗi app có verify skill kèm feature map (`/skill:create-verify`). Vai `verifier`, context sạch và không sửa code, trả VERIFIED, NOT VERIFIED hoặc INCONCLUSIVE kèm bằng chứng. Người viết không tự chấm. |
| **Mã hoá bài học vào cấu trúc** | Thang ưu tiên, từ mạnh nhất: type và kiến trúc; lint, hook, CI và luật pi-lens; `CODING_STANDARDS.md`; skill; một dòng trong AGENTS.md. `/skill:reflect` đưa mỗi bài học lên nấc cao nhất có thể. |
| **Tự chủ có hợp đồng** | Việc đảo ngược được thì cứ làm. `/skill:afk` chạy theo hợp đồng viết, **như một goal** (xem dưới). Git guard trong auto mode chặn tất định các lệnh git phá huỷ. |

## Bắt đầu

```text
/skill:setup            một lần mỗi repo: tracker, AGENTS.md, CODING_STANDARDS.md, format và hook
/skill:create-verify    một lần mỗi app: verify skill + feature map trong .agents/skills/verify-<app>/
/skill:work ?           bất cứ lúc nào: "giờ nên chạy lệnh gì?"
```

Skill kỷ luật (grilling, tdd, diagnose, prove, interrogate…) được model tự nạp khi việc khớp mô tả; bạn cũng có thể gọi tên. Skill luồng chỉ người dùng gọi được, bằng `/skill:<tên> [tham số]`: gõ `/` rồi tìm tên trong danh sách lệnh.

## Luồng hằng ngày

```text
/skill:grill-with-docs <ý tưởng>      căn chỉnh; CONTEXT.md và ADR cập nhật ngay trong lúc hỏi
  ├─ vừa một smart zone  → /skill:implement
  └─ lớn hơn             → /skill:to-spec → /skill:to-tickets
                            → mỗi ticket: /clear rồi /skill:implement <ticket>
/skill:ship                           PR: commit có thứ tự, body kiểu briefing, bằng chứng
/skill:ship babysit <PR>              conflict → review thread → CI (chờ bằng bg_run); không tự merge
/skill:reflect                        sau task dài hoặc gập ghềnh: lỗi lặp → type, lint, hook, chuẩn
```

`/skill:implement` theo build playbook, gồm bảy bước:
1. đặt tên hình dạng dữ liệu;
2. kiểm thiết kế ở ranh giới module;
3. TDD tại các seam đã thống nhất;
4. `verifier` chứng minh trên sản phẩm thật;
5. commit nhỏ;
6. `interrogate` review bằng các `reviewer` sạch, rồi sửa mục "Act on";
7. đóng ticket kèm SHA, kết luận và bằng chứng.

| Tình huống | Lệnh |
|---|---|
| Không biết bắt đầu từ đâu | `/skill:work <mô tả>` (tự chọn playbook) hoặc `/skill:work ?` |
| Có bug | `/skill:work <triệu chứng>`: tái hiện đỏ trước, sửa tận gốc, chứng minh hai lần trước và hai lần sau |
| Chậm một lần / tối ưu một chỉ số qua nhiều lần thử | `/skill:work`: playbook perf / hillclimb |
| Refactor, đổi hàng loạt, migration | `/skill:work`: playbook refactor / wide-change (codemod bằng `ast_grep_replace` của pi-lens) |
| Đi ngủ, để agent tự chạy | `/skill:afk <mục tiêu hoặc tickets> done: <điều kiện kiểm được>` |
| Việc lớn, còn mù mờ | `/skill:wayfinder` |
| Issue và PR người khác gửi | `/skill:triage` |
| Chuyển việc sang phiên hoặc người khác | `/skill:handoff` |
| Tin nhắn của agent khó hiểu | `/skill:wait-what` |
| Phiên chậm, ồn, tốn token | `/context-budget` rồi `/skill:context-audit` |
| App đã đổi, verify skill lệch | `/skill:maintain-verify` |
| Lúc rảnh | `/skill:improve-architecture` |

## Ranh giới pha và smart zone

Footer hiện `zone 42k/150k` (xanh), `gần mép` (vàng) hoặc `dumb zone` (đỏ). Cửa sổ 1M của Opus làm auto-compaction chạy rất muộn, nên màu này mới là tín hiệu hết pha. Model không thấy footer, nên lần đầu context vượt lên vàng hoặc đỏ, agent nhận thêm một nhắc ngắn ở lượt kế tiếp để tự đề xuất ranh giới. Hết một pha thì chọn theo cây quyết định trong `/skill:work`:
- **tiếp tục** khi pha sau cần pha này làm nguồn gốc (grill sang implement);
- **`/clear`** khi mọi thứ đã nằm trong spec, ticket hoặc commit. Phiên cũ vẫn mở lại được qua `/resume` hoặc menu của phiên mới;
- **`/skill:handoff`** khi đổi harness, repo hoặc người;
- **giao subagent** cho phần đã khoanh rõ;
- **`/compact <chỉ dẫn>`** là lựa chọn cuối.

Thêm trên Pi:
- `/rewind` (Esc Esc) bỏ hẳn một hướng đi hỏng, cả code lẫn hội thoại;
- `/tree` và `/fork` rẽ nhánh từ một điểm trước thay vì nén một luồng đã rối.

Nếu auto-compaction vẫn chạy, Pi nhắc rằng một ranh giới đã bị bỏ lỡ. Đổi mép bằng biến môi trường, ví dụ `TSTACK_SMART_ZONE=200k pi`.

## Vai model theo từng bước

Skill không ghi tên model; chúng gọi **vai**, và `model-roles.json` quyết định model ([models.md](models.md)). Bảng dưới theo preset `default`.

| Bước | Vai | Model (default) | Vì sao |
|---|---|---|---|
| Thiết kế, grill, nghiệm thu, điều phối | parent | Claude Opus 5.5/high | Giữ ngữ cảnh và quyết định |
| Khám phá code, git archaeology, tra docs và web (`how`, `why`, `research`, facts khi grill) | `researcher` | GLM-5.3-Flash/max | Rẻ, nhanh, chạy nền song song (tối đa 4); chỉ đọc, có bash cho lệnh đọc |
| Build một ticket hoặc unit, prototype, sửa danh sách Act-on | `worker` | GPT-6 Sol/max | Viết code; commit chỉ khi brief cho phép |
| Tái hiện và sửa một bug đã khoanh | `debugger` | GPT-6 Sol/max | Test đỏ trước, sửa tận gốc |
| Ba trục review của `interrogate`, soát decision log, giám khảo eval | `reviewer` | GPT-6 Astra/high | Khác họ model với parent nên điểm mù không trùng; chỉ đọc |
| Chứng minh trên sản phẩm thật | `verifier` | GPT-6 Astra/high | Context sạch, khác model với worker, không sửa code |
| Design it twice | `researcher`, `reviewer`, parent (+ `worker` khi cần chạy code) | GLM, Astra, Opus, Sol | Nhiều họ model cho các phương án thật sự khác nhau, không cần CLI ngoài |

Preset `claude` dùng toàn Claude: reviewer và verifier chạy Fable 5.1, khác model với worker Opus. Khi reviewer cùng họ với parent, báo cáo `interrogate` nói rõ điểm mù có tương quan. Đổi vai bằng `/models` hoặc `pi-models`.

## afk chạy như một goal

`/skill:afk` giữ hợp đồng của pstack và dùng pi-goal-x làm động cơ:
1. **Hợp đồng.** Viết `.tstack/<slug>/contract.md` khi bạn còn ngồi đó, gồm: mục tiêu, điều kiện xong kiểm được, cách ly, quyền cấp trước, ngân sách, lối thoát, danh sách luôn dừng và chỉ thị thường trực.
2. **Goal.** Sau khi bạn "go", agent tạo goal có dòng `Verification contract: <điều kiện xong>`. Goal tự chạy tiếp qua các lượt, trong giới hạn số lượt tự chạy (mặc định 10 mỗi lần tạo hoặc resume). Hợp đồng cần nhiều hơn thì agent hỏi bạn nâng trong `/goal-settings` trước khi chạy.
3. **Vòng lặp.** Mỗi unit:
   1. một `worker` mới build unit;
   2. `verifier` kiểm độc lập;
   3. `interrogate` review;
   4. ghi ledger và decision log trong `.tstack/<slug>/`.

   Ledger là nơi duy nhất ghi trạng thái; unit không được chép sang `todo` hay task của goal, vì `set_goal_tasks` mở hộp xác nhận và sẽ treo một run không người trông.
   - Chờ CI: `bg_run` chạy nền trong lúc làm unit độc lập kế tiếp. Khi không còn gì làm được thì chờ ngay trong lượt: dưới goal, lượt vừa kết thúc được mở lại ngay, nên kết thúc lượt không phải là chờ.
   - Unit chạy song song chỉ khi project bật `worktreeIsolation` trong `.pi/subagents.json`.
4. **Kẹt.** Goal chuyển sang blocked, và Oracle (Astra) được hỏi một lần cho mỗi vướng mắc.
5. **Xong.** Agent chứng minh toàn bộ, viết báo cáo buổi sáng rồi mới báo hoàn thành, vì auditor duyệt là run kết thúc. **Auditor độc lập** (Astra) kiểm workspace theo điều kiện xong; không đạt thì goal mở tiếp, và phản hồi của auditor thành unit kế tiếp.

Xem tiến độ bằng `/goal-status`; tạm dừng bằng `/goal-pause`.

## Git guard

Auto mode có một lớp chặn tất định cho lệnh git phá huỷ, áp dụng cả ở mode auto lẫn bypass, ở phiên chính, agent con và goal auditor. Nó chặn:
- force-push (trừ `--force-with-lease`);
- push thẳng lên nhánh bảo vệ;
- `reset --hard`, `clean -f`, `branch -D`;
- bỏ qua hook (`--no-verify`, `HUSKY=0`…);
- viết lại lịch sử;
- `rm -r` trên `/`, `~`, `.`, `.git`.

Khi thật sự cần, bạn tự chạy lệnh bằng `!<lệnh>` trong editor của Pi. Cấu hình và danh sách đầy đủ: [auto-mode.md](auto-mode.md#git-guard).

## Danh mục

### 18 lệnh (skill chỉ người gọi, 0 token cho tới khi gọi)

| Lệnh | Việc |
|---|---|
| `work` | Cổng vào duy nhất: phân loại task, chọn playbook, chép từng bước vào `todo`; `?` trả lời "lệnh nào tiếp theo". |
| `grill-me`, `grill-with-docs` | Phỏng vấn tới khi chung một thiết kế (ngoài repo, hoặc trong repo kèm cập nhật CONTEXT.md và ADR). |
| `to-spec` | Tổng hợp hội thoại thành spec trên tracker, có mục Verification. |
| `to-tickets` | Cắt spec thành ticket dọc có quan hệ chặn, tiêu chí fail ở commit xuất phát, dòng `Verify:`. |
| `implement` | Build một ticket hoặc spec nhỏ theo build playbook. |
| `afk` | Chạy không giám sát theo hợp đồng, như một goal. |
| `ship` | Mở PR (deslop, commit có thứ tự, body briefing), babysit, land khi được yêu cầu. |
| `reflect` | Bài học lặp lại → nấc mạnh nhất của thang; chỉ áp dụng dòng bạn duyệt. |
| `setup` | Cấu hình repo: tracker, domain docs, AGENTS.md gọn, `CODING_STANDARDS.md`, `.pi-lens.json`, hook commit. |
| `create-verify`, `maintain-verify` | Tạo và giữ verify skill kèm feature map cho từng app (web, CLI, API, mobile). |
| `context-audit` | Đo context luôn-bật và cắt tỉa với ba phép thử. |
| `improve-architecture` | Khảo sát cơ hội "làm sâu module", báo cáo HTML, rồi grill phương án bạn chọn. |
| `wayfinder` | Bản đồ ticket quyết định cho việc lớn hơn một spec. |
| `triage` | Máy trạng thái triage cho issue và PR bên ngoài. |
| `handoff` | Nén hội thoại thành tài liệu bàn giao. |
| `wait-what` | Nói lại tin nhắn cuối bằng lời đơn giản. |

### 20 kỷ luật (model tự nạp; chỉ mô tả nằm trong context)

grilling, domain-modeling, codebase-design, principles, tdd, diagnose, prove, interrogate, how, why, prototype, research, decision-log, unslop, writing-for-agents, resolving-merge-conflicts, wizard, typescript, python, mobile.

## Trong repo của bạn

| Đường dẫn | Là gì |
|---|---|
| `AGENTS.md` | File hướng dẫn duy nhất; Pi đọc AGENTS.md trước CLAUDE.md. Đội còn dùng Claude Code thì giữ `CLAUDE.md` chỉ chứa `@AGENTS.md`. |
| `CODING_STANDARDS.md` | Luật review; `reviewer` đọc, agent code không phải trả giá mỗi request. |
| `docs/agents/*.md` | Tracker (GitHub, GitLab hoặc markdown cục bộ), cấu trúc domain, nhãn triage. |
| `CONTEXT.md`, `docs/adr/` | Từ điển domain và quyết định kiến trúc. |
| `.agents/skills/verify-<app>/` | Verify skill kèm `features/` của từng app. Pi nạp sau khi project được trust; `prove` và `verifier` đọc theo đường dẫn. |
| `.pi-lens.json` | `format.enabled: true` để pi-lens format file vừa sửa bằng formatter của repo. |
| `.tstack/<slug>/` | Trạng thái việc dài hoặc không giám sát: `contract.md`, `ledger.tsv`, `decisions.tsv`, `evidence/`, `report.md`; được gitignore. |

## Tuỳ biến

- **Sửa skill.** Sửa file trong `<root>/assets/skills/<tên>/`, rồi `/reload`. Installer giữ file bạn đã sửa và báo lại khi cài lại. Muốn góp vào bộ chuẩn thì sửa `assets/skills/` trong repo này; test `tests/skills.test.mjs` kiểm tham chiếu.
- **Skill riêng của project.** Đặt trong `.agents/skills/<tên>/`. Viết theo skill `writing-for-agents`.
- **Luật review mới.** Thêm một dòng vào `CODING_STANDARDS.md`. Luật mà regex hoặc type ép được thì làm lint, hook, luật pi-lens (`rules/ast-grep-rules/`) hoặc type.
- **Mép smart zone.** `TSTACK_SMART_ZONE=200k`.
- **Git guard.** Xem [auto-mode.md](auto-mode.md#git-guard).

## Khác với tstack cho Claude Code

| tstack 1.0 (Claude Code) | Trên Pi |
|---|---|
| Lệnh `/tstack:work` | `/skill:work` (Pi không có namespace plugin) |
| Skill tool | Model đọc SKILL.md theo danh sách skill của Pi |
| `Explore`, `general-purpose`, `ticket-worker`, ba agent review | `researcher`, `worker`, `reviewer` + file trục trong `interrogate/axes/`, `verifier` |
| Seat review ngoài qua `codex`/`gemini` CLI | Vai khác họ model trong preset |
| `effort: high` theo skill | Parent đã chạy Opus/high; skill không đổi thinking giữa phiên (giữ prompt cache) |
| Hook `guard_git.py`, PreCompact, status line | Git guard trong auto mode, extension `smart-zone` (footer, nhắc compaction, `/context-budget`) |
| `.claude/skills/verify-<app>/`, hook format trong `.claude/settings.json` | `.agents/skills/verify-<app>/`, `.pi-lens.json` kèm hook commit |
| Background Bash, `/loop` | `bg_run` (phiên tự thức khi job xong) |
| afk tự vòng lặp | afk chạy như goal: tự tiếp tục, Oracle khi kẹt, auditor độc lập khi xong |

## Nguồn gốc và giấy phép

tstack là bản phái sinh từ [`mattpocock/skills`](https://github.com/mattpocock/skills) 1.2.3 (MIT, Matt Pocock) và [`pstack`](https://github.com/cursor/plugins/tree/main/pstack) 0.15.5 (MIT, Lauren Tan), viết lại bởi Phạm Duy Tùng rồi chuyển sang Pi. Toàn văn thông báo bản quyền đi kèm bộ skill tại [`assets/skills/LICENSE`](../assets/skills/LICENSE). Mọi lỗi trong phần viết lại là của bản này, không phải của các tác giả gốc.
