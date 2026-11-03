/**
 * Host half of the AI API Status bundle.
 *
 * Three providers, two very different upstream shapes:
 *
 *   DeepSeek — a Flashcat status board. The board exists only as an RSC flight
 *              payload inside the SSR HTML, and no public JSON endpoint exposes it;
 *              feed.atom carries the incident channel. Both are read and merged.
 *   OpenAI, Claude — Atlassian Statuspage instances. One public
 *              `/api/v2/summary.json` already carries the indicator, every
 *              component's status, and the open incidents, so it is read directly.
 *
 * Each provider is fetched and cached on its own TTL; one provider failing never
 * blanks the others. The route publishes every provider plus the worst headline;
 * an unparsable or unreachable provider says so instead of inventing a status.
 */

export const name = 'dsh-status';
export const inject = ['webServer'];

const ROUTE = '/api/dsh-status/summary';
const DEEPSEEK_PAGE = 'https://status.deepseek.com/';
const DEEPSEEK_FEED = 'https://status.deepseek.com/feed.atom';
const OPENAI_SUMMARY = 'https://status.openai.com/api/v2/summary.json';
const ANTHROPIC_SUMMARY = 'https://status.anthropic.com/api/v2/summary.json';

const USER_AGENT = 'Mozilla/5.0 (compatible; dsh-status/2.4)';
const FETCH_TIMEOUT_MS = 9000;
const PAGE_TTL_MS = 120000;
const FEED_TTL_MS = 60000;
const STATUSPAGE_TTL_MS = 60000;
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

/** Statuspage component status → this bundle's vocabulary. */
const STATUSPAGE_COMPONENT = {
  operational: 'operational',
  degraded_performance: 'degraded',
  partial_outage: 'partial_outage',
  major_outage: 'full_outage',
  under_maintenance: 'maintenance',
};

/** Statuspage page indicator → this bundle's headline. */
const STATUSPAGE_INDICATOR = {
  none: 'operational',
  minor: 'degraded',
  major: 'partial_outage',
  critical: 'full_outage',
  maintenance: 'maintenance',
};

const PROVIDERS = [
  {
    id: 'deepseek',
    name: 'DeepSeek',
    kind: 'board',
    page: DEEPSEEK_PAGE,
    feed: DEEPSEEK_FEED,
    pageTtl: PAGE_TTL_MS,
    feedTtl: FEED_TTL_MS,
    source: DEEPSEEK_PAGE,
  },
  {
    id: 'openai',
    name: 'GPT',
    kind: 'statuspage',
    url: OPENAI_SUMMARY,
    ttl: STATUSPAGE_TTL_MS,
    source: 'https://status.openai.com',
  },
  {
    id: 'anthropic',
    name: 'Claude',
    kind: 'statuspage',
    url: ANTHROPIC_SUMMARY,
    ttl: STATUSPAGE_TTL_MS,
    source: 'https://status.anthropic.com',
  },
];

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

/** Fold the parsed DeepSeek component board into the compact shape the pill renders. */
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
 * Combine both DeepSeek sources into one provider snapshot.
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

/**
 * Normalise a Statuspage `/api/v2/summary.json` payload into this bundle's shape.
 *
 * The indicator already is the page's own worst-state answer, so it is kept as the
 * headline rather than recomputed from the components.
 */
export function summarizeStatuspage(json) {
  const indicator = typeof json?.status?.indicator === 'string' ? json.status.indicator : 'unknown';
  const headline = STATUSPAGE_INDICATOR[indicator] ?? 'unknown';
  const components = Array.isArray(json?.components) ? json.components : [];
  const services = [];
  for (const component of components) {
    if (!component || component.group === true) continue;
    const name = typeof component.name === 'string' ? component.name : '';
    if (name === '') continue;
    services.push({ name, status: STATUSPAGE_COMPONENT[component.status] ?? 'unknown' });
  }
  const incidents = (Array.isArray(json?.incidents) ? json.incidents : [])
    .filter((incident) => incident && typeof incident.name === 'string')
    .map((incident) => ({
      type: 'incident',
      status: typeof incident.status === 'string' ? incident.status : 'unknown',
      title: incident.name,
      link: typeof incident.shortlink === 'string' ? incident.shortlink : '',
      updatedAt: Date.parse(incident.updated_at) || null,
      affected: Array.isArray(incident.components) ? incident.components.length : 0,
    }));
  const maintenances = (Array.isArray(json?.scheduled_maintenances) ? json.scheduled_maintenances : [])
    .filter((entry) => entry && typeof entry.name === 'string')
    .map((entry) => ({
      type: 'maintenance',
      status: typeof entry.status === 'string' ? entry.status : 'scheduled',
      title: entry.name,
      link: typeof entry.shortlink === 'string' ? entry.shortlink : '',
      updatedAt: Date.parse(entry.updated_at) || null,
      affected: Array.isArray(entry.components) ? entry.components.length : 0,
    }));
  return {
    headline,
    services,
    incidents: [...incidents, ...maintenances],
    indicator,
  };
}

