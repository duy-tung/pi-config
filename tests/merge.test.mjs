import test from 'node:test';
import assert from 'node:assert/strict';
import {carryLocalControls, deepEqual, describeMerge, mergeConfig, reconcileJson, reconcileRole} from '../runtime/merge.mjs';

const json = value => `${JSON.stringify(value, null, 2)}\n`;
const merge = (base, next, current, settings = true) => mergeConfig({base, next, current, settings});

test('giá trị đơn: người dùng chưa đổi thì nhận mặc định mới, đã đổi thì giữ, khác cả hai thì báo xung đột', () => {
  const base = {model: 'old', theme: 'moon', thinking: 'high', effort: 'low'};
  const next = {model: 'new', theme: 'moon', thinking: 'max', effort: 'medium'};
  const current = {model: 'old', theme: 'dawn', thinking: 'max', effort: 'high'};
  const result = merge(base, next, current);
  assert.deepEqual(result.value, {model: 'new', theme: 'dawn', thinking: 'max', effort: 'high'});
  assert.deepEqual(result.changes, [{type: 'set', path: ['model'], from: 'old', to: 'new'}]);
  assert.deepEqual(result.conflicts, [{path: ['effort'], current: 'high', next: 'medium'}]);
});

test('khóa mặc định mới bỏ thì bị xoá, trừ khi người dùng đã đổi; khóa người dùng bỏ thì vẫn bỏ', () => {
  const base = {retired: 1, tuned: 1, dropped: 1, changed: 1, nested: {a: 1, b: 1}};
  const next = {dropped: 1, changed: 2, nested: {a: 1}, added: true};
  const current = {retired: 1, tuned: 5, nested: {a: 1, b: 1, mine: 'x'}};
  const result = merge(base, next, current);
  assert.deepEqual(result.value, {tuned: 5, nested: {a: 1, mine: 'x'}, added: true});
  assert.deepEqual(result.changes, [
    {type: 'delete', path: ['retired']}, {type: 'delete', path: ['nested', 'b']}, {type: 'add', path: ['added'], value: true},
  ]);
  assert.deepEqual(result.conflicts, [
    {path: ['tuned'], current: 5, next: undefined}, {path: ['changed'], current: undefined, next: 2},
  ]);
  // Thứ tự khóa theo file hiện tại, khóa mới thêm vào cuối.
  assert.deepEqual(Object.keys(result.value), ['tuned', 'nested', 'added']);
});

test('mảng thường là một giá trị; mảng tập hợp chỉ áp dụng cho settings.json', () => {
  const base = {searchRouting: {providers: ['openai', 'exa']}, deny: ['a'], permissions: {deny: ['a']}};
  const next = {searchRouting: {providers: ['openai', 'anthropic', 'exa']}, deny: ['a', 'b'], permissions: {deny: ['a', 'b']}};
  const current = {searchRouting: {providers: ['exa', 'openai']}, deny: ['a', 'mine'], permissions: {deny: ['a', 'mine']}};
  const settings = merge(base, next, current);
  assert.deepEqual(settings.value.searchRouting.providers, ['exa', 'openai']);
  assert.deepEqual(settings.value.deny, ['a', 'mine'], 'deny ngoài permissions là mảng thường');
  assert.deepEqual(settings.value.permissions.deny, ['a', 'mine', 'b']);
  assert.deepEqual(settings.conflicts.map(conflict => conflict.path.join('.')), ['searchRouting.providers', 'deny']);
  const other = merge(base, next, current, false);
  assert.deepEqual(other.value.permissions.deny, ['a', 'mine'], 'file khác settings.json: mảng là một giá trị');
  // Người dùng chưa đổi mảng thường thì nhận mảng mới.
  assert.deepEqual(merge(base, next, {...current, searchRouting: {providers: ['openai', 'exa']}}).value.searchRouting.providers, ['openai', 'anthropic', 'exa']);
});

