import { useMemo, useState } from 'react';
import { agentPrompt, isAttempt, type AgentAction, type StepView } from './flow';
import { STEP_AGENT } from './commands';
import { StepTips } from './Tips';
import type { FlowNode, Model, Scan } from './types';
import { RunPicker } from './RunPicker';
import { defaultRun, type RunChoice } from './runSettings';

export interface RunRequest {
  action: AgentAction;
  /** Your instruction: the attempt's description for an attempt, else added to the prompt. */
  instruction: string;
  run: RunChoice;
}

/** Pick any agent command of a step, add your own instruction and see the exact prompt before it runs. */
export function RunCommandDialog({ model, scan, step, initial, tips, busy, onCancel, onRun }: {
  model: Model;
  scan: Scan;
  step: StepView;
  initial?: AgentAction | null;
  tips: Record<string, string>;
  busy: boolean;
  onCancel: () => void;
  onRun: (r: RunRequest) => void;
}) {
  const list = STEP_AGENT[step.id] ?? [];
  const start = initial ? Math.max(0, list.findIndex((x) => x.skill === initial.skill && x.trigger === initial.trigger)) : 0;
  const [choice, setChoice] = useState(start);
  const [text, setText] = useState('');
  const [showTips, setShowTips] = useState(false);
  const [run, setRun] = useState<RunChoice | null>(null);
  const action = list[choice] ?? initial ?? null;
  const attempt = action ? isAttempt(action) : false;
  const runChoice = run ?? (action ? defaultRun(scan.config, step.id, action.skill, action.trigger) : { model: '', effort: 'medium' as const });

  const preview = useMemo(() => {
    if (!action) return '';
    const fake: FlowNode | null = attempt ? {
      id: '<new node id>', step: step.id, agent: '', label: '', parent: null, status: 'running', verdict: null, created_at: '', finished_at: null,
      settings: {}, description: text.trim(), outcome: '', files: [], branch: model.branch,
    } : null;
    return agentPrompt(action, model, scan, attempt ? undefined : text.trim() || undefined, fake ? { node: fake, flowLog: scan.tools.flowLog } : undefined, runChoice.effort);
  }, [action, attempt, model, scan, step.id, text, runChoice.effort]);

  return (
    <div className="a3d-overlay" onClick={onCancel}>
      <form className="a3d-dialog a3d-dialog-wide" onClick={(e) => e.stopPropagation()}
        onSubmit={(e) => { e.preventDefault(); if (action) onRun({ action, instruction: text.trim(), run: runChoice }); }}>
        <h3>Run command · {step.title}{model.branches.length > 1 ? ` · branch ${model.branch}` : ''}</h3>
        <label>Command
          <select value={choice} onChange={(e) => setChoice(Number(e.target.value))}>
            {list.map((x, i) => <option key={x.trigger} value={i}>{x.label} — {x.skill} {x.trigger}</option>)}
          </select>
        </label>
        <label>Your instruction for the agent (optional)
          <textarea rows={3} autoFocus value={text} onChange={(e) => setText(e.target.value)}
            placeholder={step.id === 'blender' ? 'For example: base 3 mm thicker, keep the tail on the bed, overhang under 8 %.' : step.id === 'image' ? 'For example: three-quarter view, legs apart, no shadow on the ground.' : 'What to do differently or what to watch for.'} />
        </label>
        <p className="a3d-muted a3d-small">
          {attempt ? 'This command makes a new attempt (a box in the graph); your instruction is saved as its description.' : 'Your instruction is added to the prompt; this command does not make a new attempt.'}
          {' '}<button type="button" className="a3d-link" onClick={() => setShowTips((v) => !v)}>{showTips ? 'Hide tips' : 'Tips for this step'}</button>
        </p>
        {showTips && <StepTips tips={tips} step={step.id} />}
        <RunPicker value={runChoice} onChange={setRun} />
        <details>
          <summary>Prompt sent to the agent session</summary>
          <pre className="a3d-cmd">{preview}</pre>
        </details>
        <span className="a3d-row a3d-row-end">
          <button type="button" className="a3d-btn" onClick={onCancel}>Cancel</button>
          <button type="submit" className="a3d-btn a3d-btn-primary" disabled={busy || !action}>Run: {action?.label}</button>
        </span>
      </form>
    </div>
  );
}
