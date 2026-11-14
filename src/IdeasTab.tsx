import { useMemo, useState, type ReactNode } from 'react';
import type { PanelHost } from '@nimbalyst/extension-sdk';
import { ScoreBar, ScoreDims, total } from './score';
import type { Insight, Scan } from './types';
import { Img } from './ui';

const KINDS = ['animal', 'character', 'object', 'other'];
const IMG = /\.(png|jpe?g|webp|gif)$/i;
export type IdeaAction = 'prepare' | 'score' | 'concept' | 'refs';

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

type StageState = 'done' | 'next' | 'todo';

/** One box of the idea's path: what the stage is for, where it stands, its buttons. */
function Stage({ n, title, state, text, running, children }: { n: number; title: string; state: StageState; text: string; running?: boolean; children: ReactNode }) {
  return (
    <li className={`a3d-stage a3d-stage-${state}`}>
      <span className="a3d-stage-top"><span className="a3d-stage-n">{state === 'done' ? '✓' : n}</span><strong>{title}</strong>
        {running ? <span className="a3d-tag a3d-tag-run">running</span> : state === 'next' ? <span className="a3d-tag a3d-tag-waiting">next</span> : null}</span>
      <span className="a3d-muted a3d-small">{text}</span>
      <span className="a3d-row">{children}</span>
    </li>
  );
}