test('mảng tập hợp: thêm mục mặc định mới vào cuối, bỏ mục mặc định cũ, giữ mục và thứ tự của người dùng', () => {
  const base = {
    permissions: {allow: ['web_search'], ask: ['Edit(a)'], deny: ['Path(~/.ssh/*)', 'Bash(sudo *)', 'mcpScript']},
    enabledModels: ['m1', 'm2', 'm3'], skills: ['/s/a'], themes: ['/t'], prompts: ['/p/old'],
  };
  const next = {
    permissions: {allow: ['web_search', 'WebFetch(domain:github.com)'], ask: ['Edit(a)', 'Edit(b)'], deny: ['Path(~/.ssh)', 'Path(~/.ssh/**)', 'Bash(sudo *)', 'mcpScript']},
    enabledModels: ['m1', 'm2', 'm4'], skills: ['/s/a', '/s/b'], themes: ['/t'], prompts: [],
  };
  const current = {
    permissions: {allow: ['web_search', 'Bash(git status)'], ask: ['Edit(a)'], deny: ['Bash(sudo *)', 'Path(~/notes/**)', 'Path(~/.ssh/*)']},
    enabledModels: ['m2', 'm3'], skills: ['/mine', '/s/a'], themes: ['/t', '/mine-themes'], prompts: ['/p/old'],
  };
  const result = merge(base, next, current);
  assert.deepEqual(result.value, {
    permissions: {
      allow: ['web_search', 'Bash(git status)', 'WebFetch(domain:github.com)'], ask: ['Edit(a)', 'Edit(b)'],
      // mcpScript người dùng đã bỏ thì vẫn bỏ; Path(~/.ssh/*) mặc định cũ thì được thay.
      deny: ['Bash(sudo *)', 'Path(~/notes/**)', 'Path(~/.ssh)', 'Path(~/.ssh/**)'],
    },
    // m1 người dùng đã bỏ; m3 mặc định mới bỏ; m4 được thêm.
    enabledModels: ['m2', 'm4'], skills: ['/mine', '/s/a', '/s/b'], themes: ['/t', '/mine-themes'], prompts: [],
  });
  assert.deepEqual(result.conflicts, []);
  assert.ok(result.changes.some(change => change.type === 'items' && change.path.join('.') === 'permissions.deny'
    && deepEqual(change.added, ['Path(~/.ssh)', 'Path(~/.ssh/**)']) && deepEqual(change.removed, ['Path(~/.ssh/*)'])));
});

test('luật deny đã thay thế: bỏ khi do installer ghi (base có, hoặc chưa có base); người dùng tự thêm lại thì giữ', () => {
  const next = {permissions: {deny: ['Bash(sudo *)']}};
  const current = {permissions: {deny: ['Bash(rm -rf *)', 'Bash(sudo *)', 'Path(~/mine)']}};
  for (const base of [{permissions: {deny: ['Bash(rm -rf *)', 'Bash(sudo *)']}}, undefined]) {
    const result = merge(base, next, current);
    assert.deepEqual(result.value.permissions.deny, ['Bash(sudo *)', 'Path(~/mine)']);
    assert.ok(result.changes.some(change => change.type === 'items' && change.removed.includes('Bash(rm -rf *)')));
  }
  // Base (mặc định lần trước) không có luật này: người dùng thêm lại sau lần cài đó, là tùy chỉnh của họ.
  const kept = merge({permissions: {deny: ['Bash(sudo *)']}}, next, current);
  assert.deepEqual(kept.value.permissions.deny, current.permissions.deny);
  assert.deepEqual([kept.changes, kept.conflicts], [[], []]);
});

test('extensions: giữ loại trừ "-" và extension riêng; pi-auto-mode luôn nạp sau cùng', () => {
  const root = '/r/assets/extensions';
  const base = {extensions: [`${root}/rose-pine-palette.ts`, `${root}/pi-rewind`, `${root}/pi-auto-mode`]};
  const next = {extensions: [`${root}/rose-pine-palette.ts`, `${root}/pi-rewind`, `${root}/claude-usage`, `${root}/pi-auto-mode`]};
  const current = {extensions: [`-${root}/pi-rewind`, `${root}/rose-pine-palette.ts`, `${root}/pi-rewind`, `${root}/pi-auto-mode`, '/home/u/mine.ts']};
  const result = merge(base, next, current);
  assert.deepEqual(result.value.extensions, [`-${root}/pi-rewind`, `${root}/rose-pine-palette.ts`, `${root}/pi-rewind`, '/home/u/mine.ts', `${root}/claude-usage`, `${root}/pi-auto-mode`]);
  assert.ok(result.changes.some(change => change.type === 'last'));
  // Chỉ có loại trừ phía sau pi-auto-mode: không cần đổi thứ tự. Windows dùng dấu \.
  const windows = {extensions: ['C:\\r\\pi-rewind', 'C:\\r\\pi-auto-mode', '-C:\\r\\other']};
  const kept = merge(windows, windows, {extensions: ['C:\\r\\pi-rewind', 'C:\\r\\pi-auto-mode', '-C:\\r\\other', '!C:\\x\\*.ts']});
  assert.deepEqual(kept.value.extensions, ['C:\\r\\pi-rewind', 'C:\\r\\pi-auto-mode', '-C:\\r\\other', '!C:\\x\\*.ts']);
  assert.deepEqual(kept.changes, []);
  const moved = merge(windows, windows, {extensions: ['C:\\r\\pi-auto-mode', 'C:\\r\\pi-rewind', '+D:\\mine.ts']});
  assert.deepEqual(moved.value.extensions, ['C:\\r\\pi-rewind', '+D:\\mine.ts', 'C:\\r\\pi-auto-mode']);
  // Người dùng bỏ pi-auto-mode thì không thêm lại.
  assert.deepEqual(merge(base, next, {extensions: [`${root}/pi-rewind`]}).value.extensions, [`${root}/pi-rewind`, `${root}/claude-usage`]);
});

