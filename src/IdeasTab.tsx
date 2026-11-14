import { useMemo, useState } from 'react';
import type { PanelHost } from '@nimbalyst/extension-sdk';
import { ScoreBar, ScoreDims, total } from './score';
import type { Insight, Scan } from './types';
import { Img } from './ui';

const STATUS = ['draft', 'prepared', 'go', 'later', 'no', 'modeled'] as const;
const KINDS = ['animal', 'character', 'object', 'other'];
export type IdeaAction = 'prepare' | 'score' | 'concept';

function NewIdea({ onCancel, onCreate }: { onCancel: () => void; onCreate: (title: string, kind: string, description: string, prepare: boolean) => void }) {
  const [title, setTitle] = useState('');
  const [kind, setKind] = useState('animal');
  const [desc, setDesc] = useState('');
  const submit = (prepare: boolean) => { if (title.trim()) onCreate(title.trim(), kind, desc.trim(), prepare); };
  return (
    <div className="a3d-overlay" onClick={onCancel}>
      <form className="a3d-dialog a3d-dialog-wide" onClick={(e) => e.stopPropagation()} onSubmit={(e) => { e.preventDefault(); submit(true); }}>
        <h3>New idea</h3>
        <p className="a3d-muted">An animal, a character or a thing you want to turn into a model. It is saved in insights/ at once; preparing it is an agent run.</p>
        <label>Name<input autoFocus value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Axolotl dragon" /></label>
        <label>Kind<select value={kind} onChange={(e) => setKind(e.target.value)}>{KINDS.map((k) => <option key={k}>{k}</option>)}</select></label>
        <label>What you have in mind
          <textarea rows={4} value={desc} onChange={(e) => setDesc(e.target.value)} placeholder="Chibi axolotl with small dragon wings, flexi, about 12 cm, for kids." />
        </label>
        <span className="a3d-row a3d-row-end">
          <button type="button" className="a3d-btn" onClick={onCancel}>Cancel</button>
          <button type="button" className="a3d-btn" disabled={!title.trim()} onClick={() => submit(false)}>Save only</button>
          <button type="submit" className="a3d-btn a3d-btn-primary" disabled={!title.trim()}>Save and prepare (Muse)</button>
        </span>
      </form>
    </div>
  );
}

