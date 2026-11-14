import type { PanelHost } from '@nimbalyst/extension-sdk';
import { useState } from 'react';
import { DashboardFrame } from './Dashboard';
import { images, type StepView } from './flow';
import type { Scan } from './types';
import { Img } from './ui';

export function ModelsTab({ host, scan, stepsBySlug, selected, onSelect, onNew, onScout, onPortfolio, onSelectTrend }: {
  host: PanelHost;
  scan: Scan;
  stepsBySlug: Record<string, StepView[]>;
  selected: string | null;
  onSelect: (slug: string) => void;
  onNew: () => void;
  onScout: () => void;
  onPortfolio: () => void;
  onSelectTrend: (slug: string) => void;
}) {
  const [view, setView] = useState<'cards' | 'board' | 'portfolio'>('cards');
  const portfolio = scan.dashboards.find((f) => f.name === 'portfolio.html');
  const models = scan.models;
  const currentOf = (slug: string) => (stepsBySlug[slug] ?? []).find((x) => x.state === 'active' || x.state === 'waiting') ?? null;
  const waiting = models.map((m) => ({ m, s: currentOf(m.slug) })).filter((x) => x.s?.state === 'waiting') as { m: typeof models[number]; s: StepView }[];
  const stepList = stepsBySlug[models[0]?.slug ?? ''] ?? [];
  const columns = [
    ...stepList.map((st) => ({ id: st.id, title: st.title, items: models.map((m) => ({ m, s: currentOf(m.slug) })).filter((x) => x.s?.id === st.id) })),
    { id: 'done', title: 'Done', items: models.map((m) => ({ m, s: currentOf(m.slug) })).filter((x) => !x.s) },
  ];
  const yours = models.filter((m) => (stepsBySlug[m.slug] ?? []).some((s) => s.state === 'waiting')).length;
  return (
    <section className="a3d-models-tab">
      <header className="a3d-head">
        <div>
          <h1>Models</h1>
          <p className="a3d-muted">
            {models.length} model{models.length === 1 ? '' : 's'} in <code>{scan.root.startsWith(scan.workspace) ? scan.root.slice(scan.workspace.length + 1) || '.' : scan.root}</code>
            {yours > 0 ? ` · ${yours} waiting for you` : ''}. Pick one: Flow and Files follow it.
          </p>
        </div>
        <span className="a3d-row">
          <span className="a3d-seg" role="group" aria-label="View">
            <button type="button" aria-pressed={view === 'cards'} onClick={() => setView('cards')}>Cards</button>
            <button type="button" aria-pressed={view === 'board'} onClick={() => setView('board')}>Board</button>
            <button type="button" aria-pressed={view === 'portfolio'} onClick={() => setView('portfolio')}>Portfolio</button>
          </span>
          <button type="button" className="a3d-btn" onClick={onScout}>Trends</button>
          <button type="button" className="a3d-btn a3d-btn-primary" onClick={onNew}>New model</button>
        </span>
      </header>
      {waiting.length > 0 && view !== 'portfolio' && (
        <section className="a3d-queue" aria-label="Waiting for you">
          <h3>Waiting for you <span className="a3d-count">{waiting.length}</span></h3>
          <ul>
            {waiting.map(({ m, s }) => (
              <li key={m.slug}>
                <button type="button" className="a3d-queue-item" onClick={() => onSelect(m.slug)}>
                  <strong>{m.meta.title || m.slug}</strong>
                  <span className="a3d-muted">Step {s.n} · {s.title}: {s.hint}</span>
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}
      {view === 'board' && (
        <section className="a3d-board" aria-label="Board">
          {columns.map((col) => (
            <div key={col.id} className="a3d-board-col">
              <h4>{col.title} <span className="a3d-count">{col.items.length}</span></h4>
              {col.items.map(({ m, s }) => (
                <button key={m.slug} type="button" className={m.slug === selected ? 'a3d-board-card a3d-card-selected' : 'a3d-board-card'} onClick={() => onSelect(m.slug)}>
                  <strong>{m.meta.title || m.slug}</strong>
                  <span className="a3d-muted">{s?.state === 'waiting' ? 'your turn' : m.flow.nodes.some((n) => n.status === 'running') ? 'running' : s ? 'next' : m.meta.status ?? ''}</span>
                </button>
              ))}
            </div>
          ))}
        </section>
      )}
      {view === 'portfolio' && (
        <section className="a3d-block">
          <p className="a3d-row">
            <span className="a3d-muted">Charts across every model: pipeline, overhang before and after, size, rounds spent.</span>
            <span className="a3d-tabs-spacer" />
            <button type="button" className="a3d-btn a3d-btn-small" disabled={!scan.tools.buildInsights} onClick={onPortfolio}>{portfolio ? 'Rebuild' : 'Build'}</button>
          </p>
          {portfolio ? <DashboardFrame host={host} path={`${scan.root}/_insights/portfolio.html`} mtime={portfolio.mtime} title="Portfolio" />
            : <p className="a3d-muted">Not built yet.</p>}
        </section>
      )}
      {view === 'cards' && models.length === 0 && (
        <p className="a3d-empty">
          {scan.rootExists ? 'No models yet.' : `Folder not found: ${scan.root}`}
          <br />Start with Scout to pick a subject, or New model if you already have an idea.
        </p>
      )}
      {view === 'cards' && <ul className="a3d-cards">
        {models.map((m) => {
          const ss = stepsBySlug[m.slug] ?? [];
          const cur = ss.find((x) => x.state === 'active' || x.state === 'waiting');
          const doneCount = ss.filter((x) => x.state === 'done').length;
          const pick = (['renders', 'images', 'inbox'] as const).map((folder) => ({ folder, f: images(m.files[folder])[0] })).find((x) => x.f);
          const running = m.flow.nodes.some((n) => n.status === 'running');
          const meshes = m.files.mesh.filter((f) => /\.(stl|glb|gltf|obj|fbx)$/i.test(f.name)).length + m.attempts.length + m.files.print.filter((f) => /\.3mf$/i.test(f.name)).length;
          const pics = images(m.files.inbox).length + images(m.files.images).length + images(m.files.renders).length;
          return (
            <li key={m.slug}>
              <button type="button" className={m.slug === selected ? 'a3d-card a3d-card-selected' : 'a3d-card'} aria-pressed={m.slug === selected} onClick={() => onSelect(m.slug)}>
                <span className="a3d-card-thumb">
                  {pick ? <Img host={host} path={`${m.dir}/${pick.folder}/${pick.f.name}`} mtime={pick.f.mtime} alt="" /> : <span className="a3d-muted">no image yet</span>}
                </span>
                <span className="a3d-card-body">
                  <span className="a3d-card-title">
                    {m.meta.title || m.slug}
                    {running ? <span className="a3d-tag a3d-tag-run">running</span> : cur?.state === 'waiting' ? <span className="a3d-tag a3d-tag-waiting">your turn</span> : null}
                  </span>
                  <span className="a3d-muted">{[m.meta.model_type, m.meta.status].filter(Boolean).join(' · ') || 'no metadata'}</span>
                  <span className="a3d-card-step">{cur ? `Step ${cur.n} of ${ss.length} · ${cur.title}` : `${doneCount} of ${ss.length} done`}</span>
                  <span className="a3d-progress" aria-hidden="true">{ss.map((x) => <i key={x.id} className={`a3d-pip a3d-${x.state}`} />)}</span>
                  {m.meta.origin?.trend && (
                    <span className="a3d-card-origin">from <span role="link" tabIndex={0} className="a3d-link"
                      onClick={(e) => { e.stopPropagation(); onSelectTrend(m.meta.origin.trend); }}
                      onKeyDown={(e) => { if (e.key === 'Enter') { e.stopPropagation(); onSelectTrend(m.meta.origin.trend); } }}>
                      {scan.trends.find((t) => t.slug === m.meta.origin.trend)?.title ?? m.meta.origin.trend}</span></span>
                  )}
                  <span className="a3d-muted a3d-card-counts">{pics} image{pics === 1 ? '' : 's'} · {meshes} 3D file{meshes === 1 ? '' : 's'} · {m.flow.nodes.length} attempt{m.flow.nodes.length === 1 ? '' : 's'}{(() => { const n = (m.branches ?? []).filter((b) => b.status !== 'archived').length; return n > 1 ? ` · ${n} branches` : ''; })()}</span>
                </span>
              </button>
            </li>
          );
        })}
      </ul>}
    </section>
  );
}