test('packages: gộp theo mục, object cùng source là một mục; mục người dùng sửa được giữ', () => {
  const background = extensions => ({source: '/rt/pi-background-tasks', extensions});
  const base = {packages: ['/rt/a', background(['dist/old.js']), '/rt/retired']};
  const next = {packages: ['/rt/a', background(['dist/new.js']), '/rt/b']};
  const unedited = merge(base, next, {packages: ['/user/pkg', '/rt/a', background(['dist/old.js']), '/rt/retired']});
  assert.deepEqual(unedited.value.packages, ['/user/pkg', '/rt/a', background(['dist/new.js']), '/rt/b']);
  assert.deepEqual(unedited.conflicts, []);
  const edited = merge(base, next, {packages: [{source: '/rt/a', extensions: ['x.js']}, background(['dist/old.js', 'dist/mine.js'])]});
  assert.deepEqual(edited.value.packages, [{source: '/rt/a', extensions: ['x.js']}, background(['dist/old.js', 'dist/mine.js']), '/rt/b']);
  assert.deepEqual(edited.conflicts.map(conflict => conflict.item), ['/rt/pi-background-tasks']);
  // Thứ tự khóa trong object không làm hai mục khác nhau.
  const reordered = merge(base, base, {packages: ['/rt/a', {extensions: ['dist/old.js'], source: '/rt/pi-background-tasks'}, '/rt/retired']});
  assert.deepEqual([reordered.changes, reordered.conflicts], [[], []]);
});

test('chưa có base: giữ mọi giá trị hiện có, thêm khóa và mục còn thiếu, báo giá trị khác mặc định mới', () => {
  const next = {
    defaultModel: 'claude-opus-5-5', compaction: {enabled: true, keepRecentTokens: 20000},
    permissions: {deny: ['Path(~/.ssh)', 'Path(~/.ssh/**)', 'Bash(sudo *)'], ask: ['Edit(x)']},
    extensions: ['/r/palette.ts', '/r/claude-usage', '/r/pi-auto-mode'], rewind: {retentionDays: 30},
  };
  const current = {
    defaultModel: 'gpt-6-sol', compaction: {enabled: true},
    permissions: {deny: ['Path(~/.ssh/*)', 'Bash(rm -rf *)', 'Bash(sudo *)', 'Path(~/mine)']},
    extensions: ['-/r/palette.ts', '/r/palette.ts', '/r/pi-auto-mode', '/home/u/x.ts'],
  };
  const result = merge(undefined, next, current);
  assert.deepEqual(result.value, {
    defaultModel: 'gpt-6-sol', compaction: {enabled: true, keepRecentTokens: 20000},
    permissions: {deny: ['Path(~/.ssh/*)', 'Bash(sudo *)', 'Path(~/mine)', 'Path(~/.ssh)', 'Path(~/.ssh/**)'], ask: ['Edit(x)']},
    extensions: ['-/r/palette.ts', '/r/palette.ts', '/home/u/x.ts', '/r/claude-usage', '/r/pi-auto-mode'], rewind: {retentionDays: 30},
  });
  assert.deepEqual(result.conflicts, [{path: ['defaultModel'], current: 'gpt-6-sol', next: 'claude-opus-5-5'}]);
  const plan = reconcileJson({next: json(next), current: json(current), settings: true});
  assert.equal(plan.additive, true);
  assert.deepEqual(JSON.parse(plan.content), result.value);
  const report = describeMerge({file: '/a/settings.json', ...plan});
  assert.match(report[0], /^Chưa có mặc định của lần cài trước cho \/a\/settings\.json: giữ mọi giá trị hiện có/u);
  assert.ok(report.includes('  - xung đột: giữ giá trị hiện có cho defaultModel; mặc định mới là "claude-opus-5-5"'), report.join('\n'));
});

