/**
 * Offline logic check for the AI API Status client module.
 *
 * Loads the browser artifact with a stubbed `window.__ModuleLoader__`, hands the
 * factory a minimal React stand-in (createElement + the two hooks involved), and
 * asserts the pill, the hover card it opens, the provider blocks, and the colour
 * ramp. No browser and no React runtime are involved.
 */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const source = await readFile(path.resolve(here, '..', 'client.js'), 'utf8');

let definition;
const window = { __ModuleLoader__: { load(next) { definition = next; } } };
new Function('window', source)(window);

assert.equal(definition.id, '@local/dsh-status', 'module id must equal the package name');

const React = {
  createElement(type, props, ...children) {
    return { type, props: props ?? {}, children };
  },
  useState(initial) {
    return [typeof initial === 'function' ? initial() : initial, () => undefined];
  },
  useEffect() {
    /* the poll is exercised through the Host route, not here */
  },
};
const module = definition.factory((name) => {
  assert.equal(name, 'react');
  return React;
});

assert.deepEqual(module.inject, ['slots', 'locale']);

// ---- tone mapping ----------------------------------------------------------
assert.deepEqual(module.TONE, {
  operational: 'ok',
  degraded: 'warn',
  maintenance: 'warn',
  partial_outage: 'error',
  full_outage: 'error',
  unknown: 'unknown',
});
for (const headline of Object.keys(module.TONE)) {
  assert.equal(typeof module.LABEL_KEY[headline], 'string', `missing label for ${headline}`);
}
assert.equal(module.serviceTone('partial_outage'), 'error');
assert.equal(module.serviceTone('degraded'), 'warn');
assert.equal(module.serviceTone('operational'), 'ok');
assert.equal(module.serviceTone('nonsense'), 'unknown');

// ---- the green-to-red ramp -------------------------------------------------
// One number drives the colour: the share of a provider's board that is impaired,
// where a degraded service costs half of a full outage.
assert.equal(module.HEALTH_PIVOT, 0.5);
assert.deepEqual(module.healthOf([]), { total: 0, affected: 0, known: false, ratio: 0 });
assert.deepEqual(module.healthOf(null), { total: 0, affected: 0, known: false, ratio: 0 });
assert.deepEqual(module.healthOf([{ name: 'A', status: 'operational' }]), {
  total: 1, affected: 0, known: true, ratio: 0,
});
assert.deepEqual(module.healthOf([
  { name: 'A', status: 'operational' },
  { name: 'B', status: 'degraded' },
  { name: 'C', status: 'full_outage' },
  { name: 'D', status: 'partial_outage' },
]), { total: 4, affected: 3, known: true, ratio: 0.625 });
// An unfamiliar state counts as impaired rather than passing as healthy.
assert.equal(module.healthOf([{ name: 'A', status: 'weird' }]).ratio, 1);

assert.equal(
  module.healthColor(0),
  'color-mix(in srgb, var(--dsw-alias-state-success-primary) 100%, var(--dsw-alias-state-warn-primary) 0%)',
);
assert.equal(
  module.healthColor(1 / 7),
  'color-mix(in srgb, var(--dsw-alias-state-success-primary) 71%, var(--dsw-alias-state-warn-primary) 29%)',
);
assert.equal(
  module.healthColor(0.5),
  'color-mix(in srgb, var(--dsw-alias-state-success-primary) 0%, var(--dsw-alias-state-warn-primary) 100%)',
  'the pivot is pure amber',
);
assert.equal(
  module.healthColor(0.75),
  'color-mix(in srgb, var(--dsw-alias-state-warn-primary) 50%, var(--dsw-alias-state-error-primary) 50%)',
);
assert.equal(
  module.healthColor(1),
  'color-mix(in srgb, var(--dsw-alias-state-warn-primary) 0%, var(--dsw-alias-state-error-primary) 100%)',
);
assert.equal(module.healthColor(-1), module.healthColor(0));
assert.equal(module.healthColor(9), module.healthColor(1));
assert.equal(module.healthColor(Number.NaN), module.healthColor(0));

