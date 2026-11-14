import { useMemo, useState } from 'react';
import type { PanelHost } from '@nimbalyst/extension-sdk';
import { DashboardFrame } from './Dashboard';
import { ScoreBar, total } from './score';
import type { CalEvent, Model, Scan, Trend, TrendIdea } from './types';

const KIND: Record<string, string> = { trend: 'Trend', similar: 'Similar model', season: 'Season' };
const day = (iso?: string | null) => (iso ? new Date(`${iso.slice(0, 10)}T12:00:00`).toLocaleDateString([], { month: 'short', day: 'numeric' }) : '');
const ago = (n: number) => (n === 0 ? 'today' : n > 0 ? `in ${n} day${n === 1 ? '' : 's'}` : `${-n} day${n === -1 ? '' : 's'} ago`);

export type TrendAction = 'trend' | 'similar' | 'season' | 'watch' | 'score' | 'refresh';

function CalendarStrip({ events, trends, onSeason }: { events: CalEvent[]; trends: Trend[]; onSeason: (name: string) => void }) {
  const next = events.filter((e) => e.days_left >= 0).slice(0, 6);
  if (!next.length) return null;
  return (
    <section className="a3d-cal" aria-label="Upcoming events">
      {next.map((e) => {
        const done = trends.find((t) => t.kind === 'season' && t.event?.date === e.date && (t.event?.name ?? '').toLowerCase().startsWith(e.name.toLowerCase().slice(0, 8)));
        const late = e.days_to_publish < 0;
        return (
          <button key={e.id} type="button" className={late ? 'a3d-cal-item a3d-cal-late' : e.days_to_publish <= 14 ? 'a3d-cal-item a3d-cal-soon' : 'a3d-cal-item'} onClick={() => onSeason(e.name)}
            title={late ? 'The usual publish-by date has passed: only quick, simple models still make it.' : 'Analyse what to make for this event'}>
            <strong>{e.name}</strong>
            <span>{day(e.date)} · {ago(e.days_left)}</span>
            <span className="a3d-cal-pub">{late ? `publish-by passed ${-e.days_to_publish} d ago` : `publish by ${day(e.publish_by)} (${ago(e.days_to_publish)})`}</span>
            {done && <span className="a3d-pill a3d-pill-done">analysed</span>}
          </button>
        );
      })}
    </section>
  );
}

