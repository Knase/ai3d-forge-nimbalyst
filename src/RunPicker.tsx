import { EFFORTS, MODELS, type Effort, type RunChoice } from './runSettings';

/** Model and reasoning for one agent run. */
export function RunPicker({ value, onChange }: { value: RunChoice; onChange: (v: RunChoice) => void }) {
  return (
    <span className="a3d-row a3d-runpick">
      <label>Model
        <select value={value.model} onChange={(e) => onChange({ ...value, model: e.target.value })}>
          {MODELS.map((m) => <option key={m.value} value={m.value}>{m.label}</option>)}
        </select>
      </label>
      <label>Reasoning
        <select value={value.effort} onChange={(e) => onChange({ ...value, effort: e.target.value as Effort })}>
          {EFFORTS.map((x) => <option key={x.value} value={x.value}>{x.label}</option>)}
        </select>
      </label>
    </span>
  );
}