const ramp = [0, 1, 2, 3, 4, 5, 6, 7].map((down) => module.healthColor(module.healthOf(
  Array.from({ length: 7 }, (_, index) => ({ name: `s${index}`, status: index < down ? 'full_outage' : 'operational' })),
).ratio));
assert.equal(new Set(ramp).size, 8, 'each additional outage yields its own colour');
const progress = (color) => {
  const error = /state-error-primary\) (\d+)%/.exec(color);
  if (error !== null) return 100 + Number(error[1]);
  const success = /state-success-primary\) (\d+)%/.exec(color);
  return success === null ? Number.NaN : 100 - Number(success[1]);
};
const steps = ramp.map(progress);
for (let index = 1; index < steps.length; index += 1) {
  assert.ok(steps[index] > steps[index - 1], `outage ${index} must be further from green than ${index - 1}`);
}
assert.equal(steps[0], 0, 'a healthy board starts at pure green');
assert.equal(steps[steps.length - 1], 200, 'a fully down board ends at pure red');
// All degraded is amber, never red: only real outages reach the top of the ramp.
assert.equal(
  module.healthColor(module.healthOf(
    Array.from({ length: 7 }, (_, index) => ({ name: `s${index}`, status: 'degraded' })),
  ).ratio),
  module.healthColor(0.5),
);

// Without a component list the incident severity stands in for the count.
assert.equal(module.ratioForHeadline('operational'), 0);
assert.equal(module.ratioForHeadline('degraded'), 0.5);
assert.equal(module.ratioForHeadline('partial_outage'), 0.75);
assert.equal(module.ratioForHeadline('full_outage'), 1);
assert.equal(module.ratioForHeadline('unknown'), 0);

// ---- translation -----------------------------------------------------------
const dict = {
  'panel.title': 'AI API 服务状态',
  'panel.overall': '整体状态',
  'panel.detail.allHealthy': '{count} 项组件全部正常',
  'panel.detail.rest': '其余 {count} 项正常',
  'panel.detail.unavailable': '暂不可用',
  'panel.updated': '更新于 {value}',
  'panel.stale': '旧数据：本次刷新失败',
  'panel.source': '来源 {value}',
  'panel.currentModel': '当前模型 {value}',
  'panel.others': '其他 {value}',
  'panel.empty': '暂时读取不到状态页数据',
  'status.operational': '正常',
  'status.degraded': '性能下降',
  'status.partial_outage': '部分中断',
  'status.full_outage': '中断',
  'status.maintenance': '维护中',
  'status.unknown': '未知',
  'status.loading': '读取中',
  brand: 'AI API',
  'incident.monitoring': '监控中',
};
const t = module.makeT((key) => dict[key] ?? key);
assert.equal(t('panel.detail.allHealthy', { count: 7 }), '7 项组件全部正常');
assert.equal(t('panel.source', { value: 'a · b' }), '来源 a · b');
assert.equal(t('status.operational'), '正常');
assert.equal(module.makeT()('status.degraded'), 'degraded');

// ---- the multi-provider board ---------------------------------------------
const board = {
  headline: 'partial_outage',
  fetchedAt: new Date(2026, 10, 3, 18, 24).getTime(),
  providers: [
    {
      id: 'deepseek',
      name: 'DeepSeek',
      ok: true,
      stale: false,
      headline: 'partial_outage',
      source: 'https://status.deepseek.com/',
      services: [
        { name: 'DeepSeek V4 Pro API服务(API Service)', status: 'degraded' },
        { name: 'DeepSeek V4.1 Flash API服务(API Service)', status: 'partial_outage' },
        { name: '对话服务(Chatservice)', status: 'partial_outage' },
        { name: '上传文件服务(File Upload Service)', status: 'operational' },
        { name: '搜索服务(Search Service)', status: 'operational' },
        { name: '搜索API服务(Search API Service)', status: 'operational' },
        { name: '抓取API服务(Fetch API Service)', status: 'operational' },
      ],
      incidents: [{
        type: 'incident',
        status: 'monitoring',
        title: '网页/API 部分中断',
        link: 'https://status.deepseek.com/incidents/7202016104287',
        affected: 3,
      }],
    },
    {
      id: 'openai',
      name: 'GPT',
      ok: true,
      stale: false,
      headline: 'operational',
      source: 'https://status.openai.com',
      services: [
        { name: 'Chat Completions', status: 'operational' },
        { name: 'Responses', status: 'operational' },
      ],
      incidents: [],
    },
    {
      id: 'anthropic',
      name: 'Claude',
      ok: false,
      stale: true,
      headline: 'unknown',
      source: 'https://status.anthropic.com',
      services: [],
      incidents: [],
      error: 'status.anthropic.com answered 503',
    },
  ],
};

assert.equal(module.providersOf(board).length, 3);
assert.deepEqual(module.providersOf({}), []);
assert.deepEqual(module.providersOf(null), []);
assert.equal(module.providerRatio(board.providers[0]), 2.5 / 7, '(0.5 + 1 + 1) / 7 weighted');
assert.equal(module.providerRatio(board.providers[1]), 0);
assert.equal(module.providerRatio(board.providers[2]), 0, 'unknown provider has no ratio');
assert.equal(module.clockOf(board.fetchedAt), '18:24');

