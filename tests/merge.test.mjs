import test from 'node:test';
import assert from 'node:assert/strict';
import {deepEqual, describeMerge, mergeConfig, reconcileJson, reconcileRole, setPathsOf} from '../runtime/merge.mjs';

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

test('cài lại sau khi bỏ Jev: autoMode.jev mặc định cũ bị xoá, giá trị người dùng tự đặt được giữ kèm báo xung đột', () => {
  const base = {autoMode: {model: 'anthropic/claude-sonnet-5-5', stage2Reasoning: 'low', jev: {model: 'jev-1.13.0'}, stateDir: '/s'}};
  const next = {autoMode: {model: 'anthropic/claude-sonnet-5-5', stage2Reasoning: 'low', stateDir: '/s'}};
  const untouched = merge(base, next, structuredClone(base));
  assert.deepEqual(untouched.value, next);
  assert.deepEqual(untouched.changes, [{type: 'delete', path: ['autoMode', 'jev']}]);
  const off = merge(base, next, {autoMode: {...base.autoMode, jev: false}});
  assert.equal(off.value.autoMode.jev, false);
  assert.deepEqual(off.conflicts, [{path: ['autoMode', 'jev'], current: false, next: undefined}]);
});

test('cài lại khi advisor thôi ghim executor: executor mặc định cũ bị xoá, executor người dùng ghim được giữ kèm báo xung đột', () => {
  const base = {alwaysOn: true, executor: 'anthropic/claude-opus-5-5', advisor: 'anthropic/claude-fable-5-1', advisorEffort: 'high'};
  const next = {alwaysOn: true, advisor: 'anthropic/claude-fable-5-1', advisorEffort: 'high'};
  const untouched = merge(base, next, structuredClone(base));
  assert.deepEqual(untouched.value, next);
  assert.deepEqual(untouched.changes, [{type: 'delete', path: ['executor']}]);
  const pinned = merge(base, next, {...base, executor: 'anthropic/claude-sonnet-5-5'});
  assert.equal(pinned.value.executor, 'anthropic/claude-sonnet-5-5');
  assert.deepEqual(pinned.conflicts, [{path: ['executor'], current: 'anthropic/claude-sonnet-5-5', next: undefined}]);
});

test('mảng thường là một giá trị; mảng tập hợp chỉ áp dụng cho các đường dẫn đã khai báo của từng file', () => {
  const base = {searchRouting: {fallbackOn: ['network', 'quota']}, deny: ['a'], permissions: {deny: ['a']}};
  const next = {searchRouting: {fallbackOn: ['network', 'transient', 'quota']}, deny: ['a', 'b'], permissions: {deny: ['a', 'b']}};
  const current = {searchRouting: {fallbackOn: ['quota', 'network']}, deny: ['a', 'mine'], permissions: {deny: ['a', 'mine']}};
  const settings = merge(base, next, current);
  assert.deepEqual(settings.value.searchRouting.fallbackOn, ['quota', 'network']);
  assert.deepEqual(settings.value.deny, ['a', 'mine'], 'deny ngoài permissions là mảng thường');
  assert.deepEqual(settings.value.permissions.deny, ['a', 'mine', 'b']);
  assert.deepEqual(settings.conflicts.map(conflict => conflict.path.join('.')), ['searchRouting.fallbackOn', 'deny']);
  const other = merge(base, next, current, false);
  assert.deepEqual(other.value.permissions.deny, ['a', 'mine'], 'file khác settings.json: mảng là một giá trị');
  // Người dùng chưa đổi mảng thường thì nhận mảng mới.
  assert.deepEqual(merge(base, next, {...current, searchRouting: {fallbackOn: ['network', 'quota']}}).value.searchRouting.fallbackOn, ['network', 'transient', 'quota']);
});

