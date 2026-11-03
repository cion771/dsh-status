/**
 * Host half of the DeepSeek API Status bundle.
 *
 * Two public sources, because neither one alone answers "is the DeepSeek API
 * healthy right now?":
 *
 *   feed.atom  — the incident channel. Small, stable XML; every change carries its
 *                lifecycle status (investigating / monitoring / resolved …), the
 *                affected component names, and a permalink.
 *   the page   — the component board. A Flashcat Next.js page whose board exists
 *                only as an RSC flight payload inside the SSR HTML; this is the
 *                only place a per-component current status (degraded, partial
 *                outage …) is published.
 *
 * The board decides the headline when it is readable, the feed takes over when it
 * is not, and the feed is always the authority on which incidents are still open.
 * An unreachable or unparsable pair reports `unknown` instead of inventing a
 * status.
 */

export const name = 'dsh-deepseek-status';
export const inject = ['webServer'];

const ROUTE = '/api/dsh-deepseek-status/summary';
const PAGE = 'https://status.deepseek.com/';
const FEED = 'https://status.deepseek.com/feed.atom';
const USER_AGENT = 'Mozilla/5.0 (compatible; dsh-deepseek-status/2)';
const FETCH_TIMEOUT_MS = 9000;
const PAGE_TTL_MS = 120000;
const FEED_TTL_MS = 60000;
const SNAPSHOT_TTL_MS = 30000;
const STALE_MS = 10 * 60000;

/** Severity order used to fold several component states into one headline. */
const SEVERITY = {
  operational: 0,
  maintenance: 1,
  degraded: 2,
  partial_outage: 3,
  full_outage: 4,
};

/** Statuses the board can report for a single component. */
const COMPONENT_STATES = new Set(Object.keys(SEVERITY));

/** Incident statuses that mean the change is over. */
const CLOSED_STATUSES = new Set(['resolved', 'completed', 'cancelled', 'canceled']);

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

function sendJson(res, status, body) {
  const text = JSON.stringify(body);
  res.statusCode = status;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.setHeader('cache-control', 'no-store');
  res.end(text);
}

function decodeEntities(text) {
  return String(text).replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (match, body) => {
    if (body[0] === '#') {
      const hex = body[1] === 'x' || body[1] === 'X';
      const code = Number.parseInt(hex ? body.slice(2) : body.slice(1), hex ? 16 : 10);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : match;
    }
    return ENTITIES[body.toLowerCase()] ?? match;
  });
}

/**
 * Concatenate every `self.__next_f.push([1,"…"])` string of a Next.js page.
 *
 * The flight payload is a stream of string literals; each is decoded literally so
 * `\"` and `\n` inside it become the characters the server meant.
 */
export function rscPayload(html) {
  const marker = 'self.__next_f.push([1,';
  let out = '';
  let from = 0;
  for (;;) {
    const at = html.indexOf(marker, from);
    if (at < 0) break;
    const start = at + marker.length;
    if (html[start] !== '"') {
      from = start;
      continue;
    }
    let end = start + 1;
    let escaped = false;
    for (; end < html.length; end += 1) {
      const ch = html[end];
      if (escaped) {
        escaped = false;
        continue;
      }
      if (ch === '\\') {
        escaped = true;
        continue;
      }
      if (ch === '"') break;
    }
    try {
      out += JSON.parse(html.slice(start, end + 1));
    } catch {
      /* an undecodable segment contributes nothing */
    }
    from = end + 1;
  }
  return out;
}

/**
 * Read one JSON array or object out of the payload by balanced scanning.
 *
 * The same key also appears in the page's message dictionary as a plain string
 * (`"components":"{count} components"`), so only the bracket form is accepted.
 */
export function readJsonValue(payload, key) {
  for (const opener of ['[', '{']) {
    const at = payload.indexOf(`"${key}":${opener}`);
    if (at < 0) continue;
    const start = at + key.length + 3;
    const closer = opener === '[' ? ']' : '}';
    let depth = 0;
    let escaped = false;
    let inString = false;
    for (let i = start; i < payload.length; i += 1) {
      const ch = payload[i];
      if (inString) {
        if (escaped) escaped = false;
        else if (ch === '\\') escaped = true;
        else if (ch === '"') inString = false;
        continue;
      }
      if (ch === '"') inString = true;
      else if (ch === opener) depth += 1;
      else if (ch === closer) {
        depth -= 1;
        if (depth === 0) {
          try {
            return JSON.parse(payload.slice(start, i + 1));
          } catch {
            return undefined;
          }
        }
      }
    }
  }
  return undefined;
}

