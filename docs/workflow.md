# Quy trình làm việc: skills trên Pi

pi-config cài sẵn bộ skill quy trình **tstack**, chuyển từ Claude Code sang Pi và gắn với các thành phần của pi-config: vai model, goal, auto mode và rewind. tstack gộp phần tốt nhất của hai bộ skill mã nguồn mở:
- **`skills` của Matt Pocock**: căn chỉnh trước khi build, ở trong smart zone, spec → tickets → TDD, review tách trục, ngôn ngữ domain.
- **`pstack` của Lauren Tan**: chứng minh trên sản phẩm thật, kỷ luật bằng chứng, mã hoá bài học vào cấu trúc, chạy không giám sát có hợp đồng, review đối kháng.

Skill nằm trong `assets/skills/` của repo và được cài vào `<root>/assets/skills/`. Nguồn gốc và giấy phép ở cuối trang.

## Năm trụ cột và cơ chế trên Pi

| Trụ cột | Trên Pi |
|---|---|
| **Căn chỉnh trước khi build** | `/skill:grill-with-docs` hỏi từng vòng, mỗi câu có đáp án đề xuất. Sự thật do agent tự tra (giao `researcher`), quyết định là của người. Câu "cách nào tốt hơn" mà chạy thử trả lời được thì agent tự làm prototype. |
| **Ở trong smart zone** | Giữ mỗi pha trong khoảng 150k token đầu; footer của Pi cho biết context đang dùng. Việc đọc code rộng, tra docs/web giao `researcher`. Hết một pha thì chọn: tiếp tục, `/clear`, handoff, subagent hoặc `/compact`. |
| **Chứng minh trên sản phẩm thật** | Chạy thay đổi theo đường người dùng đi (app, CLI, API) và đọc output thật; typecheck hay CI xanh không phải bằng chứng. Kết luận VERIFIED, NOT VERIFIED hoặc INCONCLUSIVE kèm bằng chứng. |
| **Mã hoá bài học vào cấu trúc** | Thang ưu tiên, từ mạnh nhất: type và kiến trúc; lint, hook và CI; `CODING_STANDARDS.md`; skill; một dòng trong AGENTS.md. `/skill:reflect` đưa mỗi bài học lên nấc cao nhất có thể. |
| **Tự chủ có hợp đồng** | Việc đảo ngược được thì cứ làm. Việc dài giao `/goal` của pi-goal-x. Git guard trong auto mode chặn tất định các lệnh git phá huỷ. |

## Bắt đầu

```text
/skill:setup            một lần mỗi repo: tracker, AGENTS.md, CODING_STANDARDS.md, skill theo stack, format và hook
```

Skill kỷ luật (grilling, tdd, diagnose, interrogate…) được model tự nạp khi việc khớp mô tả; bạn cũng có thể gọi tên. Skill luồng chỉ người dùng gọi được, bằng `/skill:<tên> [tham số]`: gõ `/` rồi tìm tên trong danh sách lệnh.

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
4. chạy thử trên sản phẩm thật và đọc output;
5. commit nhỏ;
6. `interrogate` review bằng các `reviewer` sạch, rồi sửa mục "Act on";
7. đóng ticket kèm SHA, kết luận và bằng chứng.

| Tình huống | Lệnh |
|---|---|
| Có bug hoặc chậm | Mô tả triệu chứng; agent tự nạp `diagnose`: tái hiện đỏ trước, sửa tận gốc |
| Việc dài, chạy tiếp qua nhiều lượt | `/goal <mục tiêu>` |
| Chuyển việc sang phiên hoặc người khác | `/skill:handoff` |
| Tin nhắn của agent khó hiểu | `/skill:wait-what` |
| Lúc rảnh | `/skill:improve-architecture` |

## Ranh giới pha và smart zone

Smart zone là khoảng 150k token đầu của phiên; quá mức đó model làm kém đi. Cửa sổ 1M của Opus làm auto-compaction chạy rất muộn, nên hãy nhìn số context ở footer của Pi và chọn ranh giới trước khi một pha vượt mép. Hết một pha thì chọn:
- **tiếp tục** khi pha sau cần pha này làm nguồn gốc (grill sang implement);
- **`/clear`** khi mọi thứ đã nằm trong spec, ticket hoặc commit. Phiên cũ vẫn mở lại được qua `/resume` hoặc menu của phiên mới;
- **`/skill:handoff`** khi đổi harness, repo hoặc người;
- **giao subagent** cho phần đã khoanh rõ;
- **`/compact <chỉ dẫn>`** là lựa chọn cuối.