test('web-search.json: hai danh sách provider gộp theo phần tử, nên provider mặc định mới bỏ rời cả hai dù người dùng đã sửa một danh sách', () => {
  const web = (base, next, current) => mergeConfig({base, next, current, sets: setPathsOf('/agent/web-search.json')});
  const lists = (allowed, providers) => ({webSearch: {allowedProviders: allowed}, searchRouting: {providers, useCurrentModel: true}});
  const base = lists(['openai', 'anthropic', 'exa', 'firecrawl'], ['openai', 'anthropic', 'exa', 'firecrawl']);
  const next = lists(['openai', 'anthropic', 'exa'], ['openai', 'anthropic', 'exa']);
  // Người dùng chỉ đổi thứ tự searchRouting.providers: giữ thứ tự đó, firecrawl rời cả hai danh sách (pi-web-access
  // không nạp khi searchRouting.providers có provider ngoài webSearch.allowedProviders).
  const reordered = web(base, next, lists(base.webSearch.allowedProviders, ['anthropic', 'openai', 'exa', 'firecrawl']));
  assert.deepEqual(reordered.value, lists(['openai', 'anthropic', 'exa'], ['anthropic', 'openai', 'exa']));
  assert.deepEqual(reordered.conflicts, []);
  assert.deepEqual(reordered.changes.map(change => [change.path.join('.'), change.type]), [['webSearch.allowedProviders', 'set'], ['searchRouting.providers', 'items']]);
  // Provider người dùng tự thêm vào cả hai danh sách được giữ; provider người dùng đã bỏ vẫn bỏ.
  const custom = web(base, next, lists(['openai', 'anthropic', 'exa', 'firecrawl', 'brave'], ['brave', 'exa', 'firecrawl']));
  assert.deepEqual(custom.value, lists(['openai', 'anthropic', 'exa', 'brave'], ['brave', 'exa']));
  // Danh sách chưa sửa nhận nguyên mặc định mới, đúng thứ tự (thứ tự là thứ tự ưu tiên), dù phần khác của file đã sửa.
  const inserted = web(lists(['openai', 'exa'], ['openai', 'exa']), next, {...lists(['openai', 'exa'], ['openai', 'exa']), workflow: 'mine'});
  assert.deepEqual(inserted.value.searchRouting.providers, ['openai', 'anthropic', 'exa']);
  // Hai danh sách đi theo cặp: pi-web-access không nạp khi một danh sách rỗng, trùng mục (không phân biệt hoa thường)
  // hoặc searchRouting.providers có provider ngoài webSearch.allowedProviders. Gộp theo phần tử cho ra cặp như vậy
  // từ một cặp đang nạp được thì giữ nguyên cả hai danh sách của người dùng và báo xung đột.
  const kept = (allowed, providers, [from, to] = [base, next]) => {
    const result = web(from, to, lists(allowed, providers));
    assert.deepEqual(result.value, lists(allowed, providers));
    assert.deepEqual(result.changes, []);
    assert.deepEqual(result.conflicts, [
      {path: ['webSearch', 'allowedProviders'], current: allowed, next: to.webSearch.allowedProviders},
      {path: ['searchRouting', 'providers'], current: providers, next: to.searchRouting.providers},
    ]);
  };
  kept(['firecrawl'], ['firecrawl']); // mọi provider người dùng giữ đều bị mặc định mới bỏ: cả hai danh sách sẽ rỗng
  kept(['exa', 'firecrawl'], ['firecrawl']); // định tuyến sẽ rỗng trong khi allowlist còn exa
  // Mặc định mới thu hẹp allowlist trong khi người dùng định tuyến tới đúng provider bị bỏ.
  kept(['brave', 'exa'], ['brave'], [lists(['exa', 'brave'], ['exa']), lists(['exa'], ['exa'])]);
  // Chưa có base: giữ danh sách hiện có, không cộng dồn (provider người dùng đã bỏ khỏi allowlist không tự quay lại,
  // tên viết hoa không thành mục trùng).
  kept(['exa'], ['exa'], [undefined, next]);
  kept(['OpenAI', 'Exa'], ['Exa'], [undefined, next]);
  // Provider cố định (provider/searchProvider) cũng phải nằm trong allowlist: gộp làm nó rơi ra ngoài thì giữ hai danh sách.
  for (const key of ['provider', 'searchProvider']) {
    const fixed = web(base, next, {...lists(['exa', 'firecrawl'], ['exa', 'firecrawl']), [key]: ' Firecrawl '});
    assert.deepEqual(fixed.value, {...lists(['exa', 'firecrawl'], ['exa', 'firecrawl']), [key]: ' Firecrawl '});
    assert.deepEqual(fixed.conflicts.map(conflict => conflict.path.join('.')), ['webSearch.allowedProviders', 'searchRouting.providers']);
    // Danh sách chưa sửa cũng được giữ khi provider cố định cần nó.
    const pinned = web(base, next, {...structuredClone(base), [key]: 'firecrawl'});
    assert.deepEqual(pinned.value, {...base, [key]: 'firecrawl'});
    // auto/all không trỏ tới provider nào; provider cố định còn trong allowlist thì gộp như thường.
    for (const value of ['auto', 'ALL', 'exa']) {
      const free = web(base, next, {...lists(base.webSearch.allowedProviders, ['exa', 'firecrawl', 'openai']), [key]: value});
      assert.deepEqual([free.value, free.conflicts], [{...lists(['openai', 'anthropic', 'exa'], ['exa', 'openai']), [key]: value}, []]);
    }
  }
  // Tên provider cố định mà allowlist hiện tại không có (pi-web-access coi tên lạ là auto) không tắt phép giữ danh sách.
  const unknown = web(base, next, {...lists(base.webSearch.allowedProviders, ['firecrawl']), provider: 'unknown-name'});
  assert.deepEqual(unknown.value, {...lists(base.webSearch.allowedProviders, ['firecrawl']), provider: 'unknown-name'});
  // Chưa có base và file thiếu hẳn một danh sách (người dùng bỏ allowlist, hoặc bỏ searchRouting để dùng auto): danh sách
  // mặc định chỉ được thêm khi file vẫn nạp được; không thì giữ file như đang có và báo xung đột.
  const routing = {searchRouting: {providers: ['exa', 'firecrawl'], useCurrentModel: true}};
  const open = web(undefined, next, routing);
  assert.deepEqual(open.value, routing);
  assert.deepEqual(open.conflicts.map(conflict => [conflict.path.join('.'), conflict.current]), [['searchRouting.providers', ['exa', 'firecrawl']], ['webSearch', undefined]]);
  const narrow = web(undefined, next, {webSearch: {allowedProviders: ['exa']}});
  assert.deepEqual(narrow.value, {webSearch: {allowedProviders: ['exa']}});
  assert.deepEqual(narrow.conflicts.map(conflict => conflict.path.join('.')), ['webSearch.allowedProviders', 'searchRouting']);
  const fits = web(undefined, next, {searchRouting: {providers: ['exa'], useCurrentModel: true}});
  assert.deepEqual(fits.value, {searchRouting: {providers: ['exa'], useCurrentModel: true}, webSearch: next.webSearch});
  // Lần cài sau (base đã là mặc định mới): không ghi, không báo lại.
  const settled = web(next, next, lists(['exa', 'firecrawl'], ['firecrawl']));
  assert.deepEqual([settled.value, settled.changes, settled.conflicts], [lists(['exa', 'firecrawl'], ['firecrawl']), [], []]);
  // Tên viết hoa của người dùng được giữ và vẫn khớp khi so danh sách.
  const cased = web(base, next, lists(['OpenAI', 'anthropic', 'exa', 'firecrawl'], base.searchRouting.providers));
  assert.deepEqual([cased.value, cased.conflicts], [lists(['OpenAI', 'anthropic', 'exa'], ['openai', 'anthropic', 'exa']), []]);
  // Cặp hiện tại vốn không nạp được (người dùng để định tuyến rỗng): gộp như thường, không che lỗi sẵn có.
  assert.deepEqual(web(base, next, lists(base.webSearch.allowedProviders, [])).value, lists(['openai', 'anthropic', 'exa'], []));
  // Cùng khóa đó trong file khác vẫn là một giá trị.
  assert.deepEqual(setPathsOf('/agent/open-tui.json'), undefined);
  assert.ok(setPathsOf('/agent/settings.json').paths.has('permissions.deny'));
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

test('chưa có base: giữ mọi giá trị hiện có, thêm khóa và mục còn thiếu, báo giá trị khác mặc định mới', () => {
  const next = {
    defaultModel: 'claude-opus-5-5', compaction: {enabled: true, keepRecentTokens: 20000},
    permissions: {deny: ['Path(~/.ssh)', 'Path(~/.ssh/**)', 'Bash(sudo *)'], ask: ['Edit(x)']},
    extensions: ['/r/palette.ts', '/r/claude-usage', '/r/pi-auto-mode'], rewind: {retentionDays: 30},
  };
  const current = {
    defaultModel: 'gpt-6.1-sol', compaction: {enabled: true},
    permissions: {deny: ['Path(~/.ssh/*)', 'Bash(sudo *)', 'Path(~/mine)']},
    extensions: ['-/r/palette.ts', '/r/palette.ts', '/r/pi-auto-mode', '/home/u/x.ts'],
  };
  const result = merge(undefined, next, current);
  assert.deepEqual(result.value, {
    defaultModel: 'gpt-6.1-sol', compaction: {enabled: true, keepRecentTokens: 20000},
    permissions: {deny: ['Path(~/.ssh/*)', 'Bash(sudo *)', 'Path(~/mine)', 'Path(~/.ssh)', 'Path(~/.ssh/**)'], ask: ['Edit(x)']},
    extensions: ['-/r/palette.ts', '/r/palette.ts', '/home/u/x.ts', '/r/claude-usage', '/r/pi-auto-mode'], rewind: {retentionDays: 30},
  });
  assert.deepEqual(result.conflicts, [{path: ['defaultModel'], current: 'gpt-6.1-sol', next: 'claude-opus-5-5'}]);
  const plan = reconcileJson({next: json(next), current: json(current), settings: true});
  assert.equal(plan.additive, true);
  assert.deepEqual(JSON.parse(plan.content), result.value);
  const report = describeMerge({file: '/a/settings.json', ...plan});
  assert.match(report[0], /^Chưa có mặc định của lần cài trước cho \/a\/settings\.json: giữ mọi giá trị hiện có/u);
  assert.ok(report.includes('  - xung đột: giữ giá trị hiện có cho defaultModel; mặc định mới là "claude-opus-5-5"'), report.join('\n'));
});

test('chưa có base nhưng file chưa sửa: nhận nguyên mặc định mới', () => {
  const next = {defaultModel: 'new', permissions: {deny: ['Bash(sudo *)']}};
  const current = {defaultModel: 'old', permissions: {deny: ['Path(/old/key)']}};
  assert.deepEqual(reconcileJson({next: json(next), current: json(current), unedited: true, settings: true}),
    {content: json(next), changes: [], conflicts: []});
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
  const base = {searchRouting: {fallbackOn: ['network', 'quota']}, compaction: {keepRecentTokens: 10000}, gone: 1};
  const next = {searchRouting: {fallbackOn: ['network', 'transient', 'quota']}, compaction: {keepRecentTokens: 20000}, modelThinkingLevels: {'openai/x': 'max'}};
  const current = {searchRouting: {fallbackOn: ['quota']}, compaction: {keepRecentTokens: 10000}, gone: 2};
  const lines = describeMerge({file: '/agent/web-search.json', ...merge(base, next, current, false)});
  assert.deepEqual(lines, [
    'Đã gộp mặc định mới vào /agent/web-search.json, giữ phần bạn đã sửa:',
    '  - compaction.keepRecentTokens: 10000 → 20000',
    '  - thêm modelThinkingLevels = {"openai/x":"max"}',
    '  - xung đột: giữ giá trị của bạn cho searchRouting.fallbackOn; mặc định mới là ["network","transient","quota"]',
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

const role = ({model = 'openai-codex/gpt-6.1-sol', thinking = 'max', tools = '"read, bash"', prompt = 'Prompt v1.'} = {}) =>
  `---\nname: worker\ndescription: Viết code.\nmodel: ${model}\nthinking: ${thinking}\ntools: ${tools}\n---\n\n${prompt}\n`;

test('file role: sửa dòng model không giữ cả file; prompt và khóa khác của bản mới vẫn vào', () => {
  const base = role(), next = role({model: 'anthropic/claude-opus-5-5', prompt: 'Prompt v2.'});
  // Người dùng đổi thinking và tools; bản mới đổi model (mặc định của bản phát hành) và prompt.
  const current = role({thinking: 'high', tools: '"read"'});
  const plan = reconcileRole({next, current, base});
  assert.equal(plan.content, role({model: 'anthropic/claude-opus-5-5', thinking: 'high', tools: '"read"', prompt: 'Prompt v2.'}));
  assert.deepEqual(plan.conflicts, []);
  assert.deepEqual(describeMerge({file: 'agents/worker.md', ...plan}), [
    'Đã gộp mặc định mới vào agents/worker.md, giữ phần bạn đã sửa:',
    '  - model: "openai-codex/gpt-6.1-sol" → "anthropic/claude-opus-5-5"',
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