export function worstStatus(statuses) {
  let worst = 'operational';
  for (const status of statuses) {
    if (!COMPONENT_STATES.has(status)) continue;
    if (SEVERITY[status] > SEVERITY[worst]) worst = status;
  }
  return worst;
}

/**
 * Parse the Atom feed into one record per change.
 *
 * Each entry repeats the change's latest lifecycle status, so entries are not a
 * history of updates but one row per change, newest first.
 */
export function parseFeed(xml) {
  const entries = [];
  const block = /<entry>([\s\S]*?)<\/entry>/g;
  let match;
  while ((match = block.exec(xml)) !== null) {
    const body = match[1];
    const pick = (tag) => {
      const found = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`).exec(body);
      return found === null ? '' : decodeEntities(found[1]).trim();
    };
    const link = (/<link[^>]*href="([^"]+)"/.exec(body) ?? [])[1] ?? '';
    const summaryMatch = /<summary[^>]*>([\s\S]*?)<\/summary>/.exec(body);
    const summary = summaryMatch === null ? '' : decodeEntities(summaryMatch[1]);
    const status = (/Status:<\/strong>\s*([a-z_]+)/i.exec(summary) ?? [])[1] ?? 'unknown';
    const affectedText = (/Affected components:<\/strong>([\s\S]*?)<\/p>/i.exec(summary) ?? [])[1] ?? '';
    const components = affectedText
      .split(',')
      .map((name) => name.trim())
      .filter((name) => name !== '');
    const id = pick('id');
    entries.push({
      changeId: (/change:(\d+)/.exec(id) ?? [])[1] ?? id,
      title: pick('title'),
      status: status.toLowerCase(),
      link,
      type: /\/maintenances?\//.test(link) ? 'maintenance' : 'incident',
      updatedAt: Date.parse(pick('updated')) || null,
      components,
    });
  }
  return entries;
}

/** Fold the parsed component board into the compact shape the pill renders. */
export function summarize({ components, activeChanges, nowSeconds }) {
  const incidents = [];
  const byName = new Map();

  for (const change of activeChanges) {
    if (!change || typeof change !== 'object') continue;
    const affected = Array.isArray(change.affected_components) ? change.affected_components : [];
    const statuses = [];
    for (const component of affected) {
      const status = COMPONENT_STATES.has(component?.status) ? component.status : 'operational';
      statuses.push(status);
      const name = typeof component?.name === 'string' ? component.name : '';
      if (name === '') continue;
      const previous = byName.get(name);
      if (previous === undefined || SEVERITY[status] > SEVERITY[previous]) byName.set(name, status);
    }
    incidents.push({
      type: change.type === 'maintenance' ? 'maintenance' : 'incident',
      status: typeof change.status === 'string' ? change.status : 'unknown',
      title: typeof change.title === 'string' ? change.title : '',
      sinceSeconds: Number.isFinite(change.start_at_seconds) ? change.start_at_seconds : null,
      affected: statuses.length,
    });
  }

  const services = [];
  for (const component of components) {
    const name = typeof component?.name === 'string' ? component.name : '';
    if (name === '') continue;
    services.push({ name, status: byName.get(name) ?? 'operational' });
  }

  let headline = worstStatus([...byName.values()]);
  const maintenance = incidents.some(
    (incident) => incident.type === 'maintenance'
      && (incident.status === 'in_progress' || incident.status === 'scheduled'),
  );
  if (maintenance && SEVERITY[headline] < SEVERITY.maintenance) headline = 'maintenance';

  return { headline, services, incidents, nowSeconds };
}

/** Only the entries that have not been closed yet, newest first. */
export function openIncidents(entries) {
  return entries.filter((entry) => !CLOSED_STATUSES.has(entry.status) && entry.title !== '');
}

/**
 * Headline derived from the incident channel alone: the board is unavailable, so
 * the worst open change stands in for the component states it would have shown.
 */
export function headlineFromIncidents(incidents) {
  let headline = 'operational';
  for (const incident of incidents) {
    let next = 'operational';
    if (incident.type === 'maintenance') next = 'maintenance';
    else if (incident.status === 'investigating' || incident.status === 'identified') next = 'partial_outage';
    else if (incident.status !== 'unknown') next = 'degraded';
    if (SEVERITY[next] > SEVERITY[headline]) headline = next;
  }
  return headline;
}

/**
 * Combine both sources into one snapshot.
 *
 * `board` wins the headline and the per-component list because it is the only
 * source that publishes them; `feed` wins the incident list because it is the
 * lifecycle authority and covers changes the page may already have rotated out.
 */
export function combine({ board, feed, boardOk, feedOk, now }) {
  const open = feedOk ? openIncidents(feed) : [];
  const incidents = feedOk
    ? open.map((entry) => ({
      type: entry.type,
      status: entry.status,
      title: entry.title,
      link: entry.link,
      updatedAt: entry.updatedAt,
      affected: entry.components.length,
    }))
    : (board?.incidents ?? []).map((incident) => ({ ...incident, link: '', updatedAt: null }));

  const headline = boardOk && board !== undefined
    ? board.headline
    : feedOk ? headlineFromIncidents(open) : 'unknown';

  return {
    ok: boardOk || feedOk,
    headline,
    services: boardOk && board !== undefined ? board.services : [],
    incidents,
    sources: { board: boardOk ? 'ok' : 'failed', feed: feedOk ? 'ok' : 'failed' },
    fetchedAt: now,
  };
}

async function getText(url, accept) {
  const response = await fetch(url, {
    headers: { 'user-agent': USER_AGENT, accept, 'accept-language': 'en' },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    redirect: 'follow',
  });
  if (!response.ok) throw new Error(`${url} answered ${response.status}`);
  return response.text();
}

async function fetchBoard() {
  const html = await getText(PAGE, 'text/html,application/xhtml+xml');
  const payload = rscPayload(html);
  if (payload === '') throw new Error('status page carried no flight payload');
  const components = readJsonValue(payload, 'components');
  const activeChanges = readJsonValue(payload, 'active_changes');
  if (!Array.isArray(activeChanges)) throw new Error('status page carried no active_changes');
  return summarize({
    components: Array.isArray(components) ? components : [],
    activeChanges,
    nowSeconds: Math.floor(Date.now() / 1000),
  });
}

async function fetchFeed() {
  return parseFeed(await getText(FEED, 'application/atom+xml,application/xml,text/xml'));
}

export function apply(ctx) {
  const state = {
    board: { at: 0, value: undefined, error: undefined },
    feed: { at: 0, value: undefined, error: undefined },
    snapshot: { at: 0, value: undefined },
    inflight: undefined,
  };

  async function refresh() {
    const now = Date.now();
    if (state.snapshot.value !== undefined && now - state.snapshot.at < SNAPSHOT_TTL_MS) return state.snapshot.value;
    if (state.inflight !== undefined) return state.inflight;

    state.inflight = (async () => {
      const jobs = [];
      if (state.board.value === undefined || now - state.board.at > PAGE_TTL_MS) {
        jobs.push(fetchBoard().then(
          (value) => {
            state.board = { at: Date.now(), value, error: undefined };
          },
          (error) => {
            const message = String(error && error.message ? error.message : error);
            state.board = { ...state.board, error: message };
            ctx.logger?.warn?.(`[deepseek-status] board: ${message}`);
          },
        ));
      }
      if (state.feed.value === undefined || now - state.feed.at > FEED_TTL_MS) {
        jobs.push(fetchFeed().then(
          (value) => {
            state.feed = { at: Date.now(), value, error: undefined };
          },
          (error) => {
            const message = String(error && error.message ? error.message : error);
            state.feed = { ...state.feed, error: message };
            ctx.logger?.warn?.(`[deepseek-status] feed: ${message}`);
          },
        ));
      }
      await Promise.all(jobs);

      const boardFresh = state.board.value !== undefined && Date.now() - state.board.at < STALE_MS;
      const feedFresh = state.feed.value !== undefined && Date.now() - state.feed.at < STALE_MS;
      const snapshot = combine({
        board: boardFresh ? state.board.value : undefined,
        feed: feedFresh ? state.feed.value : [],
        boardOk: boardFresh,
        feedOk: feedFresh,
        now: Date.now(),
      });
      snapshot.stale = !boardFresh || !feedFresh;
      snapshot.errors = [state.board.error, state.feed.error].filter((error) => typeof error === 'string');
      snapshot.source = PAGE;
      state.snapshot = { at: Date.now(), value: snapshot };
      return snapshot;
    })();

    try {
      return await state.inflight;
    } finally {
      state.inflight = undefined;
    }
  }

  const handler = async (req, res) => {
    try {
      sendJson(res, 200, await refresh());
    } catch (error) {
      sendJson(res, 500, { ok: false, headline: 'unknown', error: String(error && error.message ? error.message : error) });
    }
  };

  ctx.effect(() => ctx.webServer.register({ kind: 'exact', path: ROUTE, handler }), 'deepseek-status: route');

  // Warm both sources so the first pill render does not wait for the network.
  ctx.effect(() => {
    const timer = setTimeout(() => {
      refresh().catch(() => undefined);
    }, 1500);
    return () => clearTimeout(timer);
  }, 'deepseek-status: warm-up');
}
