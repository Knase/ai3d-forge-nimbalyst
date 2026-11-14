import { useState } from 'react';
import { STEP_IDS } from './flow';
import { nodeBranch } from './branches';
import { stepIndex } from './flowGraph';
import type { FlowNode, Model } from './types';

export type SourceKind = 'image' | 'link' | 'mesh' | 'text' | 'none';

export interface BranchRequest {
  name: string;
  fromNode: string | null;
  fromStep: string;
  kind: SourceKind;
  /** File path, URL or brief text, depending on kind. */
  ref: string;
  review: boolean;
  description: string;
}

const KINDS: { id: SourceKind; label: string; hint: string }[] = [
  { id: 'image', label: 'Another image', hint: 'A picture file. It is accepted at once (or put in inbox/ for Lumen to review); the branch goes on with the 3D mesh.' },
  { id: 'link', label: 'A link', hint: 'A model or picture you like (MakerWorld, Printables, Etsy, Pinterest…). Saved in refs/source.md; Lumen writes the image prompt from it.' },
  { id: 'mesh', label: 'A 3D file', hint: 'A mesh from another service or another run (GLB, OBJ, STL…). Saved as mesh/raw.*; Chisel reviews it.' },
  { id: 'text', label: 'A brief', hint: 'A change in words (other colour scheme, other pose, bigger). Saved in refs/source.md; the first step reads it.' },
  { id: 'none', label: 'Same inputs', hint: 'Copies everything up to the node and starts the next step with other settings, in its own folder.' },
];

/** Default start step: the same rule as flow_log.py branch add. */
export function startStep(kind: SourceKind, from: FlowNode | null) {
  if (kind === 'image' || kind === 'link' || kind === 'text') return 'image';
  if (kind === 'mesh') return 'mesh';
  if (from) return STEP_IDS[Math.min(stepIndex(from.step) + 1, STEP_IDS.length - 1)];
  return 'image';
}

export function NewBranchDialog({ model, from, stepTitle, busy, onPick, onCancel, onCreate }: {
  model: Model;
  from: FlowNode | null;
  stepTitle: (id: string) => string;
  busy: boolean;
  onPick: (kind: 'image' | 'mesh') => Promise<string[] | null>;
  onCancel: () => void;
  onCreate: (r: BranchRequest) => void;
}) {
  const [name, setName] = useState('');
  const [fromNode, setFromNode] = useState<string>(from?.id ?? '');
  const [kind, setKind] = useState<SourceKind>('image');
  const [ref, setRef] = useState('');
  const [review, setReview] = useState(false);
  const [description, setDescription] = useState('');
  const node = model.flow.nodes.find((n) => n.id === fromNode) ?? null;
  const [stepOverride, setStepOverride] = useState<string | null>(null);
  const fromStep = stepOverride ?? startStep(kind, node);
  const needsRef = kind !== 'none';
  const pickable = kind === 'image' || kind === 'mesh';
  const candidates = model.flow.nodes.filter((n) => !n.archived);
  const valid = name.trim() && (!needsRef || ref.trim()) && (kind !== 'link' || /^https?:\/\//i.test(ref.trim()));

  const pick = async () => {
    const r = await onPick(kind === 'mesh' ? 'mesh' : 'image');
    if (r && r[0]) setRef(r[0]);
  };

  return (
    <div className="a3d-overlay" onClick={onCancel}>
      <form className="a3d-dialog a3d-dialog-wide" onClick={(e) => e.stopPropagation()}
        onSubmit={(e) => { e.preventDefault(); if (valid) onCreate({ name: name.trim(), fromNode: fromNode || null, fromStep, kind, ref: ref.trim(), review, description: description.trim() }); }}>
        <h3>New branch · {model.meta.title || model.slug}</h3>
        <p className="a3d-muted">A branch is a separate line with its own folder (<code>branches/&lt;name&gt;/</code>). It copies what it needs from
          the branch it grows from and then goes through every step on its own, to its own print and README.</p>

        <label>Name
          <input autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="Red fox, Thicker base, Meshy try…" />
        </label>

        <fieldset className="a3d-fields">
          <legend>Start with</legend>
          <div className="a3d-row">
            {KINDS.map((k) => (
              <label key={k.id} className="a3d-check"><input type="radio" name="a3d-kind" checked={kind === k.id} onChange={() => { setKind(k.id); setRef(''); setStepOverride(null); }} /> {k.label}</label>
            ))}
          </div>
          <p className="a3d-muted a3d-small">{KINDS.find((k) => k.id === kind)?.hint}</p>
          {kind === 'text'
            ? <textarea rows={3} aria-label="Brief" value={ref} onChange={(e) => setRef(e.target.value)} placeholder="Same fox, but sitting, tail around the paws." />
            : needsRef && (
              <span className="a3d-row a3d-pathrow">
                <input className="a3d-in-grow" aria-label={kind === 'link' ? 'Link' : 'File path'} value={ref} onChange={(e) => setRef(e.target.value)}
                  placeholder={kind === 'link' ? 'https://makerworld.com/…' : '/Users/you/Downloads/picture.png'} />
                {pickable && <button type="button" className="a3d-btn a3d-btn-small" onClick={() => void pick()}>Choose…</button>}
              </span>
            )}
          {kind === 'image' && <label className="a3d-check"><input type="checkbox" checked={review} onChange={(e) => setReview(e.target.checked)} /> Put it in inbox/ for Lumen to review first</label>}
        </fieldset>

        <label>Grows from
          <select value={fromNode} onChange={(e) => { setFromNode(e.target.value); setStepOverride(null); }}>
            <option value="">Start of the model (copies the concept only)</option>
            {candidates.map((n) => <option key={n.id} value={n.id}>{model.branches.length > 1 ? `[${nodeBranch(n)}] ` : ''}{stepTitle(n.step)} · {n.label}{n.verdict ? ` (${n.verdict})` : ''}</option>)}
          </select>
        </label>

        <label>First step of the branch
          <select value={fromStep} onChange={(e) => setStepOverride(e.target.value)}>
            {STEP_IDS.filter((s) => s !== 'publish').map((s) => <option key={s} value={s}>{stepTitle(s)}</option>)}
          </select>
          <span className="a3d-muted a3d-small">Everything before it is copied from {node ? `branch ${nodeBranch(node)}` : 'main'}; this step and the ones after it are new.</span>
        </label>

        <label>Why this branch (optional)
          <input value={description} onChange={(e) => setDescription(e.target.value)} placeholder="Customer asked for a red version; try Meshy instead of Tripo…" />
        </label>

        <span className="a3d-row a3d-row-end">
          <button type="button" className="a3d-btn" onClick={onCancel}>Cancel</button>
          <button type="submit" className="a3d-btn a3d-btn-primary" disabled={busy || !valid}>Create branch</button>
        </span>
      </form>
    </div>
  );
}
