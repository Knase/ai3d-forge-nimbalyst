import { useState } from 'react';
import type { Model, FlowNode } from './types';
import type { StepView } from './flow';
import { STEP_IDS } from './flow';
import { headNode, lineage, place, settingsLine, stepIndex } from './flowGraph';
import { laneIndex, nodeBranch } from './branches';

const NODE_W = 172;
const NODE_H = 58;
const GAP_X = 22;
const ROW_H = 80;
const LEFT = 132;
const TOP = 10;
const LANE_H = 34;

const cut = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const STATE_WORD: Record<string, string> = { done: 'done', active: 'next', waiting: 'your turn', locked: 'locked' };
const STATUS_WORD: Record<string, string> = { running: 'running', open: 'waiting', done: 'done', error: 'failed' };
const GLYPH: Record<string, string> = { running: '', open: '', done: '✓', error: '!' };

export function FlowGraph({ model, steps, selectedNode, selectedStep, compare, showArchived, onSelectNode, onSelectStep, onNew, onSelectBranch }: {
  model: Model;
  steps: StepView[];
  selectedNode: string | null;
  selectedStep: string | null;
  onSelectNode: (id: string) => void;
  onSelectStep: (id: string) => void;
  onNew: (step: string) => void;
  onSelectBranch: (id: string) => void;
  compare: string[];
  showArchived: boolean;
}) {
  const all = visibleNodes(model.flow.nodes, showArchived);
  // one lane per branch, in the model's fixed order; archived branches only when asked for
  const lanes = model.branches.filter((b) => showArchived || b.status !== 'archived' || b.id === model.branch);
  const laneIds = new Set(lanes.map((b) => b.id));
  const nodes = all.filter((n) => laneIds.has(nodeBranch(n)));
  const multi = lanes.length > 1;
  const head = headNode(nodes.filter((n) => nodeBranch(n) === model.branch));
  const line = lineage(nodes, head?.id ?? null);
  const top = TOP + (multi ? LANE_H : 0);

  type Spot = { x: number; y: number; row: number; lane: string };
  const pos = new Map<string, Spot>();
  const laneBox: { id: string; x: number; w: number; slots: number[]; color: number }[] = [];
  let x0 = LEFT;
  for (const b of lanes) {
    const own = nodes.filter((n) => nodeBranch(n) === b.id);
    const { placed, slots } = place(own);
    const cols = Math.max(1, ...slots) + (b.id === model.branch ? 1 : 0);
    for (const p of placed) {
      pos.set(p.node.id, { x: x0 + p.slot * (NODE_W + GAP_X), y: top + p.row * ROW_H + (ROW_H - NODE_H) / 2, row: p.row, lane: b.id });
    }
    const w = cols * (NODE_W + GAP_X) - GAP_X + (multi ? 16 : 0);
    laneBox.push({ id: b.id, x: x0 - (multi ? 8 : 0), w, slots, color: laneIndex(model, b.id) });
    x0 += w + (multi ? GAP_X + 8 : GAP_X);
  }
  const width = Math.max(x0, LEFT + 2 * (NODE_W + GAP_X));
  const height = top + STEP_IDS.length * ROW_H;

  const edges = nodes.filter((n) => n.parent && pos.has(n.parent) && pos.has(n.id)).map((n) => {
    const a = pos.get(n.parent!)!;
    const b = pos.get(n.id)!;
    let d: string;
    if (a.row === b.row) {
      const y = a.y + NODE_H / 2;
      d = a.x < b.x ? `M${a.x + NODE_W},${y} L${b.x},${y}` : `M${a.x},${y} L${b.x + NODE_W},${y}`;
    } else {
      const x1 = a.x + NODE_W / 2, y1 = a.y + NODE_H, x2 = b.x + NODE_W / 2, y2 = b.y;
      const my = (y1 + y2) / 2;
      d = `M${x1},${y1} C${x1},${my} ${x2},${my} ${x2},${y2}`;
    }
    return { id: `${n.parent}>${n.id}`, d, on: line.has(n.id) && line.has(n.parent!), cross: a.lane !== b.lane };
  });

  return (
    <section className="a3d-graph" aria-label="Flow graph">
      <div className="a3d-graph-scroll">
        <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} role="group" aria-label={`Flow of ${model.meta.title || model.slug}`}>
          <defs>
            <marker id="a3d-arrow" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
              <path d="M0,0 L8,4 L0,8 z" className="a3d-g-arrow" />
            </marker>
          </defs>

          {STEP_IDS.map((id, i) => {
            const s = steps.find((x) => x.id === id);
            const y = top + i * ROW_H;
            const here = s?.state === 'active' || s?.state === 'waiting';
            return (
              <g key={id} className={`a3d-g-row a3d-g-${s?.state ?? 'locked'}${selectedStep === id ? ' a3d-g-rowsel' : ''}`}>
                <rect x={0} y={y} width={width} height={ROW_H} className={i % 2 ? 'a3d-g-band a3d-g-band2' : 'a3d-g-band'} />
                <g tabIndex={0} role="button" aria-label={`Step ${i + 1} ${s?.title ?? id}, ${STATE_WORD[s?.state ?? 'locked']}`}
                  onClick={() => onSelectStep(id)} onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onSelectStep(id); } }}
                  className="a3d-g-label">
                  <rect x={4} y={y + 6} width={LEFT - 12} height={ROW_H - 12} rx={6} className="a3d-g-labelbg" />
                  <text x={14} y={y + 28} className="a3d-g-steptitle">{here ? '▶ ' : ''}{i + 1} · {s?.title ?? id}</text>
                  <text x={14} y={y + 45} className="a3d-g-stepsub">{s?.agent} · {STATE_WORD[s?.state ?? 'locked']}</text>
                </g>
              </g>
            );
          })}

          {multi && laneBox.map((l) => {
            const b = model.branches.find((x) => x.id === l.id)!;
            const sel = l.id === model.branch;
            return (
              <g key={`lane-${l.id}`} className={`a3d-g-lane a3d-lane-c${l.color % 8}${sel ? ' a3d-g-lanesel' : ''}`}>
                <rect x={l.x} y={TOP} width={l.w} height={height - TOP} rx={8} className="a3d-g-lanebg" />
                <g tabIndex={0} role="button" aria-pressed={sel} aria-label={`Branch ${b.name}${b.primary ? ', primary' : ''}${b.status !== 'open' ? `, ${b.status}` : ''}`}
                  onClick={() => onSelectBranch(l.id)} onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onSelectBranch(l.id); } }}>
                  <title>{[`Branch ${b.name}`, b.source ? `from ${b.source.kind}: ${b.source.ref}` : null, b.from_step !== 'concept' ? `starts at ${b.from_step}` : null, b.description].filter(Boolean).join('\n')}</title>
                  <rect x={l.x} y={TOP} width={l.w} height={LANE_H - 6} rx={8} className="a3d-g-lanehead" />
                  <circle cx={l.x + 14} cy={TOP + (LANE_H - 6) / 2} r={5} className="a3d-g-lanedot" />
                  <text x={l.x + 26} y={TOP + (LANE_H - 6) / 2 + 4} className="a3d-g-lanename">
                    {cut(b.name, Math.max(8, Math.floor(l.w / 8) - 12))}{b.primary ? ' ★' : ''}{b.status !== 'open' ? ` · ${b.status}` : ''}
                  </text>
                </g>
              </g>
            );
          })}

          {edges.map((e) => (
            <path key={e.id} d={e.d} className={['a3d-g-edge', e.on ? 'a3d-g-edge-on' : '', e.cross ? 'a3d-g-edge-cross' : ''].filter(Boolean).join(' ')} markerEnd="url(#a3d-arrow)" />
          ))}

          {nodes.filter((n) => pos.has(n.id)).map((n) => {
            const { x, y, lane } = pos.get(n.id)!;
            const sel = selectedNode === n.id;
            const on = line.has(n.id);
            const sub = settingsLine(n);
            const third = n.outcome || n.description;
            const cls = ['a3d-g-node', lane !== model.branch ? 'a3d-g-otherlane' : '', compare.includes(n.id) ? 'a3d-g-cmp' : '', n.archived ? 'a3d-g-archived' : '', `a3d-gs-${n.status}`, n.verdict ? `a3d-gv-${n.verdict}` : '', n.inferred ? 'a3d-g-inferred' : '', on ? 'a3d-g-on' : '', sel ? 'a3d-g-sel' : ''].filter(Boolean).join(' ');
            return (
              <g key={n.id} className={cls} transform={`translate(${x},${y})`} tabIndex={0} role="button"
                aria-label={`${n.label}, ${STATUS_WORD[n.status]}${n.verdict ? ', ' + n.verdict : ''}${multi ? `, branch ${lane}` : ''}${head?.id === n.id ? ', current' : ''}`}
                onClick={() => onSelectNode(n.id)} onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onSelectNode(n.id); } }}>
                <title>{[n.label, `${STATUS_WORD[n.status]}${n.verdict ? ` · ${n.verdict}` : ''}${n.inferred ? ' · rebuilt from files' : ''}`, multi ? `branch: ${lane}` : '', sub, n.description, n.outcome].filter(Boolean).join('\n')}</title>
                <rect width={NODE_W} height={NODE_H} rx={8} className="a3d-g-box" />
                <circle cx={14} cy={16} r={7} className="a3d-g-dot" />
                {GLYPH[n.status] && <text x={14} y={19.5} className="a3d-g-dotglyph" textAnchor="middle">{GLYPH[n.status]}</text>}
                <text x={28} y={20} className="a3d-g-label1">{cut(n.label, n.verdict ? 17 : 19)}</text>
                {n.verdict && <text x={NODE_W - 10} y={20} textAnchor="end" className="a3d-g-verdict">{n.verdict === 'accepted' ? '✓' : '✗'}</text>}
                <text x={10} y={36} className="a3d-g-line2">{cut(sub || STATUS_WORD[n.status], 26)}</text>
                <text x={10} y={50} className="a3d-g-line3">{cut(third, 26)}</text>
                {compare.includes(n.id) && <text x={NODE_W - 10} y={NODE_H - 6} textAnchor="end" className="a3d-g-cmpmark">{compare.indexOf(n.id) === 0 ? 'A' : 'B'}</text>}
                {(n.notes?.length ?? 0) > 0 && <text x={NODE_W - 28} y={20} textAnchor="end" className="a3d-g-notemark">✎</text>}
                {head?.id === n.id && <text x={NODE_W - 8} y={-4} textAnchor="end" className="a3d-g-here">you are here</text>}
              </g>
            );
          })}

          {(() => {
            const l = laneBox.find((x) => x.id === model.branch);
            if (!l) return null;
            const b0 = l.x + (multi ? 8 : 0);
            return STEP_IDS.map((id, i) => {
              const s = steps.find((x) => x.id === id);
              if (!s || s.state === 'locked' && !l.slots[i]) return null;
              const cb = model.branches.find((x) => x.id === model.branch);
              if (cb && cb.id !== 'main' && i < Math.max(0, STEP_IDS.indexOf(cb.from_step as (typeof STEP_IDS)[number]))) return null;
              const x = b0 + l.slots[i] * (NODE_W + GAP_X);
              const y = top + i * ROW_H + (ROW_H - NODE_H) / 2;
              return (
                <g key={`new-${id}`} className="a3d-g-new" transform={`translate(${x},${y})`} tabIndex={0} role="button" aria-label={`New attempt on ${s.title}`}
                  onClick={() => onNew(id)} onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onNew(id); } }}>
                  <title>New attempt on {s.title} in this branch, with its own settings and description</title>
                  <rect width={NODE_W - 40} height={NODE_H} rx={8} className="a3d-g-newbox" />
                  <text x={(NODE_W - 40) / 2} y={NODE_H / 2 + 5} textAnchor="middle" className="a3d-g-newtext">+ New attempt</text>
                </g>
              );
            });
          })()}
        </svg>
      </div>
      <p className="a3d-graph-legend a3d-muted">
        Rows are the steps, each box is one attempt.{multi ? ' Each column is a branch with its own files; click its header to work in it (★ primary).' : ''} Blue line: the path of
        the selected branch. ✓ accepted, ✗ rejected, dashed box: an attempt you left. Grey box: rebuilt from files. Ring: waiting for you.
        Pulsing: running. ✎ has notes. A / B: picked for comparison.
      </p>
    </section>
  );
}