// ---- which page belongs to the selected model ------------------------------
assert.equal(module.matchProviderId({ provider: 'deepseek', model: 'deepseek-v4.1-flash' }), 'deepseek');
assert.equal(module.matchProviderId({ provider: 'anthropic', model: 'claude-sonnet-4.5' }), 'anthropic');
assert.equal(module.matchProviderId({ provider: 'openai', model: 'gpt-5.1' }), 'openai');
assert.equal(module.matchProviderId({ provider: 'codex', model: 'gpt-5.1-codex' }), 'openai');
assert.equal(module.matchProviderId({ provider: 'openai', model: 'o3' }), 'openai');
assert.equal(module.matchProviderId({ provider: 'anthropic', model: 'claude-opus-4.1' }), 'anthropic');
// A Claude model on an unrelated adapter still resolves by model id.
assert.equal(module.matchProviderId({ provider: 'custom', model: 'claude-haiku-4' }), 'anthropic');
assert.equal(module.matchProviderId({ provider: 'custom', model: 'deepseek-v4-flash' }), 'deepseek');
// The exact shapes this profile produces: a gateway provider id with a namespaced
// model id, which only the model half identifies.
assert.equal(module.matchProviderId({ provider: 'dsh-opencode-go', model: 'deepseek-v4.1-flash' }), 'deepseek');
assert.equal(module.matchProviderId({ provider: 'dsh-opencode-go', model: 'opencode-go/gpt-6-luna' }), 'openai');
assert.equal(module.matchProviderId({ provider: 'magpie-responses', model: 'opencode-go/gpt-6-luna' }), 'openai');
assert.equal(module.matchProviderId({ provider: 'dsh-opencode-go', model: 'opencode-go/claude-sonnet-4.5' }), 'anthropic');

// Unknown or absent selections keep the aggregate view.
assert.equal(module.matchProviderId(null), null);
assert.equal(module.matchProviderId({}), null);
assert.equal(module.matchProviderId({ provider: 'qwen', model: 'qwen-max' }), null);
assert.equal(module.matchProviderId({ provider: 'openai', model: 'not-o1' }), 'openai');

// ---- the hover card --------------------------------------------------------
const panel = module.StatusPanel({ board, t, loading: false, label: '部分中断', id: 'p1' });
assert.equal(panel.type, 'div');
assert.equal(panel.props.className, 'dsd-panel');
assert.equal(panel.props.id, 'p1');
assert.equal(panel.props.role, 'tooltip');

const head = panel.children[0];
assert.equal(head.props.className, 'dsd-panel-head');
assert.equal(head.children[0].children[0], 'AI API 服务状态', 'the card is titled');
assert.equal(head.children[1].props['data-tone'], 'error', 'the badge carries the tone');
assert.equal(head.children[1].children[0], '部分中断');

const body = panel.children.slice(1, -1);
const providerRows = body.filter((node) => node.props.className === 'dsd-provider');
assert.equal(providerRows.length, 3, 'one block per provider');
assert.deepEqual(providerRows.map((row) => row.children[1].children[0]), ['DeepSeek', 'GPT', 'Claude']);
assert.deepEqual(providerRows.map((row) => row.props['data-tone']), ['error', 'ok', 'unknown']);
assert.deepEqual(
  providerRows.map((row) => row.children[2].children[0]),
  ['部分中断', '正常', '暂不可用'],
);

// DeepSeek shows each impaired component, then a count of the rest.
const affectedRows = body.filter((node) => node.props.className === 'dsd-sub');
assert.equal(affectedRows.length, 3, 'only the impaired components get a row');
assert.deepEqual(affectedRows.map((row) => row.props['data-tone']), ['error', 'error', 'warn']);
assert.equal(affectedRows[0].children[1].children[0], 'DeepSeek V4.1 Flash API服务(API Service)');
assert.equal(affectedRows[0].children[2].children[0], '部分中断');

const quiet = body.filter((node) => String(node.props.className).startsWith('dsd-quiet'));
assert.equal(quiet[0].children[0], '其余 4 项正常', 'the healthy rest is counted, not listed');

// GPT is healthy: one line, no rows.
const gptQuiet = quiet.find((node) => node.children[0] === '2 项组件全部正常');
assert.ok(gptQuiet, 'a healthy provider states its component count');