export function IdeasTab({ host, scan, busy, selected, onSelect, onCreate, onAgent, onDecide, onSelectTrend, onSelectModel, onReveal, onOpen }: {
  host: PanelHost; scan: Scan; busy: boolean; selected: string | null;
  onSelect: (slug: string) => void;
  onCreate: (title: string, kind: string, description: string, prepare: boolean) => void;
  onAgent: (action: IdeaAction, i: Insight) => void;
  onDecide: (i: Insight, verdict: 'go' | 'later' | 'no') => void;
  onSelectTrend: (slug: string) => void;
  onSelectModel: (slug: string) => void;
  onReveal: (dir: string) => void;
  onOpen: (path: string) => void;
}) {
  const [filter, setFilter] = useState<'open' | 'all'>('open');
  const [creating, setCreating] = useState(false);
  const weights = scan.config.score_weights;
  const list = useMemo(() => scan.ideas
    .filter((i) => filter === 'all' || !['no', 'modeled'].includes(i.status))
    .sort((a, b) => (b.updated_at ?? '').localeCompare(a.updated_at ?? '')), [scan.ideas, filter]);
  const i = scan.ideas.find((x) => x.slug === selected) ?? list[0] ?? null;
  const trend = i?.trend ? scan.trends.find((t) => t.slug === i.trend) : null;
  const model = i?.model ? scan.models.find((m) => m.slug === i.model) : null;
  const imgs = (i?._refs ?? []).filter((f) => /\.(png|jpe?g|webp|gif)$/i.test(f));
  const canModel = !!i && !model && (i.status === 'go' || i.status === 'prepared');

  return (
    <section className="a3d-trends">
      <header className="a3d-head">
        <div>
          <h1>Insights</h1>
          <p className="a3d-muted">Prepare an idea before it becomes a model: what makes it recognisable, references, variants and printability, what already exists, IP risk. Then go, later or no.</p>
        </div>
        <span className="a3d-row"><button type="button" className="a3d-btn a3d-btn-primary" onClick={() => setCreating(true)}>New idea…</button></span>
      </header>

      <div className="a3d-split">
        <aside className="a3d-split-list">
          <span className="a3d-seg a3d-seg-small" role="group" aria-label="Filter">
            <button type="button" aria-pressed={filter === 'open'} onClick={() => setFilter('open')}>Open</button>
            <button type="button" aria-pressed={filter === 'all'} onClick={() => setFilter('all')}>All</button>
          </span>
          {list.length === 0 && <p className="a3d-muted">No ideas yet. Add one, or “Prepare” an idea from a trend.</p>}
          <ul>
            {list.map((x) => (
              <li key={x.slug}>
                <button type="button" className={x.slug === i?.slug ? 'a3d-li a3d-li-sel' : 'a3d-li'} onClick={() => onSelect(x.slug)}>
                  <span className="a3d-li-title">{x.title} <span className={`a3d-pill a3d-is-${x.status}`}>{x.status}</span></span>
                  <span className="a3d-muted">{x.subject_kind}{x.trend ? ` · from ${scan.trends.find((t) => t.slug === x.trend)?.title ?? x.trend}` : ''}</span>
                  <ScoreBar value={total(x, weights)} />
                </button>
              </li>
            ))}
          </ul>
        </aside>

        {i ? (
          <article className="a3d-split-detail">
            <header className="a3d-detail-top">
              <div>
                <h2 className="a3d-h2">{i.title} <span className={`a3d-pill a3d-is-${i.status}`}>{i.status}</span>{i.subject_kind && <span className="a3d-pill">{i.subject_kind}</span>}</h2>
                <p className="a3d-muted">
                  {trend ? <>From trend <button type="button" className="a3d-link" onClick={() => onSelectTrend(trend.slug)}>{trend.title}</button> · </> : null}
                  {model ? <>Model <button type="button" className="a3d-link" onClick={() => onSelectModel(model.slug)}>{model.meta.title || model.slug}</button> · </> : null}
                  {i.decision ? `decided ${i.decision.verdict}${i.decision.reason ? `: ${i.decision.reason}` : ''}` : 'no decision yet'}
                </p>
              </div>
              <span className="a3d-row">
                <span className="a3d-muted">Decision</span>
                {(['go', 'later', 'no'] as const).map((v) => (
                  <button key={v} type="button" className="a3d-btn a3d-btn-small" aria-pressed={i.decision?.verdict === v} disabled={i.status === 'modeled'} onClick={() => onDecide(i, v)}>{v === 'go' ? 'Go' : v === 'later' ? 'Later' : 'No'}</button>
                ))}
              </span>
            </header>

            {i.description && <p className="a3d-summary">{i.description}</p>}

            <p className="a3d-row">
              <button type="button" className="a3d-btn a3d-btn-primary" disabled={busy} onClick={() => onAgent('prepare', i)}>{i.status === 'draft' ? 'Prepare (Muse)' : 'Prepare again (Muse)'}</button>
              <button type="button" className="a3d-btn" disabled={busy} onClick={() => onAgent('score', i)}>Score (Prism)</button>
              <button type="button" className="a3d-btn" disabled={busy || !canModel} onClick={() => onAgent('concept', i)}
                title={canModel ? 'Muse creates the model from the brief and links it here' : model ? 'already modeled' : 'prepare it or decide Go first'}>Create model</button>
              {i._files.includes('brief.md') && <button type="button" className="a3d-btn" onClick={() => onOpen(`${i._dir}/brief.md`)}>Open brief</button>}
              <button type="button" className="a3d-btn" onClick={() => onReveal(i._dir)}>Show in Finder</button>
            </p>

            <div className="a3d-two">
              <section className="a3d-block">
                <h4>Scores <ScoreBar value={total(i, weights)} /></h4>
                {Object.keys(i.scores ?? {}).length ? <ScoreDims s={i} /> : <p className="a3d-muted">Not scored yet.</p>}
                {(i.evidence ?? []).length > 0 && (
                  <ul className="a3d-evidence">{i.evidence!.map((e, n) => <li key={n}>{e.url ? <a href={e.url} target="_blank" rel="noreferrer">{e.label}</a> : e.label}</li>)}</ul>
                )}
              </section>
              <section className="a3d-block">
                <h4>Recognisable traits</h4>
                {(i.traits ?? []).length ? <p className="a3d-chips">{i.traits!.map((x) => <span key={x} className="a3d-pill">{x}</span>)}</p> : <p className="a3d-muted">Filled by Prepare.</p>}
                <h4>IP</h4>
                <p><span className={`a3d-pill a3d-risk-${i.ip?.risk ?? 'unknown'}`}>{i.ip?.risk ?? 'not assessed'}</span> {i.ip?.notes}</p>
              </section>
            </div>

            {(i.variants ?? []).length > 0 && (
              <section className="a3d-block">
                <h4>Variants</h4>
                <table className="a3d-filetable">
                  <thead><tr><th></th><th>Type</th><th>Style</th><th>Size</th><th>Printability</th><th>Notes</th></tr></thead>
                  <tbody>{i.variants!.map((v) => (
                    <tr key={v.id}><td>{i.chosen_variant === v.id ? <span className="a3d-pill a3d-pill-done">chosen</span> : v.id}</td><td>{v.model_type}</td><td>{v.style}</td>
                      <td className="a3d-num">{v.size_mm ? `${v.size_mm} mm` : ''}</td><td className="a3d-num">{v.printability != null ? `${v.printability} / 5` : ''}</td><td>{v.notes}</td></tr>
                  ))}</tbody>
                </table>
              </section>
            )}

            {(imgs.length > 0 || (i.references ?? []).length > 0) && (
              <section className="a3d-block">
                <h4>References</h4>
                {imgs.length > 0 && (
                  <div className="a3d-gallery">{imgs.map((f) => (
                    <figure key={f}><Img host={host} path={`${i._dir}/refs/${f}`} mtime={i._mtime} alt={f} /><figcaption>{f}</figcaption></figure>
                  ))}</div>
                )}
                <ul className="a3d-evidence">{(i.references ?? []).map((r, n) => (
                  <li key={n}>{r.url ? <a href={r.url} target="_blank" rel="noreferrer">{r.title || r.url}</a> : r.title || r.file}{r.note ? <span className="a3d-muted"> — {r.note}</span> : null}</li>
                ))}</ul>
              </section>
            )}

            {(i.similar ?? []).length > 0 && (
              <section className="a3d-block">
                <h4>Already on the market</h4>
                <table className="a3d-filetable">
                  <thead><tr><th>Model</th><th>Downloads</th><th>Price</th><th>Note</th></tr></thead>
                  <tbody>{i.similar!.map((s, n) => (
                    <tr key={n}><td>{s.url ? <a href={s.url} target="_blank" rel="noreferrer">{s.title || s.url}</a> : s.title}</td><td className="a3d-num">{s.downloads ?? ''}</td><td className="a3d-num">{s.price ?? ''}</td><td>{s.note}</td></tr>
                  ))}</tbody>
                </table>
              </section>
            )}
          </article>
        ) : <div className="a3d-placeholder">Add an idea to prepare it.</div>}
      </div>
      {creating && <NewIdea onCancel={() => setCreating(false)} onCreate={(...a) => { setCreating(false); onCreate(...a); }} />}
    </section>
  );
}
