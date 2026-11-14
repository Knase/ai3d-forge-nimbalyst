import { useMemo, useState } from 'react';
import { ATTEMPT_CHOICES, agentPrompt, type AgentAction } from './flow';
import type { FlowNode, Model, Scan } from './types';
import { nodeBranch } from './branches';
import { stepIndex } from './flowGraph';
import { RunPicker } from './RunPicker';
import type { Effort, RunChoice } from './runSettings';
import { INTERNAL_KEYS, QUICK_NOTES, STEP_OPTIONS } from './stepOptions';

export interface AttemptRequest {
  step: string;
  parent: string | null;
  settings: Record<string, string>;
  description: string;
  /** Model and reasoning for this run (default: the step's setting). */
  run?: RunChoice;
}

/**
 * A new attempt at a step: say what should be different, pick the options to change, run.
 * Everything else (where it continues from, model, reasoning, the prompt) is under "More".
 */
export function AttemptDialog({ model, scan, stepTitle, initial, busy, onCancel, onRun, onBranch, defaultRun }: {
  model: Model;
  scan: Scan;
  stepTitle: (id: string) => string;
  initial: AttemptRequest;
  busy: boolean;
  onCancel: () => void;
  onRun: (action: AgentAction, req: AttemptRequest) => void;
  /** Open "New branch" instead (another picture, link or mesh). */
  onBranch: () => void;
  defaultRun: RunChoice;
}) {
  const options = STEP_OPTIONS[initial.step] ?? [];
  const known = new Set(options.map((o) => o.key));
  const start = Object.entries(initial.settings).filter(([k]) => !INTERNAL_KEYS.has(k));
  const [values, setValues] = useState<Record<string, string>>(Object.fromEntries(start.filter(([k]) => known.has(k))));
  const [custom, setCustom] = useState<[string, string][]>(start.filter(([k]) => !known.has(k)));
  const [description, setDescription] = useState(initial.description);
  const [parent, setParent] = useState<string>(initial.parent ?? '');
  const prior = initial.settings.run_model !== undefined
    ? { model: initial.settings.run_model === 'default' ? '' : `claude-code:${initial.settings.run_model}`, effort: (initial.settings.run_effort as Effort) || defaultRun.effort }
    : null;
  const [run, setRun] = useState<RunChoice>(initial.run ?? prior ?? defaultRun);
  const choices = ATTEMPT_CHOICES[initial.step] ?? [];
  const [choice, setChoice] = useState(0);
  const idx = stepIndex(initial.step);
  const candidates = model.flow.nodes.filter((n) => stepIndex(n.step) <= idx && !n.archived);
  const parentNode = model.flow.nodes.find((n) => n.id === parent) ?? null;
  const quick = QUICK_NOTES[initial.step] ?? [];

  const settings = useMemo(() => {
    const out: Record<string, string> = {};
    for (const o of options) if ((values[o.key] ?? '').trim()) out[o.key] = values[o.key].trim();
    for (const [k, v] of custom) if (k.trim() && v.trim()) out[k.trim()] = v.trim();
    return out;
  }, [options, values, custom]);
  const chosen = Object.entries(settings);
  const set = (k: string, v: string) => setValues((x) => ({ ...x, [k]: v }));
  const setRow = (i: number, j: 0 | 1, v: string) => setCustom((r) => r.map((row, k) => (k === i ? (j === 0 ? [v, row[1]] : [row[0], v]) : row) as [string, string]));

  const preview = useMemo(() => {
    const a = choices[choice];
    if (!a) return '';
    const fake: FlowNode = { id: '<new node id>', step: initial.step, agent: '', label: '', parent: parent || null, status: 'running', verdict: null,
      created_at: '', finished_at: null, settings, description: description.trim(), outcome: '', files: [], branch: model.branch };
    return agentPrompt(a, model, scan, undefined, { node: fake, flowLog: scan.tools.flowLog }, run.effort);
  }, [choices, choice, initial.step, parent, settings, description, model, scan, run.effort]);

  const submit = () => onRun(choices[choice], { step: initial.step, parent: parent || null, settings, description: description.trim(), run });
  const nothing = !description.trim() && chosen.length === 0;

  return (
    <div className="a3d-overlay" onClick={onCancel}>
      <form className="a3d-dialog a3d-dialog-wide a3d-attempt" onClick={(e) => e.stopPropagation()} onSubmit={(e) => { e.preventDefault(); submit(); }}>
        <header>
          <h3>Try the {stepTitle(initial.step)} step again</h3>
          <p className="a3d-muted">A new try next to the earlier ones{model.branches.length > 1 ? ` in branch ${model.branch}` : ''}; nothing is overwritten.
            {parentNode ? <> Continues from <strong>{parentNode.label}</strong>.</> : null}</p>
        </header>

        {choices.length > 1 && (
          <label>What to run
            <select value={choice} onChange={(e) => setChoice(Number(e.target.value))}>
              {choices.map((x, i) => <option key={x.trigger} value={i}>{x.label}</option>)}
            </select>
          </label>
        )}

        <section className="a3d-attempt-sec">
          <label htmlFor="a3d-attempt-what"><strong>1 · What should be different this time?</strong></label>
          <textarea id="a3d-attempt-what" rows={3} autoFocus value={description} onChange={(e) => setDescription(e.target.value)}
            placeholder="In your own words. The agent reads it first, and it stays on the attempt as its description." />
          {quick.length > 0 && (
            <span className="a3d-row">{quick.map((q) => (
              <button key={q} type="button" className="a3d-chipbtn" onClick={() => setDescription((d) => (d.trim() ? `${d.trim().replace(/[.;]$/, '')}; ${q.charAt(0).toLowerCase()}${q.slice(1)}` : q))}>+ {q}</button>
            ))}</span>
          )}
        </section>

        {options.length > 0 && (
          <section className="a3d-attempt-sec">
            <strong>2 · Options to change</strong>
            <p className="a3d-muted a3d-small">Leave an option on “agent decides” to keep what the agent would pick. A chosen option is passed as “use exactly this” and saved on the attempt.</p>
            <div className="a3d-optgrid">
              {options.map((o) => (
                <label key={o.key} className={values[o.key] ? 'a3d-opt a3d-opt-set' : 'a3d-opt'} title={o.help}>
                  <span>{o.label}{o.unit ? <span className="a3d-muted"> ({o.unit})</span> : null}</span>
                  {o.kind === 'choice' ? (
                    <select value={values[o.key] ?? ''} onChange={(e) => set(o.key, e.target.value)}>
                      <option value="">agent decides</option>
                      {(o.choices!.some((x) => x.value === values[o.key]) || !values[o.key] ? o.choices! : [...o.choices!, { value: values[o.key], label: values[o.key] }]).map((x) => <option key={x.value} value={x.value}>{x.label}</option>)}
                    </select>
                  ) : (
                    <input type={o.kind === 'number' ? 'number' : 'text'} min={o.min} max={o.max} step={o.step} value={values[o.key] ?? ''} onChange={(e) => set(o.key, e.target.value)}
                      placeholder={o.kind === 'number' ? `agent decides (e.g. ${o.placeholder})` : o.placeholder} />
                  )}
                  {o.help && <span className="a3d-muted a3d-small">{o.help}</span>}
                </label>
              ))}
            </div>
          </section>
        )}

        {(initial.step === 'image' || initial.step === 'mesh') && (
          <p className="a3d-muted a3d-small">Another picture, a link or a ready 3D file instead of other options?{' '}
            <button type="button" className="a3d-link" onClick={onBranch}>Start a branch with it</button> — it gets its own files to the end.</p>
        )}

        <details className="a3d-attempt-more">
          <summary>More: continues from, model and reasoning, own option, the prompt</summary>
          <label>Continues from
            <select value={parent} onChange={(e) => setParent(e.target.value)}>
              <option value="">Nothing (start of this line)</option>
              {candidates.map((n) => <option key={n.id} value={n.id}>{model.branches.length > 1 ? `[${nodeBranch(n)}] ` : ''}{stepTitle(n.step)} · {n.label}{n.verdict ? ` (${n.verdict})` : ''}</option>)}
            </select>
            <span className="a3d-muted a3d-small">The earlier try this one builds on. It only draws the arrow in the graph and tells the agent what to start from.</span>
          </label>
          <RunPicker value={run} onChange={setRun} />
          <fieldset className="a3d-fields">
            <legend>Own option</legend>
            <p className="a3d-muted a3d-small">For something the list does not have: a name and a value, passed to the agent as it is (for example <code>pose = sitting</code>).</p>
            {custom.map(([k, v], i) => (
              <div className="a3d-kvrow" key={i}>
                <input aria-label="Option name" placeholder="name" value={k} onChange={(e) => setRow(i, 0, e.target.value)} />
                <input aria-label="Option value" placeholder="value" value={v} onChange={(e) => setRow(i, 1, e.target.value)} />
                <button type="button" className="a3d-btn a3d-btn-small" aria-label="Remove option" onClick={() => setCustom((r) => r.filter((_, k2) => k2 !== i))}>×</button>
              </div>
            ))}
            <button type="button" className="a3d-btn a3d-btn-small" onClick={() => setCustom((r) => [...r, ['', '']])}>+ Add own option</button>
          </fieldset>
          <details>
            <summary>Prompt sent to the agent session</summary>
            <pre className="a3d-cmd">{preview}</pre>
          </details>
        </details>

        <footer className="a3d-attempt-foot">
          <span className="a3d-muted a3d-small">
            {chosen.length ? <>Changed: {chosen.map(([k, v]) => <span key={k} className="a3d-pill">{k} = {v}</span>)}</> : nothing ? 'Nothing changed yet: the agent would repeat the step with its defaults.' : 'No options changed; the agent follows your text.'}
          </span>
          <span className="a3d-row a3d-row-end">
            <button type="button" className="a3d-btn" onClick={onCancel}>Cancel</button>
            <button type="submit" className="a3d-btn a3d-btn-primary" disabled={busy || !choices.length}>Run: {choices[choice]?.label}</button>
          </span>
        </footer>
      </form>
    </div>
  );
}