Thêm trên Pi:
- `/rewind` (Esc Esc) bỏ hẳn một hướng đi hỏng, cả code lẫn hội thoại;
- `/tree` và `/fork` rẽ nhánh từ một điểm trước thay vì nén một luồng đã rối.

## Vai model theo từng bước

Skill không ghi tên model; chúng gọi **vai**, và `model-roles.json` quyết định model ([models.md](models.md)). Bảng dưới theo preset `default`.

| Bước | Vai | Model (default) | Vì sao |
|---|---|---|---|
| Thiết kế, grill, nghiệm thu, điều phối | parent | Claude Opus 5.5/high | Giữ ngữ cảnh và quyết định |
| Đọc code, git archaeology, tra docs và web (`how`, `why`, `research`, `improve-architecture`, blast radius, facts khi grill) | `researcher` | GLM-5.3-Flash/max | Rẻ, nhanh, chạy nền song song (tối đa 4); chỉ đọc, có bash cho lệnh đọc |
| Build một ticket hoặc unit, prototype, sửa danh sách Act-on | `worker` | GPT-6 Sol/max | Viết code; commit chỉ khi brief cho phép |
| Tái hiện và sửa một bug đã khoanh | `debugger` | GPT-6 Sol/max | Test đỏ trước, sửa tận gốc |
| Ba trục review của `interrogate`, giám khảo eval | `reviewer` | GPT-6 Astra/high | Khác họ model với parent nên điểm mù không trùng; chỉ đọc |
| Design it twice | `researcher`, `reviewer`, parent (+ `worker` khi cần chạy code) | GLM, Astra, Opus, Sol | Nhiều model cho các phương án thật sự khác nhau, không cần CLI ngoài |

Preset `claude` dùng toàn Claude: reviewer chạy Fable 5.1, khác model với worker Opus. Khi reviewer cùng họ với parent, báo cáo `interrogate` nói rõ điểm mù có tương quan. Đổi vai bằng `/models` hoặc `pi-models`.

## Advisor và skill quy trình

Skill quy trình (từ tstack) dùng các gate của advisor (`pi-models set advisor gates=…`; preset có sẵn bật `failure` và `completion`):
- Gate `plan`: trong build playbook của `/skill:implement`, plan là data shape, seam và các lát cắt chốt ở bước 2 đến 4; parent gửi advisor trước khi viết code.
- Gate `completion`: gọi sau bước chứng minh và `interrogate`, để bản nháp mang verdict và bằng chứng thật chứ không phải lời khẳng định.
- Gate `failure` trùng luật "hai lần sửa cùng tiền đề thất bại" của `diagnose`.
- Số lượt `calls` tính theo phiên. Advisor tắt, hết lượt hoặc đang ở subagent (worker, debugger không có `ask_advisor`) thì skill bỏ bước advisor và ghi rõ; subagent báo parent.
- `interrogate`, eval của `writing-for-agents` và design it twice nói rõ khi hai seat cùng model.

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
| `grill-me`, `grill-with-docs` | Phỏng vấn tới khi chung một thiết kế (ngoài repo, hoặc trong repo kèm cập nhật CONTEXT.md và ADR). |
| `to-spec` | Tổng hợp hội thoại thành spec trên tracker, có mục Verification. |
| `to-tickets` | Cắt spec thành ticket dọc có quan hệ chặn, tiêu chí fail ở commit xuất phát, dòng `Verify:`. |
| `implement` | Build một ticket hoặc spec nhỏ theo build playbook. |
| `ship` | Mở PR (deslop, commit có thứ tự, body briefing), babysit, land khi được yêu cầu. |
| `reflect` | Bài học lặp lại → nấc mạnh nhất của thang; chỉ áp dụng dòng bạn duyệt. |
| `setup` | Cấu hình repo: tracker, domain docs, AGENTS.md gọn, `CODING_STANDARDS.md`, skill theo stack, hook commit. |
| `improve-architecture` | Khảo sát cơ hội "làm sâu module", báo cáo HTML, rồi grill phương án bạn chọn. |
| `handoff` | Nén hội thoại thành tài liệu bàn giao. |
| `wait-what` | Nói lại tin nhắn cuối bằng lời đơn giản. |