export function TrendsTab({ host, scan, busy, apify, selected, onSelectTrend, onAgent, onSet, onPrepare, onCreateModel, onSelectModel, onSelectIdea, onReveal, onOpen }: {
  host: PanelHost; scan: Scan; busy: boolean;
  selected: string | null;
  onSelectTrend: (slug: string) => void;
  /** Where an Apify MCP is registered for agent sessions, or null when not found / unknown. */
  apify: string | null | undefined;
  onAgent: (action: TrendAction, trend: Trend | null, preset?: string) => void;
  onSet: (t: Trend, pairs: string[]) => void;
  onPrepare: (t: Trend, idea: TrendIdea) => void;
  onCreateModel: (t: Trend, idea: TrendIdea) => void;
  onSelectModel: (slug: string) => void;
  onSelectIdea: (slug: string) => void;
  onReveal: (dir: string) => void;
  onOpen: (path: string) => void;
}) {
  const [kind, setKind] = useState<'all' | Trend['kind']>('all');
  const [showDropped, setShowDropped] = useState(false);
  const [dash, setDash] = useState(false);
  const list = useMemo(() => scan.trends
    .filter((t) => (kind === 'all' || t.kind === kind) && (showDropped || t.status !== 'dropped'))
    .sort((a, b) => (b.updated_at ?? '').localeCompare(a.updated_at ?? '')), [scan.trends, kind, showDropped]);
  const t = scan.trends.find((x) => x.slug === selected) ?? list[0] ?? null;
  const models = (slug: string) => scan.models.filter((m) => m.meta.origin?.trend === slug);
  const weights = scan.config.score_weights;
  const hasDash = !!t?._files.includes('dashboard.html');
  const ideas = t ? [...t.ideas].sort((a, b) => (total(b, weights) ?? -1) - (total(a, weights) ?? -1)) : [];
  const step = (m: Model) => m.meta.status ?? 'concept';

  return (
    <section className="a3d-trends">
      <header className="a3d-head">
        <div>
          <h1>Trends</h1>
          <p className="a3d-muted">What sells now, what to make like an existing model, what to make for a date. Scout researches; ideas go to Insights or straight to a model.
            {' '}<span className={apify ? 'a3d-pill a3d-pill-done' : 'a3d-pill'} title={apify ? `registered in ${apify}` : 'Not found in the Claude Code config: Scout falls back to web search.'}>{apify ? 'Apify connected' : 'Apify not registered'}</span>
          </p>
        </div>
        <span className="a3d-row">
          <button type="button" className="a3d-btn a3d-btn-primary" disabled={busy} onClick={() => onAgent('trend', null)}>Analyse trend…</button>
          <button type="button" className="a3d-btn a3d-btn-primary" disabled={busy} onClick={() => onAgent('similar', null)}>Similar model…</button>
          <button type="button" className="a3d-btn" disabled={busy} onClick={() => onAgent('season', null)}>Season…</button>
          <button type="button" className="a3d-btn" disabled={busy || !scan.trends.some((x) => x.status === 'watching')} onClick={() => onAgent('watch', null)}>Re-check watched</button>
        </span>
      </header>

      <CalendarStrip events={scan.calendar} trends={scan.trends} onSeason={(name) => onAgent('season', null, name)} />

      <div className="a3d-split">
        <aside className="a3d-split-list">
          <span className="a3d-seg a3d-seg-small" role="group" aria-label="Kind">
            {(['all', 'trend', 'similar', 'season'] as const).map((k) => (
              <button key={k} type="button" aria-pressed={kind === k} onClick={() => setKind(k)}>{k === 'all' ? 'All' : KIND[k]}</button>
            ))}
          </span>
          <label className="a3d-check"><input type="checkbox" checked={showDropped} onChange={(e) => setShowDropped(e.target.checked)} /> show dropped</label>
          {list.length === 0 && <p className="a3d-muted">No trends yet. Analyse one, or click an event above.</p>}
          <ul>
            {list.map((x) => (
              <li key={x.slug}>
                <button type="button" className={x.slug === t?.slug ? 'a3d-li a3d-li-sel' : 'a3d-li'} onClick={() => { onSelectTrend(x.slug); setDash(false); }}>
                  <span className="a3d-li-title">{x.title}</span>
                  <span className="a3d-muted">{KIND[x.kind]} · {x.status} · {x.ideas.length} idea{x.ideas.length === 1 ? '' : 's'}{models(x.slug).length ? ` · ${models(x.slug).length} model${models(x.slug).length === 1 ? '' : 's'}` : ''}</span>
                </button>
              </li>
            ))}
          </ul>
        </aside>

        {t ? (
          <article className="a3d-split-detail">
            <header className="a3d-detail-top">
              <div>
                <h2 className="a3d-h2">{t.title} <span className="a3d-pill">{KIND[t.kind]}</span>{t.saturation && <span className={`a3d-pill a3d-sat-${t.saturation}`}>saturation: {t.saturation}</span>}</h2>
                <p className="a3d-muted">{t.query && t.query !== t.title ? `“${t.query}” · ` : ''}updated {day(t.updated_at)}</p>
              </div>
              <span className="a3d-row">
                <label className="a3d-inline">Status
                  <select value={t.status} onChange={(e) => onSet(t, [`status=${e.target.value}`])}>
                    {['new', 'watching', 'used', 'dropped'].map((s) => <option key={s} value={s}>{s}</option>)}
                  </select>
                </label>
                {t.status === 'watching' && (
                  <label className="a3d-inline">Re-check
                    <input type="date" value={t.recheck_at ?? ''} onChange={(e) => onSet(t, [`recheck_at=${e.target.value}`])} />
                  </label>
                )}
              </span>
            </header>

            {t.summary ? <p className="a3d-summary">{t.summary}</p> : <p className="a3d-muted">No summary yet: Scout writes it when the analysis runs.</p>}

            {t.kind === 'season' && t.event?.date && (
              <p className="a3d-banner">{t.event.name}: {day(t.event.date)}. Publish by {day(t.event.publish_by)}
                {t.event.publish_by ? ` (${ago(Math.round((new Date(t.event.publish_by).getTime() - Date.now()) / 864e5))})` : ''}.</p>
            )}

            {t.kind === 'similar' && (
              <section className="a3d-block">
                <h4>Original model</h4>
                <p>{t.source?.url ? <a href={t.source.url} target="_blank" rel="noreferrer">{t.source.title || t.source.url}</a> : t.source?.title || t.source?.input || '—'}</p>
                <p className="a3d-muted">{[t.source?.license && `licence: ${t.source.license}`, t.source?.price != null && `price: ${t.source.price}`, t.source?.downloads != null && `downloads: ${t.source.downloads}`].filter(Boolean).join(' · ') || 'Licence, price and downloads not read yet.'}</p>
                {t.ip && (
                  <div className="a3d-ip">
                    <div><h5>Can take</h5><ul>{(t.ip.can_take ?? []).map((x) => <li key={x}>{x}</li>)}</ul></div>
                    <div><h5>Must avoid</h5><ul>{(t.ip.must_avoid ?? []).map((x) => <li key={x}>{x}</li>)}</ul></div>
                    <div><h5>Risk</h5><span className={`a3d-pill a3d-risk-${t.ip.risk ?? 'unknown'}`}>{t.ip.risk ?? 'not assessed'}</span></div>
                  </div>
                )}
              </section>
            )}

            <section className="a3d-block">
              <h4>Ideas <span className="a3d-count">{t.ideas.length}</span>
                <span className="a3d-block-actions">
                  <button type="button" className="a3d-btn a3d-btn-small" disabled={busy || !t.ideas.length} onClick={() => onAgent('score', t)}>Score ideas (Prism)</button>
                  {hasDash && <button type="button" className="a3d-btn a3d-btn-small" aria-pressed={dash} onClick={() => setDash((v) => !v)}>Dashboard</button>}
                </span>
              </h4>
              {dash && hasDash && <DashboardFrame host={host} path={`${t._dir}/dashboard.html`} mtime={t._mtime} title={`${t.title} ideas`} />}
              {ideas.length === 0 ? <p className="a3d-muted">No ideas yet.</p> : (
                <table className="a3d-filetable a3d-ideas">
                  <thead><tr><th>Idea</th><th>Type</th><th>Score</th><th>Status</th><th><span className="a3d-sr">Actions</span></th></tr></thead>
                  <tbody>
                    {ideas.map((i) => {
                      const m = i.model ? scan.models.find((x) => x.slug === i.model) : null;
                      return (
                        <tr key={i.id}>
                          <td><strong>{i.name}</strong>{i.pitch && <div className="a3d-muted">{i.pitch}</div>}</td>
                          <td>{i.model_type ?? ''}</td>
                          <td><ScoreBar value={total(i, weights)} /></td>
                          <td>{i.status ?? 'candidate'}</td>
                          <td><span className="a3d-row a3d-row-end">
                            {i.insight ? <button type="button" className="a3d-btn a3d-btn-small" onClick={() => onSelectIdea(i.insight!)}>Open in Insights</button>
                              : <button type="button" className="a3d-btn a3d-btn-small" onClick={() => onPrepare(t, i)} title="Create it in Insights to prepare before modelling">Prepare</button>}
                            {m ? <button type="button" className="a3d-btn a3d-btn-small" onClick={() => onSelectModel(m.slug)}>Model: {m.meta.title || m.slug}</button>
                              : <button type="button" className="a3d-btn a3d-btn-small" disabled={busy} onClick={() => onCreateModel(t, i)}>Create model</button>}
                          </span></td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              )}
            </section>

            {t.signals.length > 0 && (
              <section className="a3d-block">
                <h4>Signals <span className="a3d-count">{t.signals.length}</span></h4>
                <table className="a3d-filetable">
                  <thead><tr><th>What</th><th>Value</th><th>Date</th><th>Source</th></tr></thead>
                  <tbody>{t.signals.map((s, n) => (
                    <tr key={n}><td>{s.metric}{s.note && <div className="a3d-muted">{s.note}</div>}</td><td className="a3d-num">{String(s.value ?? '')}</td><td className="a3d-num">{day(s.at)}</td>
                      <td>{s.url ? <a href={s.url} target="_blank" rel="noreferrer">{s.source || 'link'}</a> : s.source}</td></tr>
                  ))}</tbody>
                </table>
              </section>
            )}

            <section className="a3d-block">
              <h4>Models from this trend <span className="a3d-count">{models(t.slug).length}</span></h4>
              {models(t.slug).length === 0 ? <p className="a3d-muted">None yet. “Create model” on an idea starts one and links it here.</p> : (
                <p className="a3d-row">{models(t.slug).map((m) => <button key={m.slug} type="button" className="a3d-btn a3d-btn-small" onClick={() => onSelectModel(m.slug)}>{m.meta.title || m.slug} · {step(m)}</button>)}</p>
              )}
            </section>

            <p className="a3d-row">
              <button type="button" className="a3d-btn" disabled={busy} onClick={() => onAgent('refresh', t)}>Refresh signals (Scout)</button>
              {t._files.includes('trend.md') && <button type="button" className="a3d-btn" onClick={() => onOpen(`${t._dir}/trend.md`)}>Open report</button>}
              <button type="button" className="a3d-btn" onClick={() => onOpen(`${t._dir}/trend.json`)}>Open trend.json</button>
              <button type="button" className="a3d-btn" onClick={() => onReveal(t._dir)}>Show in Finder</button>
            </p>
          </article>
        ) : <div className="a3d-placeholder">Pick a trend, or start one above.</div>}
      </div>
    </section>
  );
}
