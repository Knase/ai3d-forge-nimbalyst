import { useState } from 'react';
import { ATTEMPT_CHOICES, SETTING_HINTS, type AgentAction } from './flow';
import type { Model } from './types';
import { stepIndex } from './flowGraph';

export interface AttemptRequest {
  step: string;
  parent: string | null;
  settings: Record<string, string>;
  description: string;
}

export function AttemptDialog({ model, stepTitle, initial, busy, onCancel, onRun }: {
  model: Model;
  stepTitle: (id: string) => string;
  initial: AttemptRequest;
  busy: boolean;
  onCancel: () => void;
  onRun: (action: AgentAction, req: AttemptRequest) => void;
}) {
  const [parent, setParent] = useState<string>(initial.parent ?? '');
  const [rows, setRows] = useState<[string, string][]>(Object.entries(initial.settings));
  const [description, setDescription] = useState(initial.description);
  const choices = ATTEMPT_CHOICES[initial.step] ?? [];
  const [choice, setChoice] = useState(0);
  const idx = stepIndex(initial.step);
  const candidates = model.flow.nodes.filter((n) => stepIndex(n.step) <= idx);
  const hints = SETTING_HINTS[initial.step] ?? [];

  const submit = () => {
    const settings: Record<string, string> = {};
    for (const [k, v] of rows) if (k.trim() && v.trim()) settings[k.trim()] = v.trim();
    onRun(choices[choice], { step: initial.step, parent: parent || null, settings, description: description.trim() });
  };
  const setRow = (i: number, j: 0 | 1, v: string) => setRows((r) => r.map((row, k) => (k === i ? (j === 0 ? [v, row[1]] : [row[0], v]) : row) as [string, string]));

  return (
    <div className="a3d-overlay" onClick={onCancel}>
      <form className="a3d-dialog a3d-dialog-wide" onClick={(e) => e.stopPropagation()} onSubmit={(e) => { e.preventDefault(); submit(); }}>
        <h3>New attempt · {stepTitle(initial.step)}</h3>
        <p className="a3d-muted">It becomes a new box in the flow graph. Earlier attempts stay as they are.</p>

        {choices.length > 1 && (
          <label>Action
            <select value={choice} onChange={(e) => setChoice(Number(e.target.value))}>
              {choices.map((c, i) => <option key={c.trigger} value={i}>{c.label}</option>)}
            </select>
          </label>
        )}

        <label>Grows from
          <select value={parent} onChange={(e) => setParent(e.target.value)}>
            <option value="">Nothing (start of this line)</option>
            {candidates.map((n) => <option key={n.id} value={n.id}>{stepTitle(n.step)} · {n.label}{n.verdict ? ` (${n.verdict})` : ''}</option>)}
          </select>
        </label>

        <fieldset className="a3d-fields">
          <legend>Settings for this attempt</legend>
          {rows.length === 0 && <p className="a3d-muted">No settings. The agent uses its defaults.</p>}
          {rows.map(([k, v], i) => (
            <div className="a3d-kvrow" key={i}>
              <input aria-label="Setting name" list={`a3d-keys-${initial.step}`} placeholder="name" value={k} onChange={(e) => setRow(i, 0, e.target.value)} />
              <input aria-label="Setting value" placeholder="value" value={v} onChange={(e) => setRow(i, 1, e.target.value)} />
              <button type="button" className="a3d-btn a3d-btn-small" aria-label="Remove setting" onClick={() => setRows((r) => r.filter((_, k) => k !== i))}>×</button>
            </div>
          ))}
          <datalist id={`a3d-keys-${initial.step}`}>{hints.map((h) => <option key={h} value={h} />)}</datalist>
          <button type="button" className="a3d-btn a3d-btn-small" onClick={() => setRows((r) => [...r, ['', '']])}>+ Add setting</button>
        </fieldset>

        <label>Description: what is different this time, and why
          <textarea rows={3} autoFocus value={description} onChange={(e) => setDescription(e.target.value)}
            placeholder={initial.step === 'mesh' ? 'Texture off and segmentation on, because the last mesh fused the wings.' : 'One or two lines. The agent reads it and it stays on the node.'} />
        </label>

        <span className="a3d-row a3d-row-end">
          <button type="button" className="a3d-btn" onClick={onCancel}>Cancel</button>
          <button type="submit" className="a3d-btn a3d-btn-primary" disabled={busy || !choices.length}>Run: {choices[choice]?.label}</button>
        </span>
      </form>
    </div>
  );
}