### 17 kỷ luật (model tự nạp; chỉ mô tả nằm trong context)

grilling, domain-modeling, codebase-design, principles, tdd, diagnose, interrogate, how, why, prototype, research, unslop, writing-for-agents, resolving-merge-conflicts.

### Skill theo stack (chỉ trong repo dùng stack đó)

`typescript`, `python`, `mobile` (Swift, Kotlin, Dart) nằm trong [assets/stack-skills](../assets/stack-skills), không nằm trong danh sách skill chung. `/skill:setup` nhận stack của repo và đề nghị chép skill khớp vào `.agents/skills/<tên>/` của repo; Pi chỉ nạp nó khi làm việc trong repo đó. Chạy lại `/skill:setup` sau khi nâng pi-config để cập nhật bản chép (có diff trước khi ghi).

## Trong repo của bạn

| Đường dẫn | Là gì |
|---|---|
| `AGENTS.md` | File hướng dẫn duy nhất; Pi đọc AGENTS.md trước CLAUDE.md. Đội còn dùng Claude Code thì giữ `CLAUDE.md` chỉ chứa `@AGENTS.md`. |
| `CODING_STANDARDS.md` | Luật review; `reviewer` đọc, agent code không phải trả giá mỗi request. |
| `docs/agents/*.md` | Tracker (GitHub, GitLab hoặc markdown cục bộ) và cấu trúc domain. |
| `CONTEXT.md`, `docs/adr/` | Từ điển domain và quyết định kiến trúc. |

## Tuỳ biến

- **Sửa skill.** Sửa file trong `<root>/assets/skills/<tên>/`, rồi `/reload`. Installer giữ file bạn đã sửa và báo lại khi cài lại. Muốn góp vào bộ chuẩn thì sửa `assets/skills/` trong repo này; test `tests/skills.test.mjs` kiểm tham chiếu.
- **Skill riêng của project.** Đặt trong `.agents/skills/<tên>/`. Viết theo skill `writing-for-agents`.
- **Luật review mới.** Thêm một dòng vào `CODING_STANDARDS.md`. Luật mà regex hoặc type ép được thì làm lint, hook hoặc type.
- **Git guard.** Xem [auto-mode.md](auto-mode.md#git-guard).

## Khác với tstack cho Claude Code

| tstack 1.0 (Claude Code) | Trên Pi |
|---|---|
| Lệnh `/tstack:<tên>` | `/skill:<tên>` (Pi không có namespace plugin) |
| Skill tool | Model đọc SKILL.md theo danh sách skill của Pi |
| `Explore`, `general-purpose`, `ticket-worker`, ba agent review | `researcher`, `worker`, `reviewer` + file trục trong `interrogate/axes/` |
| Seat review ngoài qua `codex`/`gemini` CLI | Vai khác họ model trong preset |
| `effort: high` theo skill | Parent đã chạy Opus/high; skill không đổi thinking giữa phiên (giữ prompt cache) |
| Hook `guard_git.py`, PreCompact, status line | Git guard trong auto mode; context xem ở footer của Pi |
| Hook format trong `.claude/settings.json` | Hook commit |
| Background Bash, `/loop` | `bg_run` (phiên tự thức khi job xong) |

## Nguồn gốc và giấy phép

tstack là bản phái sinh từ [`mattpocock/skills`](https://github.com/mattpocock/skills) 1.2.3 (MIT, Matt Pocock) và [`pstack`](https://github.com/cursor/plugins/tree/main/pstack) 0.15.5 (MIT, Lauren Tan), viết lại bởi Phạm Duy Tùng rồi chuyển sang Pi. Toàn văn thông báo bản quyền đi kèm bộ skill tại [`assets/skills/LICENSE`](../assets/skills/LICENSE). Mọi lỗi trong phần viết lại là của bản này, không phải của các tác giả gốc.
