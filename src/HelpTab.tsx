import { useMemo, useState } from 'react';
import { describe, REFERENCE } from './commands';
import type { StepView } from './flow';
import { StepTips } from './Tips';
import type { Model, Scan } from './types';
import type { BlenderStatus } from './blender';
import { healthChecks } from './health';

const STEP_LIST: [string, string][] = [['concept', '1 · Concept'], ['image', '2 · Image'], ['mesh', '3 · 3D mesh'], ['blender', '4 · Blender'],
  ['validate', '5 · Validate'], ['print', '6 · Test print'], ['publish', '7 · Publish'], ['branches', 'Branches'], ['runs', 'Model & reasoning']];

export function HelpTab({ scan, model, blender, steps, stepsBySlug, tips, busy, statusText, statusBusy, onStatus, onAsk, onGo, onSelectModel }: {
  scan: Scan;
  model: Model | null;
  blender: BlenderStatus | null;
  steps: StepView[];
  stepsBySlug: Record<string, StepView[]>;
  tips: Record<string, string>;
  busy: boolean;
  statusText: string | null;
  statusBusy: boolean;
  onStatus: () => void;
  onAsk: (trigger: string, arg?: string) => void;
  onGo: (step: string) => void;
  onSelectModel: (slug: string) => void;
}) {
  const [open, setOpen] = useState<string>(() => steps.find((s) => s.state === 'active' || s.state === 'waiting')?.id ?? 'concept');
  const [filter, setFilter] = useState('');
  const current = steps.find((s) => s.state === 'active' || s.state === 'waiting') ?? null;
  const yours = scan.models.filter((m) => (stepsBySlug[m.slug] ?? []).some((s) => s.state === 'waiting'));
  const rows = useMemo(() => {
    const f = filter.trim().toLowerCase();
    return f ? REFERENCE.filter((r) => `${r.area} ${r.button} ${r.runs}`.toLowerCase().includes(f)) : REFERENCE;
  }, [filter]);

  return (
    <section className="a3d-help">
      <header className="a3d-row">
        <h1 style={{ margin: 0 }}>Help</h1>
        <span className="a3d-tabs-spacer" />
        <button type="button" className="a3d-btn" disabled={!scan.tools.helpStatus || statusBusy} onClick={onStatus}
          title={scan.tools.helpStatus ? describeStatus(scan) : 'ai3d-help is not installed: update the module'}>{statusBusy ? 'Reading…' : 'Status of all models (no agent)'}</button>
        <button type="button" className="a3d-btn" disabled={busy} onClick={() => onAsk('*next', model?.slug)} title="Starts an agent session: ai3d-help *next">Ask Compass: what next?</button>
      </header>

      {model && (
        <div className="a3d-next">
          <strong>{model.meta.title || model.slug}{model.branches.length > 1 ? ` · branch ${model.branch}` : ''}</strong>
          {current ? <>
            <span>Step {current.n} of 7, {current.title} — {current.state === 'waiting' ? 'your turn' : 'next: agent'}</span>
            <span>{current.hint}</span>
            {current.primary && <span className="a3d-muted a3d-small">Button: “{current.primary.label}” · {describe(current.primary, scan, model)}</span>}
            <span className="a3d-row"><button type="button" className="a3d-btn a3d-btn-small a3d-btn-primary" onClick={() => onGo(current.id)}>Go to this step</button>
              <button type="button" className="a3d-btn a3d-btn-small" onClick={() => setOpen(current.id)}>Tips for it</button></span>
          </> : <span>All seven steps are done in this branch.</span>}
        </div>
      )}

      {(() => {
        const checks = healthChecks(scan, blender);
        const bad = checks.filter((c) => c.state !== 'ok');
        return (
          <details className="a3d-health" open={bad.some((c) => c.name === 'AI3D Forge skills' || c.state === 'missing')}>
            <summary><h2 style={{ display: 'inline' }}>Setup check</h2> <span className={bad.length ? 'a3d-tag a3d-tag-waiting' : 'a3d-pill a3d-pill-done'}>{bad.length ? `${bad.length} to look at` : 'all good'}</span></summary>
            <table>
              <tbody>{checks.map((c) => (
                <tr key={c.name}>
                  <td><span className={`a3d-hc a3d-hc-${c.state}`}>{c.state === 'ok' ? '✓' : c.state === 'warn' ? '!' : '✗'}</span> {c.name}</td>
                  <td>{c.detail}{c.state !== 'ok' && c.fix ? <div className="a3d-muted a3d-small">{c.fix}</div> : null}</td>
                </tr>
              ))}</tbody>
            </table>
          </details>
        );
      })()}

      {yours.length > 0 && (
        <section>
          <h2>Your turn ({yours.length})</h2>
          <ul>{yours.map((m) => {
            const s = (stepsBySlug[m.slug] ?? []).find((x) => x.state === 'waiting');
            return <li key={m.slug}><button type="button" className="a3d-link" onClick={() => onSelectModel(m.slug)}>{m.meta.title || m.slug}</button> — {s?.title}: {s?.hint}</li>;
          })}</ul>
        </section>
      )}

      {statusText && (
        <section>
          <h2>Status report</h2>
          <pre className="a3d-cmd">{statusText}</pre>
        </section>
      )}

      <section>
        <h2>Step guide</h2>
        <p className="a3d-row" role="tablist">
          {STEP_LIST.map(([id, label]) => (
            <button key={id} type="button" role="tab" aria-selected={open === id} className="a3d-btn a3d-btn-small" aria-pressed={open === id} onClick={() => setOpen(id)}>{label}</button>
          ))}
          <span className="a3d-tabs-spacer" />
          {open !== 'branches' && open !== 'runs' && <button type="button" className="a3d-btn a3d-btn-small" disabled={busy} onClick={() => onAsk('*tips', open)} title="Starts an agent session: ai3d-help *tips with your print lessons">Ask Compass about this step</button>}
        </p>
        <StepTips tips={tips} step={open} />
      </section>

      <section>
        <h2>What each button runs</h2>
        <p className="a3d-muted">Agent buttons start a new session with a prompt (open “Run command…” on a step to see it in full). Script buttons run the
          shell command shown. <code>&lt;skills&gt;</code> is where the module is installed, usually <code>.claude/skills</code>.</p>
        <input className="a3d-in-grow" aria-label="Filter commands" placeholder="Filter: blender, branch, README…" value={filter} onChange={(e) => setFilter(e.target.value)} />
        <table>
          <thead><tr><th>Where</th><th>Button</th><th>Kind</th><th>Runs</th></tr></thead>
          <tbody>{rows.map((r, i) => <tr key={i}><td>{r.area}</td><td>{r.button}</td><td>{r.kind}</td><td><code>{r.runs}</code></td></tr>)}</tbody>
        </table>
      </section>
    </section>
  );
}

function describeStatus(scan: Scan) {
  return `Runs: python3 ${scan.tools.helpStatus} ${scan.workspace}`;
}
