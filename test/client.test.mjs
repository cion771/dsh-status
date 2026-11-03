/**
 * Offline logic check for the DeepSeek API Status client module.
 *
 * Loads the browser artifact with a stubbed `window.__ModuleLoader__`, hands the
 * factory a minimal React stand-in (createElement + the two hooks involved), and
 * asserts the pill, the hover card it opens, and the translations. No browser and
 * no React runtime are involved.
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

assert.equal(definition.id, '@local/dsh-deepseek-status', 'module id must equal the package name');

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
// One number drives the colour: the share of the board that is impaired, where a
// degraded service costs half of a full outage.
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

// Nothing down is the host's success token, untouched.
assert.equal(
  module.healthColor(0),
  'color-mix(in srgb, var(--dsw-alias-state-success-primary) 100%, var(--dsw-alias-state-warn-primary) 0%)',
);
// Each further service slides the mix toward amber...
assert.equal(
  module.healthColor(1 / 7),
  'color-mix(in srgb, var(--dsw-alias-state-success-primary) 71%, var(--dsw-alias-state-warn-primary) 29%)',
);
assert.equal(
  module.healthColor(0.5),
  'color-mix(in srgb, var(--dsw-alias-state-success-primary) 0%, var(--dsw-alias-state-warn-primary) 100%)',
  'the pivot is pure amber',
);
// ...then from amber into red, all of them down being pure red.
assert.equal(
  module.healthColor(0.75),
  'color-mix(in srgb, var(--dsw-alias-state-warn-primary) 50%, var(--dsw-alias-state-error-primary) 50%)',
);
assert.equal(
  module.healthColor(1),
  'color-mix(in srgb, var(--dsw-alias-state-warn-primary) 0%, var(--dsw-alias-state-error-primary) 100%)',
);
// Out-of-range and non-finite input are clamped instead of producing broken CSS.
assert.equal(module.healthColor(-1), module.healthColor(0));
assert.equal(module.healthColor(9), module.healthColor(1));
assert.equal(module.healthColor(Number.NaN), module.healthColor(0));
// Every step from one service to all seven moves the mix in one direction.
const ramp = [0, 1, 2, 3, 4, 5, 6, 7].map((down) => module.healthColor(module.healthOf(
  Array.from({ length: 7 }, (_, index) => ({ name: `s${index}`, status: index < down ? 'full_outage' : 'operational' })),
).ratio));
assert.equal(new Set(ramp).size, 8, 'each additional outage yields its own colour');
// All degraded is amber, never red: only real outages reach the top of the ramp.
assert.equal(
  module.healthColor(module.healthOf(
    Array.from({ length: 7 }, (_, index) => ({ name: `s${index}`, status: 'degraded' })),
  ).ratio),
  module.healthColor(0.5),
);
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

// Board unavailable: the incident severity stands in for the missing count, so a
// feed-only "partial outage" still colours the indicator instead of going grey.
assert.equal(module.ratioForHeadline('operational'), 0);
assert.equal(module.ratioForHeadline('degraded'), 0.5);
assert.equal(module.ratioForHeadline('partial_outage'), 0.75);
assert.equal(module.ratioForHeadline('full_outage'), 1);
assert.equal(module.ratioForHeadline('unknown'), 0);

// ---- translation -----------------------------------------------------------
const dict = {
  'panel.title': 'DeepSeek API 服务状态',
  'panel.overall': '整体状态',
  'panel.affected': '受影响的服务',
  'panel.healthy': '其余服务正常',
  'panel.allHealthy': '所有服务运行正常',
  'panel.incidents': '进行中的事件',
  'panel.updated': '更新于 {value}',
  'panel.stale': '旧数据：本次刷新失败',
  'panel.source': '来源 status.deepseek.com（看板 + Atom 订阅）',
  'panel.empty': '暂时读取不到状态页数据',
  'status.operational': '正常',
  'status.degraded': '性能下降',
  'status.partial_outage': '部分中断',
  'status.full_outage': '中断',
  'status.maintenance': '维护中',
  'status.unknown': '未知',
  'status.loading': '读取中',
  brand: 'DeepSeek API',
  'incident.monitoring': '监控中',
};
const t = module.makeT((key) => dict[key] ?? key);
assert.equal(t('panel.updated', { value: '18:24' }), '更新于 18:24');
assert.equal(t('status.operational'), '正常');
assert.equal(module.makeT()('status.degraded'), 'degraded');

// ---- service split ---------------------------------------------------------
const board = {
  headline: 'partial_outage',
  fetchedAt: new Date(2026, 10, 3, 18, 24).getTime(),
  stale: false,
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
};

const split = module.splitServices(board.services);
assert.equal(split.affected.length, 3);
assert.equal(split.healthy.length, 4);
assert.deepEqual(
  split.affected.map((service) => service.status),
  ['partial_outage', 'partial_outage', 'degraded'],
  'the worst services come first',
);
assert.equal(module.clockOf(board.fetchedAt), '18:24');
assert.equal(module.clockOf(null), '—');

// ---- the hover card --------------------------------------------------------
const panel = module.StatusPanel({ board, t, loading: false, label: '部分中断', id: 'p1' });
assert.equal(panel.type, 'div');
assert.equal(panel.props.className, 'dsd-panel');
assert.equal(panel.props.id, 'p1');
assert.equal(panel.props.role, 'tooltip');

const head = panel.children[0];
assert.equal(head.props.className, 'dsd-panel-head');
assert.equal(head.children[0].children[0], 'DeepSeek API 服务状态', 'the card is titled');
assert.equal(head.children[1].props['data-tone'], 'error', 'the badge carries the tone');
assert.equal(head.children[1].children[0], '部分中断');

const body = panel.children.slice(1, -1);
const sections = body.filter((node) => node.props.className === 'dsd-sect').map((node) => node.children[0]);
assert.deepEqual(sections, ['受影响的服务', '其余服务正常 · 4', '进行中的事件']);

const rows = body.filter((node) => node.props.className === 'dsd-row');
assert.equal(rows.length, 7, 'three affected rows plus four healthy rows');
assert.deepEqual(rows.slice(0, 3).map((row) => row.props['data-tone']), ['error', 'error', 'warn']);
assert.deepEqual(rows.slice(3).map((row) => row.props['data-tone']), ['ok', 'ok', 'ok', 'ok']);
assert.equal(rows[0].children[1].children[0], 'DeepSeek V4.1 Flash API服务(API Service)');
assert.equal(rows[0].children[2].children[0], '部分中断');
assert.equal(rows[6].children[2].children[0], '正常');

const incident = body.find((node) => node.props.className === 'dsd-incident');
assert.equal(incident.children[0].children[0], '网页/API 部分中断');
assert.equal(incident.children[1].children[0], '监控中');
assert.equal(incident.children[2].children[0], 'https://status.deepseek.com/incidents/7202016104287');

const foot = panel.children[panel.children.length - 1];
assert.equal(foot.props.className, 'dsd-foot');
assert.equal(foot.children[1].children[0], '更新于 18:24');
assert.equal(foot.children[2].children[0], '来源 status.deepseek.com（看板 + Atom 订阅）');

// A stale board says so in the footer.
const stale = module.StatusPanel({ board: { ...board, stale: true }, t, loading: false, label: '部分中断', id: 'p2' });
const staleFoot = stale.children[stale.children.length - 1];
assert.equal(staleFoot.children[0].children[0], '旧数据：本次刷新失败');

// An all-healthy board shows the reassuring line and no affected section.
const healthyPanel = module.StatusPanel({
  board: { ...board, headline: 'operational', services: board.services.map((service) => ({ ...service, status: 'operational' })), incidents: [] },
  t,
  loading: false,
  label: '正常',
  id: 'p3',
});
const healthyBody = healthyPanel.children.slice(1, -1);
assert.equal(healthyBody[0].props.className, 'dsd-quiet');
assert.equal(healthyBody[0].children[1], '所有服务运行正常');
assert.equal(healthyBody.some((node) => node.props.className === 'dsd-incident'), false);

// Loading and unreadable boards render an explanation instead of empty space.
const empty = module.StatusPanel({ board: { headline: 'unknown', services: [], incidents: [] }, t, loading: false, label: '未知', id: 'p4' });
assert.equal(empty.children.slice(1, -1).at(-1).children[0], '暂时读取不到状态页数据');

// A feed-only board has no service rows but does have incidents: it must list the
// incidents without also claiming the status page could not be read.
const feedOnly = module.StatusPanel({
  board: {
    headline: 'partial_outage',
    services: [],
    incidents: [{ type: 'incident', status: 'monitoring', title: '网页/API 部分中断', link: '', affected: 3 }],
  },
  t,
  loading: false,
  label: '部分中断',
  id: 'p6',
});
const feedOnlyBody = feedOnly.children.slice(1, -1);
assert.equal(feedOnlyBody.some((node) => node.props.className === 'dsd-quiet'), false);
assert.equal(feedOnlyBody.some((node) => node.props.className === 'dsd-incident'), true);
const loadingPanel = module.StatusPanel({ board: { headline: 'unknown', services: [], incidents: [] }, t, loading: true, label: '读取中', id: 'p5' });
assert.equal(loadingPanel.children[0].children[1].props['data-tone'], 'unknown', 'the badge stays neutral while loading');

// ---- the pill --------------------------------------------------------------
const pill = module.StatusPill({ t: (key) => key });
assert.equal(pill.type, 'div');
assert.equal(pill.props.className, 'dsd-status-anchor');
assert.equal(pill.props.onMouseEnter, undefined, 'the card is revealed by CSS, not by pointer state');
assert.equal(pill.props.onMouseLeave, undefined);
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
const attached = pill.children[1];
assert.equal(attached.type, module.StatusPanel);
assert.equal(attached.props.id, 'dsd-panel-1');
assert.equal(attached.props.loading, true);

// A missing locale service must not throw.
const bare = module.StatusPill({});
assert.equal(bare.children[0].children[1].children[0], 'brand');

// The accessible fallback names the affected services.
const described = module.tooltip(board, t, '部分中断');
assert.ok(described.includes('受影响的服务'));
assert.ok(described.includes('DeepSeek V4.1 Flash API服务(API Service) — 部分中断'));
assert.ok(!described.includes('上传文件服务'), 'healthy services stay out of the summary');

console.log('deepseek-status client logic: OK');