test('chưa có base nhưng file chưa sửa: nhận mặc định mới, giữ loại trừ extension và luật deny như trước', () => {
  const next = {defaultModel: 'new', extensions: ['/r/a', '/r/pi-auto-mode'], permissions: {deny: ['Bash(sudo *)']}};
  const current = {defaultModel: 'old', extensions: ['-/user/x.ts', '/r/a', '/r/pi-auto-mode'], permissions: {deny: ['Bash(rm -rf *)', 'Path(/user/key)']}};
  const carried = {defaultModel: 'new', extensions: ['-/user/x.ts', '/r/a', '/r/pi-auto-mode'], permissions: {deny: ['Bash(sudo *)', 'Path(/user/key)']}};
  assert.deepEqual(carryLocalControls(next, current), carried);
  const plan = reconcileJson({next: json(next), current: json(current), unedited: true, settings: true});
  assert.deepEqual([JSON.parse(plan.content), plan.changes, plan.conflicts], [carried, [], []]);
  // File khác settings.json nhận nguyên bản mới.
  assert.equal(reconcileJson({next: json(next), current: json(current), unedited: true}).content, json(next));
});

test('reconcileJson: file mới, file khớp, file chưa sửa so với base, JSON hỏng', () => {
  const base = json({a: 1, b: [1]}), next = json({a: 2, b: [1]});
  assert.deepEqual(reconcileJson({next, current: undefined, base}), {content: next, changes: [], conflicts: []});
  // Khác định dạng (Pi ghi không có newline cuối, có BOM) nhưng cùng giá trị: không ghi.
  assert.equal(reconcileJson({next, current: `\uFEFF${JSON.stringify({b: [1], a: 2})}`, base}).content, undefined);
  assert.equal(reconcileJson({next, current: JSON.stringify({a: 1, b: [1]}), base}).content, next, 'chưa sửa: ghi nguyên mặc định mới');
  assert.equal(reconcileJson({next, current: '{"a": ', base}).invalid, true);
  // Base hỏng coi như chưa có base.
  assert.equal(reconcileJson({next, current: json({a: 1, b: [1], c: 3}), base: 'hỏng'}).additive, true);
});

test('chạy lại khi không có gì đổi thì không ghi và không báo', () => {
  const base = {defaultModel: 'a', theme: 'moon', permissions: {deny: ['x']}, extensions: ['/r/pi-auto-mode']};
  const next = {defaultModel: 'b', theme: 'moon', permissions: {deny: ['x', 'y']}, extensions: ['/r/u', '/r/pi-auto-mode']};
  const current = {defaultModel: 'mine', theme: 'dawn', permissions: {deny: ['x', 'mine']}, extensions: ['/r/pi-auto-mode', '/home/e.ts']};
  const first = reconcileJson({next: json(next), current: JSON.stringify(current), base: json(base), settings: true});
  assert.ok(first.content && first.changes.length && first.conflicts.length);
  const second = reconcileJson({next: json(next), current: first.content, base: json(next), settings: true});
  assert.deepEqual(second, {content: undefined, changes: [], conflicts: [], additive: false});
  assert.deepEqual(describeMerge({file: 'x', ...second}), []);
  // Bản cài chưa có base: lần sau đã có base nên cũng không đổi gì.
  const additive = reconcileJson({next: json(next), current: JSON.stringify(current), settings: true});
  assert.equal(reconcileJson({next: json(next), current: additive.content, base: json(next), settings: true}).content, undefined);
});

test('báo cáo tiếng Việt liệt kê phần đã gộp và từng xung đột', () => {
  const base = {searchRouting: {providers: ['openai', 'exa']}, compaction: {keepRecentTokens: 10000}, gone: 1};
  const next = {searchRouting: {providers: ['openai', 'anthropic', 'exa']}, compaction: {keepRecentTokens: 20000}, modelThinkingLevels: {'openai/x': 'max'}};
  const current = {searchRouting: {providers: ['exa']}, compaction: {keepRecentTokens: 10000}, gone: 2};
  const lines = describeMerge({file: '/agent/web-search.json', ...merge(base, next, current, false)});
  assert.deepEqual(lines, [
    'Đã gộp mặc định mới vào /agent/web-search.json, giữ phần bạn đã sửa:',
    '  - compaction.keepRecentTokens: 10000 → 20000',
    '  - thêm modelThinkingLevels = {"openai/x":"max"}',
    '  - xung đột: giữ giá trị của bạn cho searchRouting.providers; mặc định mới là ["openai","anthropic","exa"]',
    '  - xung đột: giữ giá trị của bạn cho gone; mặc định mới đã bỏ khóa này',
  ]);
  const nested = describeMerge({file: 'f', ...merge({levels: {'a/b': 1}}, {levels: {'a/b': 2}}, {levels: {'a/b': 3}}, false)});
  assert.deepEqual(nested, ['Giữ phần bạn đã sửa trong f:', '  - xung đột: giữ giá trị của bạn cho levels["a/b"]; mặc định mới là 2']);
});