export function IdeasTab({ host, scan, selected, running, onSelect, onCreate, onAgent, onDecide, onRef, onRemoveRef, onPickImage, onZoom, onSelectTrend, onSelectModel, onReveal, onOpen }: {
  host: PanelHost; scan: Scan; busy: boolean; selected: string | null;
  /** Labels of agent runs still in their first turn (to mark the stage they belong to). */
  running: string[];
  onSelect: (slug: string) => void;
  onCreate: (title: string, kind: string, description: string, prepare: boolean) => void;
  onAgent: (action: IdeaAction, i: Insight, extra?: string) => void;
  onDecide: (i: Insight, verdict: 'go' | 'later' | 'no') => void;
  onRef: (i: Insight, ref: { url?: string; file?: string; note?: string }) => void;
  onRemoveRef: (i: Insight, index: number) => void;
  onPickImage: () => Promise<string[] | null>;
  onZoom: (z: { path: string; mtime: number; name: string }) => void;
  onSelectTrend: (slug: string) => void;
  onSelectModel: (slug: string) => void;
  onReveal: (dir: string) => void;
  onOpen: (path: string) => void;
}) {
  const [filter, setFilter] = useState<'open' | 'all'>('open');
  const [creating, setCreating] = useState(false);
  const [link, setLink] = useState('');
  const [linkNote, setLinkNote] = useState('');
  const [look, setLook] = useState('');
  const weights = scan.config.score_weights;
  const list = useMemo(() => scan.ideas
    .filter((i) => filter === 'all' || !['no', 'modeled'].includes(i.status))
    .sort((a, b) => (b.updated_at ?? '').localeCompare(a.updated_at ?? '')), [scan.ideas, filter]);
  const i = scan.ideas.find((x) => x.slug === selected) ?? list[0] ?? null;
  const trend = i?.trend ? scan.trends.find((t) => t.slug === i.trend) : null;
  const model = i?.model ? scan.models.find((m) => m.slug === i.model) : null;
  const refs = i?.references ?? [];
  const listed = new Set(refs.map((r) => (r.file ?? '').replace(/^refs\//, '')).filter(Boolean));
  const loose = (i?._refs ?? []).filter((f) => IMG.test(f) && !listed.has(f));
  const pics = [...refs.map((r, n) => ({ r, n })).filter((x) => x.r.file && IMG.test(x.r.file)).map((x) => ({ file: x.r.file!.replace(/^refs\//, ''), title: x.r.title, note: x.r.note, url: x.r.url, n: x.n as number | null })),
    ...loose.map((f) => ({ file: f, title: f, note: undefined as string | undefined, url: undefined as string | undefined, n: null as number | null }))];
  const links = refs.map((r, n) => ({ r, n })).filter((x) => x.r.url);
  const evidence = (i?.evidence ?? []).filter((e) => e.label || e.url);

  const prepared = !!i && (i.status !== 'draft' || (i.traits ?? []).length > 0 || (i.variants ?? []).length > 0);
  const scored = !!i && Object.keys(i.scores ?? {}).length > 0;
  const decided = !!i?.decision;
  const modeled = !!model || i?.status === 'modeled';
  const order = [prepared, scored, decided, modeled];
  const firstOpen = order.indexOf(false);
  const st = (k: number): StageState => (order[k] ? 'done' : k === firstOpen ? 'next' : 'todo');
  const runs = (word: string) => !!i && running.some((l) => l.startsWith(word) && l.includes(i.title));
  const validLink = /^https?:\/\/\S+$/i.test(link.trim());

  return (
    <section className="a3d-trends">
      <header className="a3d-head">
        <div>
          <h1>Insights</h1>
          <p className="a3d-muted">An idea goes through four stages: prepare (traits, references from the web, variants, market, IP), score, decide, create the model. You can create the model at any stage.</p>
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
                  {i.description || 'No description yet.'}
                </p>
              </div>
              <span className="a3d-row">
                {i._files.includes('brief.md') && <button type="button" className="a3d-btn a3d-btn-small" onClick={() => onOpen(`${i._dir}/brief.md`)}>Open brief</button>}
                <button type="button" className="a3d-btn a3d-btn-small" onClick={() => onReveal(i._dir)}>Show in Finder</button>
              </span>
            </header>

            <ol className="a3d-stages" aria-label="Stages of this idea">
              <Stage n={1} title="Prepare" state={st(0)} running={runs('Prepare') || runs('References')}
                text={prepared ? `${(i.traits ?? []).length} traits · ${refs.length + loose.length} references · ${(i.variants ?? []).length} variants` : 'Muse searches the web, collects references, traits, variants, similar models and the IP risk, and writes the brief.'}>
                <button type="button" className={st(0) === 'next' ? 'a3d-btn a3d-btn-primary' : 'a3d-btn'} onClick={() => onAgent('prepare', i)}
                  title="Agent run: ai3d-muse *prepare">{prepared ? 'Prepare again' : 'Prepare (Muse)'}</button>
              </Stage>
              <Stage n={2} title="Score" state={st(1)} running={runs('Score')}
                text={scored ? `Total ${total(i, weights) ?? '–'} of 100 with your weights.` : 'Prism scores demand, print fit, stand-out, IP safety and ease, with evidence.'}>
                <button type="button" className={st(1) === 'next' ? 'a3d-btn a3d-btn-primary' : 'a3d-btn'} onClick={() => onAgent('score', i)} title="Agent run: ai3d-prism *score insight">{scored ? 'Score again' : 'Score (Prism)'}</button>
              </Stage>
              <Stage n={3} title="Decide" state={st(2)}
                text={i.decision ? `Decided ${i.decision.verdict}${i.decision.reason ? `: ${i.decision.reason}` : ''}.` : 'Your call. It only marks the idea; nothing is deleted.'}>
                {(['go', 'later', 'no'] as const).map((v) => (
                  <button key={v} type="button" className="a3d-btn a3d-btn-small" aria-pressed={i.decision?.verdict === v} disabled={i.status === 'modeled'} onClick={() => onDecide(i, v)}
                    title={`Runs: trend_lib.py decide <idea folder> ${v}`}>{v === 'go' ? 'Go' : v === 'later' ? 'Later' : 'No'}</button>
                ))}
              </Stage>
              <Stage n={4} title="Model" state={st(3)} running={runs('New model')}
                text={model ? 'The model exists; work on it in Flow.' : prepared ? 'Muse writes the concept from the brief and creates the model folder, linked to this idea.' : 'Possible now: Muse works from the description only. Preparing first gives it references and a variant.'}>
                {model
                  ? <button type="button" className="a3d-btn a3d-btn-primary" onClick={() => onSelectModel(model.slug)}>Open model</button>
                  : <button type="button" className={st(3) === 'next' || i.decision?.verdict === 'go' ? 'a3d-btn a3d-btn-primary' : 'a3d-btn'} onClick={() => onAgent('concept', i)}
                      title="Agent run: ai3d-muse *concept with this idea">Create model</button>}
              </Stage>
            </ol>

            <section className="a3d-block">
              <h4>References <span className="a3d-count">{refs.length + loose.length}</span></h4>
              <p className="a3d-muted a3d-small">Pictures and pages Muse and Lumen work from. Found on the web by Muse, or added by you. Pictures are saved in the idea’s <code>refs/</code> folder.</p>
              <form className="a3d-row a3d-refbar" onSubmit={(e) => { e.preventDefault(); onAgent('refs', i, look.trim() || undefined); setLook(''); }}>
                <input className="a3d-in-grow" aria-label="What to look for" placeholder="What to look for (optional): side view, chibi style, printed flexi versions…" value={look} onChange={(e) => setLook(e.target.value)} />
                <button type="submit" className="a3d-btn a3d-btn-primary" title="Agent run: ai3d-muse *refs — web search for pages and pictures, saved with trend_lib.py ref">Find on the web (Muse)</button>
              </form>
              <form className="a3d-row a3d-refbar" onSubmit={(e) => { e.preventDefault(); if (validLink) { onRef(i, { url: link.trim(), note: linkNote.trim() || undefined }); setLink(''); setLinkNote(''); } }}>
                <input className="a3d-in-grow" aria-label="Link" placeholder="Paste a link to a page or a picture (https://…)" value={link} onChange={(e) => setLink(e.target.value)} />
                <input className="a3d-in-small" aria-label="Note" placeholder="note" value={linkNote} onChange={(e) => setLinkNote(e.target.value)} />
                <button type="submit" className="a3d-btn" disabled={!validLink} title="Runs: trend_lib.py ref <idea folder> --url … (a picture link is downloaded into refs/)">Add link</button>
                <button type="button" className="a3d-btn" title="Runs: trend_lib.py ref <idea folder> --file …"
                  onClick={async () => { const p = await onPickImage(); for (const f of p ?? []) onRef(i, { file: f }); }}>Add picture…</button>
              </form>
              {pics.length > 0 && (
                <div className="a3d-gallery">{pics.map((x) => {
                  const path = `${i._dir}/refs/${x.file}`;
                  return (
                    <figure key={x.file}>
                      <Img host={host} path={path} mtime={i._mtime} alt={x.title || x.file} onClick={() => onZoom({ path, mtime: i._mtime, name: x.title || x.file })} />
                      <figcaption title={x.note}>{x.note || x.title || x.file}</figcaption>
                    </figure>
                  );
                })}</div>
              )}
              {links.length > 0 && (
                <ul className="a3d-reflist">{links.map(({ r, n }) => (
                  <li key={n}>
                    <a href={r.url} target="_blank" rel="noreferrer">{r.title || r.url}</a>
                    {r.file ? <span className="a3d-pill">picture saved</span> : null}
                    {r.note ? <span className="a3d-muted"> — {r.note}</span> : null}
                    <button type="button" className="a3d-link" aria-label={`Remove reference ${r.title || r.url}`} onClick={() => onRemoveRef(i, n + 1)}>remove</button>
                  </li>
                ))}</ul>
              )}
              {pics.length === 0 && links.length === 0 && <p className="a3d-muted">No references yet. “Find on the web” searches for the real subject, the style and existing printed models.</p>}
            </section>

            <div className="a3d-two">
              <section className="a3d-block">
                <h4>Recognisable traits</h4>
                {(i.traits ?? []).length ? <p className="a3d-chips">{i.traits!.map((x) => <span key={x} className="a3d-pill">{x}</span>)}</p> : <p className="a3d-muted">Filled by Prepare: the 3–6 features that must survive at print size.</p>}
                <h4>IP risk</h4>
                <p><span className={`a3d-pill a3d-risk-${i.ip?.risk ?? 'unknown'}`}>{i.ip?.risk ?? 'not assessed'}</span> {i.ip?.notes}</p>
              </section>
              <section className="a3d-block">
                <h4>Scores <ScoreBar value={total(i, weights)} /></h4>
                {scored ? <ScoreDims s={i} /> : <p className="a3d-muted">Not scored yet.</p>}
                {evidence.length > 0 && (
                  <ul className="a3d-evidence">{evidence.map((e, n) => <li key={n}>{e.url ? <a href={e.url} target="_blank" rel="noreferrer">{e.label || e.url}</a> : e.label}</li>)}</ul>
                )}
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