/** The worst headline across providers, unknown only when nothing is readable. */
export function aggregateHeadline(providers) {
  const known = providers.filter((provider) => provider.headline !== 'unknown');
  if (known.length === 0) return 'unknown';
  return worstStatus(known.map((provider) => provider.headline));
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

async function fetchDeepSeek() {
  const [pageResult, feedResult] = await Promise.allSettled([
    getText(DEEPSEEK_PAGE, 'text/html,application/xhtml+xml'),
    getText(DEEPSEEK_FEED, 'application/atom+xml,application/xml,text/xml'),
  ]);

  let board;
  let boardError;
  if (pageResult.status === 'fulfilled') {
    try {
      const payload = rscPayload(pageResult.value);
      if (payload === '') throw new Error('status page carried no flight payload');
      const components = readJsonValue(payload, 'components');
      const activeChanges = readJsonValue(payload, 'active_changes');
      if (!Array.isArray(activeChanges)) throw new Error('status page carried no active_changes');
      board = summarize({
        components: Array.isArray(components) ? components : [],
        activeChanges,
        nowSeconds: Math.floor(Date.now() / 1000),
      });
    } catch (error) {
      boardError = String(error && error.message ? error.message : error);
    }
  } else {
    boardError = String(pageResult.reason && pageResult.reason.message ? pageResult.reason.message : pageResult.reason);
  }

  let feed;
  let feedError;
  if (feedResult.status === 'fulfilled') {
    feed = parseFeed(feedResult.value);
  } else {
    feedError = String(feedResult.reason && feedResult.reason.message ? feedResult.reason.message : feedResult.reason);
  }

  const boardOk = board !== undefined;
  const feedOk = Array.isArray(feed);
  const merged = combine({ board, feed: feedOk ? feed : [], boardOk, feedOk, now: Date.now() });
  return {
    ...merged,
    stale: !boardOk || !feedOk,
    errors: [boardError, feedError].filter((error) => typeof error === 'string'),
  };
}

export function apply(ctx) {
  let snapshot = { at: 0, value: undefined };
  let inflight;
  /** provider id → { at, value, error } */
  const cache = new Map();

  async function loadProvider(provider) {
    const now = Date.now();
    const state = cache.get(provider.id) ?? { at: 0, value: undefined, error: undefined };
    const ttl = provider.kind === 'board' ? Math.min(provider.pageTtl, provider.feedTtl) : provider.ttl;
    if (state.value === undefined || now - state.at > ttl) {
      try {
        const value = provider.kind === 'board'
          ? await fetchDeepSeek()
          : summarizeStatuspage(JSON.parse(await getText(provider.url, 'application/json')));
        const next = { at: Date.now(), value, error: undefined };
        cache.set(provider.id, next);
        return next;
      } catch (error) {
        const message = String(error && error.message ? error.message : error);
        const next = { at: state.at, value: state.value, error: message };
        cache.set(provider.id, next);
        ctx.logger?.warn?.(`[dsh-status] ${provider.id}: ${message}`);
        return next;
      }
    }
    return state;
  }

  async function refresh() {
    const now = Date.now();
    if (snapshot.value !== undefined && now - snapshot.at < SNAPSHOT_TTL_MS) return snapshot.value;
    if (inflight !== undefined) return inflight;

    inflight = (async () => {
      const states = await Promise.all(PROVIDERS.map(async (provider) => ({
        provider,
        state: await loadProvider(provider),
      })));

      const providers = states.map(({ provider, state }) => {
        const fresh = state.value !== undefined && Date.now() - state.at < STALE_MS;
        return {
          id: provider.id,
          name: provider.name,
          source: provider.source,
          ok: fresh,
          stale: !fresh,
          headline: fresh ? state.value.headline : 'unknown',
          services: fresh ? state.value.services : [],
          incidents: fresh ? state.value.incidents : [],
          fetchedAt: state.at,
          error: state.error,
        };
      });

      const value = {
        ok: providers.some((provider) => provider.ok),
        headline: aggregateHeadline(providers),
        providers,
        fetchedAt: Date.now(),
      };
      snapshot = { at: Date.now(), value };
      return value;
    })();

    try {
      return await inflight;
    } finally {
      inflight = undefined;
    }
  }

  const handler = async (req, res) => {
    try {
      sendJson(res, 200, await refresh());
    } catch (error) {
      sendJson(res, 500, { ok: false, headline: 'unknown', providers: [], error: String(error && error.message ? error.message : error) });
    }
  };

  ctx.effect(() => ctx.webServer.register({ kind: 'exact', path: ROUTE, handler }), 'dsh-status: route');

  // Warm every source so the first pill render does not wait for the network.
  ctx.effect(() => {
    const timer = setTimeout(() => {
      refresh().catch(() => undefined);
    }, 1500);
    return () => clearTimeout(timer);
  }, 'dsh-status: warm-up');
}