test('khóa "__proto__" trong JSON không đổi prototype của kết quả', () => {
  const current = JSON.parse('{"__proto__": {"polluted": true}, "a": 1}');
  const result = merge({a: 1}, {a: 2}, current, false);
  assert.equal(Object.getPrototypeOf(result.value), Object.prototype);
  assert.deepEqual(JSON.parse(JSON.stringify(result.value)), JSON.parse('{"__proto__": {"polluted": true}, "a": 2}'));
  assert.equal({}.polluted, undefined);
});

const role = ({model = 'openai-codex/gpt-6-sol', thinking = 'max', tools = '"read, bash"', prompt = 'Prompt v1.'} = {}) =>
  `---\nname: worker\ndescription: Viết code.\nmodel: ${model}\nthinking: ${thinking}\ntools: ${tools}\n---\n\n${prompt}\n`;

test('file role: sửa dòng model không giữ cả file; prompt và khóa khác của bản mới vẫn vào', () => {
  const base = role(), next = role({model: 'anthropic/claude-opus-5-5', prompt: 'Prompt v2.'});
  // Người dùng đổi thinking và tools; bản mới đổi model (từ model-roles.json) và prompt.
  const current = role({thinking: 'high', tools: '"read"'});
  const plan = reconcileRole({next, current, base});
  assert.equal(plan.content, role({model: 'anthropic/claude-opus-5-5', thinking: 'high', tools: '"read"', prompt: 'Prompt v2.'}));
  assert.deepEqual(plan.conflicts, []);
  assert.deepEqual(describeMerge({file: 'agents/worker.md', ...plan}), [
    'Đã gộp mặc định mới vào agents/worker.md, giữ phần bạn đã sửa:',
    '  - model: "openai-codex/gpt-6-sol" → "anthropic/claude-opus-5-5"',
    '  - cập nhật phần prompt theo bản mới',
  ]);
  // Người dùng sửa prompt, bản mới cũng đổi prompt: giữ prompt của người dùng và báo; khóa khác vẫn gộp.
  const edited = reconcileRole({next, current: role({prompt: 'Prompt của tôi.'}), base});
  assert.equal(edited.content, role({model: 'anthropic/claude-opus-5-5', prompt: 'Prompt của tôi.'}));
  assert.deepEqual(describeMerge({file: 'w.md', ...edited}).at(-1),
    '  - xung đột: giữ phần prompt bạn đã sửa; bản mới cũng đổi phần này (muốn nhận bản mới: đổi tên file rồi cài lại)');
});

test('file role: chưa sửa thì nhận bản mới; không đổi gì thì không ghi; chưa có base thì như trước', () => {
  const base = role(), next = role({prompt: 'Prompt v2.'});
  assert.deepEqual(reconcileRole({next, current: undefined, base}), {content: next, changes: [], conflicts: []});
  assert.deepEqual(reconcileRole({next, current: base, base}), {content: next, changes: [], conflicts: []});
  // Chỉ khác xuống dòng (CRLF trên Windows): cùng giá trị, không ghi.
  assert.deepEqual(reconcileRole({next, current: next.replaceAll('\n', '\r\n'), base}), {changes: [], conflicts: []});
  // Chưa có base: file khớp checksum lần trước thì nhận bản mới; đã sửa thì giữ mọi giá trị hiện có, thêm khóa thiếu.
  assert.equal(reconcileRole({next, current: base, unedited: true}).content, next);
  const additive = reconcileRole({next: next.replace('tools:', 'color: blue\ntools:'), current: role({model: 'anthropic/claude-opus-5-5'})});
  assert.equal(additive.additive, true);
  assert.equal(additive.content, role({model: 'anthropic/claude-opus-5-5'}).replace('\n---\n', '\ncolor: blue\n---\n'));
  assert.match(describeMerge({file: 'w.md', ...additive}).at(-1), /giữ phần prompt hiện có, khác bản mới/u);
  assert.deepEqual(reconcileRole({next, current: 'không có frontmatter', base}), {invalid: true, changes: [], conflicts: []});
});