/** Nodes without archived branches (an archived node hides its whole subtree). */
export function visibleNodes(nodes: FlowNode[], showArchived: boolean) {
  if (showArchived) return nodes;
  const hidden = new Set(nodes.filter((n) => n.archived).map((n) => n.id));
  let grew = true;
  while (grew) {
    grew = false;
    for (const n of nodes) if (!hidden.has(n.id) && n.parent && hidden.has(n.parent)) { hidden.add(n.id); grew = true; }
  }
  return nodes.filter((n) => !hidden.has(n.id));
}

const fmt = (iso: string) => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
};

export function NodeDetail({ model, node, busy, canEdit, inCompare, onSelectNode, onRerun, onNext, onBranch, onVerdict, onOpen, onFiles, onCompare, onArchive, onNote, onCost }: {
  model: Model;
  node: FlowNode;
  busy: boolean;
  canEdit: boolean;
  onSelectNode: (id: string) => void;
  onRerun: (n: FlowNode) => void;
  onNext: (n: FlowNode) => void;
  onBranch: (n: FlowNode) => void;
  onVerdict: (n: FlowNode, v: 'accepted' | 'rejected' | 'none') => void;
  onOpen: (relPath: string) => void;
  onFiles: (n: FlowNode) => void;
  inCompare: boolean;
  onCompare: (n: FlowNode) => void;
  onArchive: (n: FlowNode, archived: boolean) => void;
  onNote: (n: FlowNode, text: string) => void;
  onCost: (n: FlowNode, service: string, credits: string) => void;
}) {
  const [noteText, setNoteText] = useState('');
  const [svc, setSvc] = useState(node.cost?.service ?? '');
  const [cr, setCr] = useState(node.cost ? String(node.cost.credits) : '');
  const parent = node.parent ? model.flow.nodes.find((n) => n.id === node.parent) : null;
  const children = model.flow.nodes.filter((n) => n.parent === node.id);
  const nextStep = STEP_IDS[stepIndex(node.step) + 1];
  const kv = Object.entries(node.settings);
  return (
    <section className="a3d-node-detail">
      <header>
        <div>
          <h3>{node.label} <span className={`a3d-pill a3d-pill-${node.status}`}>{STATUS_WORD[node.status]}</span>
            {node.verdict && <span className={`a3d-pill a3d-pill-${node.verdict}`}>{node.verdict}</span>}
            {node.inferred && <span className="a3d-pill">rebuilt from files</span>}</h3>
          <p className="a3d-muted">{node.step} · {node.agent}{model.branches.length > 1 ? ` · branch ${node.branch ?? 'main'}` : ''} · {fmt(node.created_at)}{node.finished_at ? ` → ${fmt(node.finished_at)}` : ''}</p>
        </div>
        <span className="a3d-row">
          <button type="button" className="a3d-btn" aria-pressed={inCompare} onClick={() => onCompare(node)} title="Pick two attempts of the same step and compare them">{inCompare ? 'In comparison' : 'Compare'}</button>
          {node.files.length > 0 && <button type="button" className="a3d-btn" onClick={() => onFiles(node)} title="Open the Files tab with only this attempt's files">Show files</button>}
          <button type="button" className="a3d-btn" disabled={busy} onClick={() => onRerun(node)}
            title="Same step again, with the settings of this attempt as a starting point">Run again with changes…</button>
          {nextStep && <button type="button" className="a3d-btn" disabled={busy} onClick={() => onNext(node)}
            title="Run the next step on this attempt, in the same branch">Continue from here…</button>}
          {canEdit && <button type="button" className="a3d-btn" disabled={busy} onClick={() => onBranch(node)}
            title="A separate line with its own files from here to the end: another image, link, mesh, or other settings">New branch from here…</button>}
        </span>
      </header>
      <dl className="a3d-node-grid">
        <dt>Settings</dt>
        <dd>{kv.length ? <ul className="a3d-kv">{kv.map(([k, v]) => <li key={k}><code>{k}</code> {v}</li>)}</ul> : <span className="a3d-muted">none recorded</span>}</dd>
        <dt>Description</dt>
        <dd>{node.description || <span className="a3d-muted">none</span>}</dd>
        <dt>Outcome</dt>
        <dd>{node.outcome || <span className="a3d-muted">not recorded yet</span>}</dd>
        {node.files.length > 0 && <>
          <dt>Files</dt>
          <dd><ul className="a3d-kv">{node.files.map((f) => <li key={f}><button type="button" className="a3d-link" onClick={() => onOpen(f)}>{f}</button></li>)}</ul></dd>
        </>}
        <dt>Cost</dt>
        <dd>
          {canEdit && !node.inferred ? (
            <span className="a3d-row">
              <input className="a3d-in-small" aria-label="Service" list="a3d-services" placeholder="service" value={svc} onChange={(e) => setSvc(e.target.value)} />
              <input className="a3d-in-small" aria-label="Credits" type="number" min="0" step="any" placeholder="credits" value={cr} onChange={(e) => setCr(e.target.value)} />
              <button type="button" className="a3d-btn a3d-btn-small" disabled={!svc.trim() || cr === '' || (node.cost?.service === svc && String(node.cost?.credits) === cr)} onClick={() => onCost(node, svc.trim(), cr)}>Save</button>
              <datalist id="a3d-services"><option value="tripo3d" /><option value="gemini" /><option value="meshy" /><option value="rodin" /><option value="apify" /><option value="usd" /></datalist>
            </span>
          ) : node.cost ? `${node.cost.credits} ${node.cost.service}` : <span className="a3d-muted">not recorded</span>}
        </dd>
        <dt>Notes</dt>
        <dd>
          {(node.notes ?? []).length > 0 && <ul className="a3d-notes">{node.notes!.map((x, n) => <li key={n}><span className="a3d-muted">{fmt(x.at)}</span> {x.text}</li>)}</ul>}
          {canEdit && (
            <form className="a3d-row" onSubmit={(e) => { e.preventDefault(); if (noteText.trim()) { onNote(node, noteText.trim()); setNoteText(''); } }}>
              <input className="a3d-in-grow" aria-label="New note" placeholder="Add a note: what you saw, what to try" value={noteText} onChange={(e) => setNoteText(e.target.value)} />
              <button type="submit" className="a3d-btn a3d-btn-small" disabled={!noteText.trim()}>Add</button>
            </form>
          )}
        </dd>
        <dt>Position</dt>
        <dd>
          {parent ? <>grows from <button type="button" className="a3d-link" onClick={() => onSelectNode(parent.id)}>{parent.label}</button></> : 'first attempt'}
          {children.length > 0 && <> · leads to {children.map((c, i) => <span key={c.id}>{i ? ', ' : ''}<button type="button" className="a3d-link" onClick={() => onSelectNode(c.id)}>{c.label}</button></span>)}</>}
        </dd>
      </dl>
      {canEdit && !node.inferred && (
        <p className="a3d-row">
          <span className="a3d-muted">Verdict</span>
          <button type="button" className="a3d-btn a3d-btn-small" aria-pressed={node.verdict === 'accepted'} onClick={() => onVerdict(node, 'accepted')}>Accepted</button>
          <button type="button" className="a3d-btn a3d-btn-small" aria-pressed={node.verdict === 'rejected'} onClick={() => onVerdict(node, 'rejected')}>Rejected</button>
          <button type="button" className="a3d-btn a3d-btn-small" disabled={!node.verdict} onClick={() => onVerdict(node, 'none')}>Clear</button>
          <span className="a3d-tabs-spacer" />
          <button type="button" className="a3d-btn a3d-btn-small" onClick={() => onArchive(node, !node.archived)}
            title={node.archived ? 'Show this attempt again' : 'Hide this attempt and everything that grew from it; nothing is deleted'}>{node.archived ? 'Unarchive attempt' : 'Archive attempt'}</button>
        </p>
      )}
    </section>
  );
}
