/**
 * Browser half of the DeepSeek API Status bundle.
 *
 * Draws one compact status pill in the far-right group of the conversation
 * header (`conversation.session.header.utilities`). Hovering (or focusing) the
 * pill opens a card that names every affected service, the healthy ones, the open
 * incidents, and where the data came from.
 *
 * The Host half owns both upstream reads and the parsing; this module only polls
 * the local route and renders. A failed poll never blanks the pill: it keeps the
 * last board and marks itself stale.
 */
window.__ModuleLoader__.load({
  id: '@local/dsh-status',
  factory(require) {
    const React = require('react');
    const h = React.createElement;
    const { useEffect, useState } = React;

    let panelSeq = 0;

    const NS = 'dsh-status';
    const SLOT = 'conversation.session.header.utilities';
    const ENTRY_ID = 'dsh-status';
    const ORDER = 5;
    const API = '/api/dsh-status/summary';
    const POLL_MS = 60000;

    const zh = {
      'brand': 'AI API',
      'status.operational': '正常',
      'status.degraded': '性能下降',
      'status.partial_outage': '部分中断',
      'status.full_outage': '中断',
      'status.maintenance': '维护中',
      'status.unknown': '未知',
      'status.loading': '读取中',
      'panel.title': 'AI API 服务状态',
      'panel.overall': '整体状态',
      'panel.detail.allHealthy': '{count} 项组件全部正常',
      'panel.detail.rest': '其余 {count} 项正常',
      'panel.detail.unavailable': '暂不可用',
      'panel.incidents': '进行中的事件',
      'panel.updated': '更新于 {value}',
      'panel.stale': '旧数据：本次刷新失败',
      'panel.currentModel': '当前模型 {value}',
      'panel.others': '其他 {value}',
      'panel.source': '来源 {value}',
      'panel.empty': '暂时读取不到状态页数据',
      'incident.investigating': '调查中',
      'incident.identified': '已定位',
      'incident.monitoring': '监控中',
      'incident.resolved': '已解决',
      'incident.scheduled': '已计划',
      'incident.in_progress': '进行中',
      'incident.completed': '已完成',
      'incident.cancelled': '已取消',
      'incident.canceled': '已取消',
      'incident.unknown': '处理中',
    };

    const en = {
      'brand': 'AI API',
      'status.operational': 'Operational',
      'status.degraded': 'Degraded',
      'status.partial_outage': 'Partial outage',
      'status.full_outage': 'Outage',
      'status.maintenance': 'Maintenance',
      'status.unknown': 'Unknown',
      'status.loading': 'Loading',
      'panel.title': 'AI API status',
      'panel.overall': 'Overall',
      'panel.detail.allHealthy': '{count} components operational',
      'panel.detail.rest': '{count} more operational',
      'panel.detail.unavailable': 'Unavailable',
      'panel.incidents': 'Open incidents',
      'panel.updated': 'Updated {value}',
      'panel.stale': 'Stale: the last refresh failed',
      'panel.currentModel': 'Model {value}',
      'panel.others': 'Others {value}',
      'panel.source': 'Source {value}',
      'panel.empty': 'The status pages could not be read yet',
      'incident.investigating': 'Investigating',
      'incident.identified': 'Identified',
      'incident.monitoring': 'Monitoring',
      'incident.resolved': 'Resolved',
      'incident.scheduled': 'Scheduled',
      'incident.in_progress': 'In progress',
      'incident.completed': 'Completed',
      'incident.cancelled': 'Canceled',
      'incident.canceled': 'Canceled',
      'incident.unknown': 'In progress',
    };

    const CSS = `
.dsd-status-anchor{position:relative;display:inline-flex;-webkit-app-region:no-drag}
.dsd-status-pill{display:inline-flex;align-items:center;gap:6px;box-sizing:border-box;height:24px;max-width:260px;padding:0 9px 0 8px;border:1px solid color-mix(in srgb, var(--dsd-health, var(--dsw-alias-border-l1)) 80%, var(--dsw-alias-border-l1));border-radius:999px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-tertiary);font-family:inherit;font-size:12px;font-weight:500;line-height:16px;white-space:nowrap;user-select:none;cursor:default;outline:none}
.dsd-status-pill:focus-visible{box-shadow:0 0 0 2px color-mix(in srgb, var(--dsd-health, var(--dsw-alias-brand-primary)) 45%, transparent)}
.dsd-status-dot{position:relative;flex:none;width:7px;height:7px;border-radius:50%;background:var(--dsd-health, var(--dsw-alias-state-idle-primary))}
.dsd-status-dot[data-tone="ok"]{background:var(--dsw-alias-state-success-primary)}
.dsd-status-dot[data-tone="warn"]{background:var(--dsw-alias-state-warn-primary)}
.dsd-status-dot[data-tone="error"]{background:var(--dsw-alias-state-error-primary)}
.dsd-status-dot[data-tone="unknown"]{background:var(--dsw-alias-state-idle-primary)}
.dsd-status-pill[data-live="1"] .dsd-status-dot{animation:dsd-status-pulse 1.8s ease-in-out infinite}
.dsd-status-pill[data-busy="1"] .dsd-status-dot{background:var(--dsw-alias-brand-primary);animation:dsd-status-pulse 1.4s ease-in-out infinite}
.dsd-status-brand{overflow:hidden;text-overflow:ellipsis;color:var(--dsw-alias-label-primary);font-weight:600}
.dsd-status-text{overflow:hidden;text-overflow:ellipsis}
.dsd-panel{display:none;position:absolute;top:calc(100% + 8px);right:-6px;z-index:70;box-sizing:border-box;width:352px;max-width:min(352px, calc(100vw - 32px));padding:12px 14px;border:1px solid color-mix(in srgb, var(--dsd-health, var(--dsw-alias-border-l2)) 40%, var(--dsw-alias-border-l2));border-radius:10px;background:var(--dsw-alias-bg-overlay);box-shadow:0 10px 28px rgba(0,0,0,.22);color:var(--dsw-alias-label-primary);font-family:inherit;font-size:12px;font-weight:400;line-height:18px;text-align:left;white-space:normal;user-select:text}
.dsd-status-anchor:hover .dsd-panel,.dsd-status-anchor:focus-within .dsd-panel{display:block}
.dsd-panel-head{display:flex;align-items:center;gap:8px;padding-bottom:8px;border-bottom:1px solid var(--dsw-alias-border-l1)}
.dsd-panel-title{flex:1;min-width:0;font-size:12px;font-weight:600;color:var(--dsw-alias-label-primary)}
.dsd-badge{flex:none;display:inline-flex;align-items:center;gap:6px;padding:0 8px;border:1px solid color-mix(in srgb, var(--dsd-health, var(--dsw-alias-border-l1)) 55%, transparent);border-radius:999px;font-size:11px;font-weight:600;line-height:18px;color:var(--dsd-health, var(--dsw-alias-label-tertiary));background:var(--dsw-alias-bg-layer-2)}
.dsd-provider{display:flex;align-items:center;gap:8px;margin-top:10px;padding:2px 0 5px;border-bottom:1px solid var(--dsw-alias-border-l1);min-width:0}
.dsd-provider-name{flex:1;min-width:0;font-weight:600;color:var(--dsw-alias-label-primary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dsd-provider-state{flex:none;font-size:11px;color:var(--dsw-alias-label-tertiary)}
.dsd-provider[data-tone="warn"] .dsd-provider-state{color:var(--dsw-alias-state-warn-primary)}
.dsd-provider[data-tone="error"] .dsd-provider-state{color:var(--dsw-alias-state-error-primary)}
.dsd-sub{padding-left:14px}
.dsd-sect{margin-top:10px;font-size:11px;font-weight:600;letter-spacing:.02em;color:var(--dsw-alias-label-tertiary)}
.dsd-row{display:flex;align-items:center;gap:8px;padding:3px 0;min-width:0}
.dsd-row-name{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dsd-row-state{flex:none;font-variant-numeric:tabular-nums}
.dsd-row[data-tone="warn"] .dsd-row-state{color:var(--dsw-alias-state-warn-primary)}
.dsd-row[data-tone="error"] .dsd-row-state{color:var(--dsw-alias-state-error-primary)}
.dsd-row[data-tone="ok"] .dsd-row-name{color:var(--dsw-alias-label-secondary)}
.dsd-row[data-tone="ok"] .dsd-row-state{color:var(--dsw-alias-label-tertiary)}
.dsd-quiet{padding:3px 0;color:var(--dsw-alias-label-secondary)}
.dsd-incident{padding:6px 0 0}
.dsd-incident-title{color:var(--dsw-alias-label-primary);font-weight:500}
.dsd-incident-state{color:var(--dsw-alias-label-tertiary)}
.dsd-incident-link{color:var(--dsw-alias-brand-primary);font-size:11px;word-break:break-all;user-select:text}
.dsd-model{margin-top:8px;font-size:11px;color:var(--dsw-alias-label-tertiary);word-break:break-all}
.dsd-others{margin-top:8px;padding-top:8px;border-top:1px solid var(--dsw-alias-border-l1);font-size:11px;color:var(--dsw-alias-label-tertiary)}
.dsd-foot{margin-top:10px;padding-top:8px;border-top:1px solid var(--dsw-alias-border-l1);font-size:11px;line-height:16px;color:var(--dsw-alias-label-tertiary)}
.dsd-warnline{color:var(--dsw-alias-state-warn-primary)}
@keyframes dsd-status-pulse{0%,100%{opacity:1;transform:scale(1)}50%{opacity:.45;transform:scale(.82)}}
@media (prefers-reduced-motion: reduce){.dsd-status-dot{animation:none}}
`;

    const TONE = {
      operational: 'ok',
      degraded: 'warn',
      maintenance: 'warn',
      partial_outage: 'error',
      full_outage: 'error',
      unknown: 'unknown',
    };

    const SEVERITY = { operational: 0, maintenance: 1, degraded: 2, partial_outage: 3, full_outage: 4 };

    const LABEL_KEY = {
      operational: 'status.operational',
      degraded: 'status.degraded',
      maintenance: 'status.maintenance',
      partial_outage: 'status.partial_outage',
      full_outage: 'status.full_outage',
      unknown: 'status.unknown',
    };

    /** Translate with `{name}` substitution; falls back to the key's tail. */
    function makeT(translate) {
      return (key, vars) => {
        let text = typeof translate === 'function'
          ? translate(key)
          : key.slice(key.lastIndexOf('.') + 1);
        if (typeof text !== 'string') text = key.slice(key.lastIndexOf('.') + 1);
        if (vars !== undefined) {
          for (const [name, value] of Object.entries(vars)) {
            text = text.split(`{${name}}`).join(String(value));
          }
        }
        return text;
      };
    }

    /** Split the board into what is broken (worst first) and what is fine. */
    function splitServices(services) {
      const affected = [];
      const healthy = [];
      for (const service of services) {
        if (!service || typeof service.name !== 'string') continue;
        if (service.status === 'operational') healthy.push(service);
        else affected.push(service);
      }
      affected.sort((left, right) => (SEVERITY[right.status] ?? 0) - (SEVERITY[left.status] ?? 0));
      return { affected, healthy };
    }

    /** Board unavailable: stand in for the missing count with the incident severity. */
    const HEADLINE_RATIO = {
      operational: 0,
      maintenance: 0.5,
      degraded: 0.5,
      partial_outage: 0.75,
      full_outage: 1,
    };

    function ratioForHeadline(headline) {
      return HEADLINE_RATIO[headline] ?? 0;
    }

    function serviceTone(status) {
      return TONE[status] ?? 'unknown';
    }

    /** Where the green-to-red ramp turns over: half of the board impaired. */
    const HEALTH_PIVOT = 0.5;

    /** How much of a service a given state costs. A full outage costs a whole one. */
    const HEALTH_WEIGHT = {
      operational: 0,
      maintenance: 0.5,
      degraded: 0.5,
      partial_outage: 1,
      full_outage: 1,
    };

    /**
     * Share of the board that is impaired: 0 is every service healthy, 1 is every
     * service down. A degraded service costs half an outage, so "all degraded" is
     * amber and only an actual full board outage reaches red.
     */
    function healthOf(services) {
      const list = (Array.isArray(services) ? services : [])
        .filter((service) => service && typeof service.name === 'string');
      const total = list.length;
      if (total === 0) return { total: 0, affected: 0, known: false, ratio: 0 };
      let impaired = 0;
      let affected = 0;
      for (const service of list) {
        const weight = HEALTH_WEIGHT[service.status];
        if (weight === undefined) {
          // An unfamiliar state is not silently healthy.
          affected += 1;
          impaired += 1;
          continue;
        }
        if (weight > 0) affected += 1;
        impaired += weight;
      }
      return { total, affected, known: true, ratio: Math.min(1, impaired / total) };
    }

    /**
     * Green at rest, amber at the pivot, red when nothing is left, on the host's
     * own state tokens so light and dark themes stay consistent.
     */
    function healthColor(ratio) {
      const value = Number.isFinite(ratio) ? Math.max(0, Math.min(1, ratio)) : 0;
      if (value <= HEALTH_PIVOT) {
        const percent = Math.round((value / HEALTH_PIVOT) * 100);
        return 'color-mix(in srgb, var(--dsw-alias-state-success-primary) '
          + `${100 - percent}%, var(--dsw-alias-state-warn-primary) ${percent}%)`;
      }
      const percent = Math.round(((value - HEALTH_PIVOT) / (1 - HEALTH_PIVOT)) * 100);
      return 'color-mix(in srgb, var(--dsw-alias-state-warn-primary) '
        + `${100 - percent}%, var(--dsw-alias-state-error-primary) ${percent}%)`;
    }

    function clockOf(epochMs) {
      if (typeof epochMs !== 'number' || !Number.isFinite(epochMs)) return '—';
      const when = new Date(epochMs);
      if (Number.isNaN(when.getTime())) return '—';
      return `${String(when.getHours()).padStart(2, '0')}:${String(when.getMinutes()).padStart(2, '0')}`;
    }

    /** The providers carried by a board, whatever shape the Host sent. */
    function providersOf(board) {
      if (board && Array.isArray(board.providers)) return board.providers;
      return [];
    }

    /**
     * Which status page belongs to the model the session is currently pointing at.
     *
     * The catalog identifies a selection as `provider` (the adapter group) plus the
     * provider-owned `model` id, and neither is guaranteed to be a bare vendor name,
     * so both are matched. An unrecognised selection returns null and the pill keeps
     * showing every provider.
     */
    function matchProviderId(selection) {
      if (!selection || typeof selection !== 'object') return null;
      const provider = typeof selection.provider === 'string' ? selection.provider : '';
      const model = typeof selection.model === 'string' ? selection.model : '';
      const haystack = `${provider} ${model}`.toLowerCase();
      if (haystack.trim() === '') return null;
      if (/claude|anthropic/.test(haystack)) return 'anthropic';
      if (/gpt|openai|chatgpt|codex|(^|[-_/ ])o\d/.test(haystack)) return 'openai';
      if (/deepseek/.test(haystack)) return 'deepseek';
      return null;
    }

    /** A provider's own impaired share, falling back to its headline when it has no list. */
    function providerRatio(provider) {
      const health = healthOf(provider && provider.services);
      return health.known ? health.ratio : ratioForHeadline(provider && provider.headline);
    }

    /** The plain-text fallback carried by aria-label, so the pill stays readable. */
    function tooltip(board, t, label) {
      const lines = [t('panel.title'), `${t('panel.overall')}：${label}`];
      for (const provider of providersOf(board)) {
        const { affected } = splitServices(Array.isArray(provider.services) ? provider.services : []);
        const state = t(LABEL_KEY[provider.headline] ?? 'status.unknown');
        lines.push('', `${provider.name} — ${state}`);
        for (const service of affected) {
          lines.push(`· ${service.name} — ${t(LABEL_KEY[service.status] ?? 'status.unknown')}`);
        }
      }
      for (const provider of providersOf(board)) {
        for (const incident of Array.isArray(provider.incidents) ? provider.incidents : []) {
          lines.push('', `· ${provider.name}：${incident.title}（${t(`incident.${incident.status}`)}）`);
        }
      }
      return lines.join('\n');
    }

    function StatusPanel(props) {
      const { board, t, loading, label, id, focus, model } = props;
      const all = loading ? [] : providersOf(board);
      const focused = focus === null || focus === undefined;
      const providers = focused ? all : all.filter((provider) => provider.id === focus);
      const others = focused ? [] : all.filter((provider) => provider.id !== focus);
      const tone = loading ? 'unknown' : TONE[board.headline] ?? 'unknown';

      const rows = [];
      for (const provider of providers) {
        const providerTone = provider.ok === false ? 'unknown' : TONE[provider.headline] ?? 'unknown';
        const services = Array.isArray(provider.services) ? provider.services : [];
        const { affected, healthy } = splitServices(services);
        const incidents = Array.isArray(provider.incidents) ? provider.incidents : [];

        rows.push(h('div', {
          className: 'dsd-provider',
          'data-tone': providerTone,
          key: `p:${provider.id}`,
        },
          h('span', { className: 'dsd-status-dot', 'data-tone': providerTone, 'aria-hidden': 'true' }),
          h('span', { className: 'dsd-provider-name' }, provider.name),
          h('span', { className: 'dsd-provider-state' },
            provider.ok === false
              ? t('panel.detail.unavailable')
              : t(LABEL_KEY[provider.headline] ?? 'status.unknown')),
        ));

        for (const service of affected) {
          const rowTone = serviceTone(service.status);
          rows.push(h('div', { className: 'dsd-sub', 'data-tone': rowTone, key: `a:${provider.id}:${service.name}` },
            h('span', { className: 'dsd-status-dot', 'data-tone': rowTone, 'aria-hidden': 'true' }),
            h('span', { className: 'dsd-row-name', title: service.name }, service.name),
            h('span', { className: 'dsd-row-state' }, t(LABEL_KEY[service.status] ?? 'status.unknown')),
          ));
        }

        if (services.length > 0 && affected.length === 0) {
          rows.push(h('div', { className: 'dsd-quiet dsd-sub', key: `q:${provider.id}` },
            t('panel.detail.allHealthy', { count: healthy.length })));
        } else if (affected.length > 0) {
          rows.push(h('div', { className: 'dsd-quiet dsd-sub', key: `r:${provider.id}` },
            t('panel.detail.rest', { count: healthy.length })));
        } else if (provider.ok === false) {
          rows.push(h('div', { className: 'dsd-quiet dsd-sub', key: `e:${provider.id}` },
            provider.error ? String(provider.error).slice(0, 80) : t('panel.detail.unavailable')));
        }

        if (incidents.length > 0) {
          for (const incident of incidents) {
            rows.push(h('div', { className: 'dsd-incident dsd-sub', key: `i:${provider.id}:${incident.title}` },
              h('div', { className: 'dsd-incident-title' }, incident.title),
              h('div', { className: 'dsd-incident-state' }, t(`incident.${incident.status}`)),
              typeof incident.link === 'string' && incident.link !== ''
                ? h('div', { className: 'dsd-incident-link' }, incident.link)
                : null,
            ));
          }
        }
      }

      if (loading || providers.length === 0) {
        rows.push(h('div', { className: 'dsd-quiet', key: 'empty' },
          loading ? t('status.loading') : t('panel.empty')));
      }

      const sources = providers
        .map((provider) => provider.source)
        .filter((source) => typeof source === 'string' && source !== '');

      return h('div', { className: 'dsd-panel', id, role: 'tooltip' },
        h('div', { className: 'dsd-panel-head' },
          h('span', { className: 'dsd-panel-title' }, t('panel.title')),
          h('span', { className: 'dsd-badge', 'data-tone': tone }, loading ? t('status.loading') : label),
        ),
        ...(typeof model === 'string' && model !== ''
          ? [h('div', { className: 'dsd-model', key: 'model' }, t('panel.currentModel', { value: model }))]
          : []),
        ...rows,
        ...(others.length > 0
          ? [h('div', { className: 'dsd-others', key: 'others' },
            t('panel.others', {
              value: others
                .map((provider) => `${provider.name} ${provider.ok === false
                  ? t('panel.detail.unavailable')
                  : t(LABEL_KEY[provider.headline] ?? 'status.unknown')}`)
                .join(' · '),
            }))]
          : []),
        h('div', { className: 'dsd-foot' },
          providers.some((provider) => provider.stale === true)
            ? h('div', { className: 'dsd-warnline' }, t('panel.stale'))
            : null,
          h('div', null, t('panel.updated', { value: clockOf(board && board.fetchedAt) })),
          h('div', null, t('panel.source', { value: sources.join(' · ') })),
        ),
      );
    }

    function StatusPill(props) {
      const t = makeT(props.t);
      const [board, setBoard] = useState(null);
      const [selection, setSelection] = useState(null);
      const [panelId] = useState(() => {
        panelSeq += 1;
        return `dsd-panel-${panelSeq}`;
      });

      // Follow the model this session is pointed at: the model catalog service keeps
      // one directory per session, and its store publishes the current selection.
      const directories = props.models;
      const sessionId = props.sessionId;
      useEffect(() => {
        if (directories === undefined || directories === null) return undefined;
        if (typeof directories.directoryFor !== 'function') return undefined;
        if (typeof sessionId !== 'string' || sessionId === '') return undefined;
        let directory;
        try {
          directory = directories.directoryFor(sessionId);
        } catch {
          return undefined;
        }
        const store = directory && directory.store;
        if (!store || typeof store.subscribe !== 'function' || typeof store.getSnapshot !== 'function') return undefined;
        const read = () => {
          try {
            const snapshot = store.getSnapshot();
            return snapshot && snapshot.current ? snapshot.current : null;
          } catch {
            return null;
          }
        };
        setSelection(read());
        const unsubscribe = store.subscribe(() => setSelection(read()));
        try {
          const loading = directory.load();
          if (loading && typeof loading.catch === 'function') loading.catch(() => undefined);
        } catch {
          /* the projected selection still arrives through the store */
        }
        return () => {
          if (typeof unsubscribe === 'function') unsubscribe();
        };
      }, [directories, sessionId]);

      useEffect(() => {
        let stopped = false;
        let timer;
        const load = async () => {
          try {
            const response = await fetch(API, { cache: 'no-store', headers: { accept: 'application/json' } });
            const body = await response.json();
            if (stopped) return;
            if (body && typeof body.headline === 'string') setBoard(body);
            else setBoard((previous) => (previous === null
              ? { headline: 'unknown', services: [], incidents: [] }
              : { ...previous, stale: true }));
          } catch {
            if (stopped) return;
            setBoard((previous) => (previous === null
              ? { headline: 'unknown', services: [], incidents: [] }
              : { ...previous, stale: true }));
          } finally {
            if (!stopped) timer = setTimeout(load, POLL_MS);
          }
        };
        load();
        return () => {
          stopped = true;
          clearTimeout(timer);
        };
      }, []);

      const loading = board === null;
      const providers = loading ? [] : providersOf(board);
      // The model decides which status page the pill reports; an unrecognised model
      // falls back to showing every provider rather than guessing wrong.
      const matched = loading ? null : matchProviderId(selection);
      const focused = matched === null ? [] : providers.filter((provider) => provider.id === matched);
      const focus = focused.length > 0 ? matched : null;
      const view = focus === null ? providers : focused;

      const headline = focus === null
        ? (loading ? 'unknown' : (LABEL_KEY[board.headline] ? board.headline : 'unknown'))
        : (LABEL_KEY[focused[0].headline] ? focused[0].headline : 'unknown');
      const tone = loading ? 'unknown' : TONE[headline];
      const label = t(loading ? 'status.loading' : LABEL_KEY[headline]);
      const brand = focus === null ? t('brand') : focused[0].name;
      // One provider down is as bad as the pill gets: the colour takes the worst
      // share in view, so a red dot always means "something is fully down".
      const worst = view.reduce(
        (current, provider) => Math.max(current, providerRatio(provider)),
        0,
      );
      const affected = view.reduce(
        (total, provider) => total + healthOf(provider.services).affected,
        0,
      );
      const neutral = loading || headline === 'unknown';
      const ratio = view.length > 0 ? worst : ratioForHeadline(headline);
      const modelLabel = selection === null
        ? ''
        : [selection.provider, selection.model].filter((part) => typeof part === 'string' && part !== '').join(' · ');
      // The custom property is read by the pill border, its dot, the badge and the
      // card edge, so one number colours the whole object.
      const healthStyle = {
        '--dsd-health': neutral ? 'var(--dsw-alias-state-idle-primary)' : healthColor(ratio),
      };

      // The card is always in the tree and revealed by `:hover`/`:focus-within`,
      // so it needs no pointer state of its own and can never be left open.
      return h('div',
        { className: 'dsd-status-anchor', style: healthStyle },
        h('span',
          {
            className: 'dsd-status-pill',
            'data-tone': tone,
            'data-live': !loading && affected > 0 ? '1' : undefined,
            'data-busy': loading ? '1' : undefined,
            role: 'status',
            tabIndex: 0,
            'aria-live': 'polite',
            'aria-label': loading ? `${brand} · ${label}` : tooltip(board, t, label),
            'aria-describedby': panelId,
          },
          h('span', { className: 'dsd-status-dot', 'aria-hidden': 'true' }),
          h('span', { className: 'dsd-status-brand', 'aria-hidden': 'true' }, brand),
          h('span', { className: 'dsd-status-text' }, label),
        ),
        h(StatusPanel, {
          board: board ?? { headline: 'unknown', providers: [] },
          t,
          loading,
          label,
          id: panelId,
          focus,
          model: modelLabel,
        }),
      );
    }

    const inject = ['slots', 'locale'];

    function apply(ctx) {
      // Follow the session's model when the catalog service is present; when it is
      // not, the pill simply keeps showing every provider.
      let modelDirectories;
      ctx.inject(['modelDirectories'], (scope) => {
        modelDirectories = scope.modelDirectories;
        return () => {
          modelDirectories = undefined;
        };
      });

      function BoundPill(props) {
        return h(StatusPill, { ...props, models: modelDirectories });
      }

      ctx.effect(() => {
        const disposers = [];
        try {
          disposers.push(ctx.locale.register(NS, 'zh', zh));
          disposers.push(ctx.locale.register(NS, 'en', en));
        } catch (error) {
          console.warn('[dsh-status] locale registration failed:', error);
        }
        return () => {
          for (const dispose of disposers.splice(0)) {
            try {
              dispose();
            } catch {
              /* already disposed */
            }
          }
        };
      }, 'dsh-status: dictionaries');

      const translate = ctx.locale.bind(NS);

      ctx.effect(() => {
        const tag = document.createElement('style');
        tag.dataset.plugin = '@local/dsh-status';
        tag.textContent = CSS;
        document.head.appendChild(tag);
        return () => {
          tag.remove();
        };
      }, 'dsh-status: styles');

      ctx.effect(
        () => ctx.slots.inject(SLOT, () => ctx.slots.register({
          name: SLOT,
          id: ENTRY_ID,
          order: ORDER,
          locale: NS,
          label: () => translate('brand'),
        }, BoundPill)),
        'dsh-status: pill',
      );
    }

    return {
      inject,
      apply,
      TONE,
      LABEL_KEY,
      HEALTH_PIVOT,
      healthOf,
      healthColor,
      ratioForHeadline,
      providersOf,
      providerRatio,
      matchProviderId,
      splitServices,
      serviceTone,
      clockOf,
      tooltip,
      makeT,
      StatusPanel,
      StatusPill,
    };
  },
});