// Claude could not be read: it says so and carries the reason.
const claudeQuiet = quiet.find((node) => String(node.children[0]).includes('503'));
assert.ok(claudeQuiet, 'an unreadable provider reports its error');

// The incident keeps its state and permalink.
const incident = body.find((node) => node.props.className.startsWith('dsd-incident'));
assert.equal(incident.children[0].children[0], '网页/API 部分中断');
assert.equal(incident.children[1].children[0], '监控中');
assert.equal(incident.children[2].children[0], 'https://status.deepseek.com/incidents/7202016104287');

const foot = panel.children[panel.children.length - 1];
assert.equal(foot.props.className, 'dsd-foot');
assert.equal(foot.children[0].children[0], '旧数据：本次刷新失败', 'a stale provider warns');
assert.equal(foot.children[1].children[0], '更新于 18:24');
assert.equal(
  foot.children[2].children[0],
  '来源 https://status.deepseek.com/ · https://status.openai.com · https://status.anthropic.com',
);

// A focused card follows one provider and summarises the rest.
const focusedPanel = module.StatusPanel({
  board,
  t,
  loading: false,
  label: '部分中断',
  id: 'p7',
  focus: 'deepseek',
  model: 'deepseek · deepseek-v4.1-flash',
});
const focusedBody = focusedPanel.children.slice(1, -1);
const focusedProviders = focusedBody.filter((node) => node.props.className === 'dsd-provider');
assert.equal(focusedProviders.length, 1, 'only the selected provider gets a block');
assert.equal(focusedProviders[0].children[1].children[0], 'DeepSeek');
assert.equal(
  focusedBody.find((node) => node.props.className === 'dsd-model').children[0],
  '当前模型 deepseek · deepseek-v4.1-flash',
);
assert.equal(
  focusedBody.find((node) => node.props.className === 'dsd-others').children[0],
  '其他 GPT 正常 · Claude 暂不可用',
);
assert.equal(focusedBody.some((node) => node.props.className === 'dsd-provider'
  && node.children[1].children[0] === 'GPT'), false, 'other providers are not given a block');

// Loading and unreadable boards render an explanation instead of empty space.
const empty = module.StatusPanel({ board: { headline: 'unknown', providers: [] }, t, loading: false, label: '未知', id: 'p4' });
assert.equal(empty.children.slice(1, -1).at(-1).children[0], '暂时读取不到状态页数据');
const loadingPanel = module.StatusPanel({ board: { headline: 'unknown', providers: [] }, t, loading: true, label: '读取中', id: 'p5' });
assert.equal(loadingPanel.children[0].children[1].props['data-tone'], 'unknown', 'the badge stays neutral while loading');

// ---- the pill --------------------------------------------------------------
const pill = module.StatusPill({ t: (key) => key });
assert.equal(pill.type, 'div');
assert.equal(pill.props.className, 'dsd-status-anchor');
assert.equal(pill.props.onMouseEnter, undefined, 'the card is revealed by CSS, not by pointer state');
assert.equal(
  pill.props.style['--dsd-health'],
  'var(--dsw-alias-state-idle-primary)',
  'an unread board stays neutral instead of claiming green',
);

const chip = pill.children[0];
assert.equal(chip.props.className, 'dsd-status-pill');
assert.equal(chip.props.role, 'status');
assert.equal(chip.props['aria-live'], 'polite');
assert.equal(chip.props.tabIndex, 0, 'the pill is focusable for keyboard users');
assert.equal(chip.props['data-tone'], 'unknown');
assert.equal(chip.props['data-busy'], '1');
assert.equal(chip.props['aria-label'], 'brand · status.loading');
assert.equal(chip.children[2].children[0], 'status.loading');
assert.equal(chip.props['aria-describedby'], 'dsd-panel-1', 'the pill points at its card');
assert.equal(pill.children.length, 2, 'the card is always in the tree, hidden by CSS');
assert.equal(pill.children[1].props.id, 'dsd-panel-1');

// A missing locale service must not throw.
const bare = module.StatusPill({});
assert.equal(bare.children[0].children[1].children[0], 'brand');

// The accessible fallback names each provider and its impaired components.
const described = module.tooltip(board, t, '部分中断');
assert.ok(described.includes('DeepSeek — 部分中断'));
assert.ok(described.includes('· DeepSeek V4.1 Flash API服务(API Service) — 部分中断'));
assert.ok(described.includes('GPT — 正常'));
assert.ok(described.includes('· DeepSeek：网页/API 部分中断（监控中）'));
assert.ok(!described.includes('上传文件服务'), 'healthy components stay out of the summary');

console.log('dsh-status client logic: OK');
