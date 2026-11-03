/**
 * Offline check for the Host half: fold the saved component board, parse the saved
 * Atom feed, and verify how the two combine.
 *
 * Ground truth (status.deepseek.com, 2026-11-03 18:17 +08:00):
 *   board headline  "部分服务性能下降"  -> degraded, V4 Pro degraded, 6 operational
 *   feed            28 changes, exactly 1 still open: "…部分中断" / monitoring
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  aggregateHeadline,
  combine,
  headlineFromIncidents,
  openIncidents,
  parseFeed,
  readJsonValue,
  rscPayload,
  summarize,
  summarizeStatuspage,
} from '../index.js';

const read = (name) => readFileSync(new URL(`./${name}`, import.meta.url), 'utf8');

// ---- component board -------------------------------------------------------
const payload = rscPayload(read('status.html'));
assert.ok(payload.length > 10000, `flight payload too small: ${payload.length}`);

const components = readJsonValue(payload, 'components');
const activeChanges = readJsonValue(payload, 'active_changes');

// The message dictionary holds `"components":"{count} components"`; the reader
// must skip that string form and return the array.
assert.ok(Array.isArray(components), 'components must parse as an array');
assert.equal(components.length, 7, 'seven components on the board');
assert.ok(Array.isArray(activeChanges), 'active_changes must parse as an array');

const board = summarize({ components, activeChanges, nowSeconds: 1793700733 });
assert.equal(board.headline, 'degraded');
assert.equal(board.incidents.length, 1);
assert.equal(board.incidents[0].status, 'monitoring');
assert.match(board.incidents[0].title, /部分中断/);

const boardByName = new Map(board.services.map((service) => [service.name, service.status]));
assert.equal(boardByName.get('DeepSeek V4 Pro API服务(API Service)'), 'degraded');
assert.equal(boardByName.get('DeepSeek V4.1 Flash API服务(API Service)'), 'operational');
assert.equal(board.services.filter((service) => service.status !== 'operational').length, 1);

// ---- Atom feed -------------------------------------------------------------
const entries = parseFeed(read('feed.atom'));
assert.equal(entries.length, 28, 'twenty-eight changes in the feed');
assert.ok(entries.every((entry) => entry.title !== ''), 'every entry keeps its title');
assert.ok(entries.every((entry) => /^urn:flashduty:change:\d+$|^\d+$/.test(entry.changeId) || entry.changeId !== ''));
assert.ok(entries.every((entry) => entry.type === 'incident'), 'this window holds no maintenance');
assert.ok(entries.every((entry) => typeof entry.updatedAt === 'number' && entry.updatedAt > 0));

const open = openIncidents(entries);
assert.equal(open.length, 1, 'exactly one change is still open');
assert.equal(open[0].status, 'monitoring');
assert.match(open[0].title, /部分中断/);
assert.match(open[0].link, /^https:\/\/status\.deepseek\.com\/incidents\/\d+$/);
assert.deepEqual(open[0].components.slice().sort(), [
  'DeepSeek V4 Pro API服务(API Service)',
  'DeepSeek V4.1 Flash API服务(API Service)',
  '对话服务(Chatservice)',
].sort());

// ---- combination -----------------------------------------------------------
const both = combine({ board, feed: entries, boardOk: true, feedOk: true, now: 1 });
assert.equal(both.headline, 'degraded', 'the board owns the headline');
assert.equal(both.services.length, 7);
assert.equal(both.incidents.length, 1);
assert.equal(both.incidents[0].status, 'monitoring');
assert.match(both.incidents[0].link, /status\.deepseek\.com\/incidents\//);
assert.deepEqual(both.sources, { board: 'ok', feed: 'ok' });

// Board unavailable: the incident channel alone still yields a usable headline.
const feedOnly = combine({ board: undefined, feed: entries, boardOk: false, feedOk: true, now: 1 });
assert.equal(feedOnly.headline, 'degraded', 'monitoring degrades the service');
assert.equal(feedOnly.services.length, 0, 'no per-service list without the board');
assert.equal(feedOnly.incidents.length, 1);
assert.deepEqual(feedOnly.sources, { board: 'failed', feed: 'ok' });

// Feed unavailable: the board still answers, and its incidents survive.
const boardOnly = combine({ board, feed: [], boardOk: true, feedOk: false, now: 1 });
assert.equal(boardOnly.headline, 'degraded');
assert.equal(boardOnly.incidents.length, 1);
assert.deepEqual(boardOnly.sources, { board: 'ok', feed: 'failed' });

// Nothing readable: say so instead of guessing.
const nothing = combine({ board: undefined, feed: [], boardOk: false, feedOk: false, now: 1 });
assert.equal(nothing.ok, false);
assert.equal(nothing.headline, 'unknown');
assert.deepEqual(nothing.incidents, []);
assert.deepEqual(nothing.services, []);

// A quiet feed means operational, not unknown.
assert.equal(combine({ board: undefined, feed: [], boardOk: false, feedOk: true, now: 1 }).headline, 'operational');

// Incident statuses map onto the four board severities.
assert.equal(headlineFromIncidents([]), 'operational');
assert.equal(headlineFromIncidents([{ type: 'incident', status: 'investigating' }]), 'partial_outage');
assert.equal(headlineFromIncidents([{ type: 'incident', status: 'identified' }]), 'partial_outage');
assert.equal(headlineFromIncidents([{ type: 'incident', status: 'monitoring' }]), 'degraded');
assert.equal(headlineFromIncidents([{ type: 'maintenance', status: 'in_progress' }]), 'maintenance');
assert.equal(headlineFromIncidents([{ type: 'maintenance', status: 'scheduled' }]), 'maintenance');

// Maintenance in the board path is reported as maintenance, not as an outage.
const maintenance = summarize({
  components,
  activeChanges: [{ type: 'maintenance', status: 'in_progress', title: 'x', affected_components: [] }],
  nowSeconds: 0,
});
assert.equal(maintenance.headline, 'maintenance');

// Unknown states never escalate an outage and never invent a service.
const dirty = summarize({
  components: [{ name: 'A' }, { name: '' }, null],
  activeChanges: [{ status: 'investigating', affected_components: [{ name: 'A', status: 'bogus' }] }],
  nowSeconds: 0,
});
assert.equal(dirty.headline, 'operational');
assert.deepEqual(dirty.services, [{ name: 'A', status: 'operational' }]);

// ---- Statuspage providers (OpenAI, Claude) --------------------------------
const openai = summarizeStatuspage(JSON.parse(read('openai.summary.json')));
assert.equal(openai.indicator, 'none');
assert.equal(openai.headline, 'operational');
assert.equal(openai.services.length, 25, 'every OpenAI component is carried');
assert.ok(openai.services.some((service) => /Chat Completions/.test(service.name)));
assert.ok(openai.services.every((service) => service.status === 'operational'));

const anthropic = summarizeStatuspage(JSON.parse(read('anthropic.summary.json')));
assert.equal(anthropic.headline, 'operational');
assert.equal(anthropic.services.length, 6);
assert.ok(anthropic.services.some((service) => /Claude API \(api\.anthropic\.com\)/.test(service.name)));

// The vocabulary maps onto this bundle's own, groups are dropped, and the page
// indicator is kept rather than recomputed.
const reduced = summarizeStatuspage({
  status: { indicator: 'major', description: 'Partial outage' },
  components: [
    { name: 'A', status: 'degraded_performance' },
    { name: 'B', status: 'major_outage' },
    { name: 'C', status: 'under_maintenance' },
    { name: 'Group', status: 'operational', group: true },
    { name: '', status: 'operational' },
  ],
  incidents: [{
    name: 'X',
    status: 'investigating',
    shortlink: 'https://stspg.io/x',
    updated_at: '2026-11-04T00:00:00Z',
    components: [{}, {}, {}],
  }],
  scheduled_maintenances: [{ name: 'M', status: 'in_progress' }],
});
assert.equal(reduced.headline, 'partial_outage');
assert.deepEqual(reduced.services.map((service) => [service.name, service.status]), [
  ['A', 'degraded'],
  ['B', 'full_outage'],
  ['C', 'maintenance'],
]);
assert.equal(reduced.incidents.length, 2, 'incidents and maintenances are both carried');
assert.equal(reduced.incidents[0].link, 'https://stspg.io/x');
assert.equal(reduced.incidents[0].affected, 3);
assert.equal(reduced.incidents[1].type, 'maintenance');

// A payload without an indicator says unknown instead of guessing.
assert.equal(summarizeStatuspage({}).headline, 'unknown');
assert.deepEqual(summarizeStatuspage({}).services, []);
assert.deepEqual(summarizeStatuspage(null).incidents, []);

// The aggregate is the worst readable provider; unknown never wins.
assert.equal(aggregateHeadline([]), 'unknown');
assert.equal(aggregateHeadline([{ headline: 'unknown' }]), 'unknown');
assert.equal(aggregateHeadline([{ headline: 'operational' }, { headline: 'unknown' }]), 'operational');
assert.equal(aggregateHeadline([{ headline: 'operational' }, { headline: 'full_outage' }]), 'full_outage');
assert.equal(
  aggregateHeadline([{ headline: 'degraded' }, { headline: 'partial_outage' }]),
  'partial_outage',
);

console.log('dsh-status host parse: OK');
