import { DEFAULT_EFFORT, DEFAULT_MODELS, EFFORTS, MODELS, RUN_TARGETS, mapString, parseMap } from './runSettings';
import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  BED_PRESETS, DEFAULTS, GROUPS, WEIGHT_DIMS, applyUpdates, bedString, parseBed, parseConfig, parseWeights, weightsString,
  type ConfigIO, type Field,
} from './config';

interface Props {
  workspace: string;
  io: ConfigIO;
  onSaved?: () => void;
}

/** Form for `_bmad/ai3d/config.yaml`. Used in the panel's Settings tab and in Nimbalyst's Settings screen. */
export function SettingsForm({ workspace, io, onSaved }: Props) {
  const path = `${workspace}/_bmad/ai3d/config.yaml`;
  const [text, setText] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [values, setValues] = useState<Record<string, string>>({});
  const [base, setBase] = useState<Record<string, string>>({});
  const [status, setStatus] = useState<{ tone: 'ok' | 'error'; msg: string } | null>(null);
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    try {
      const t = await io.read(path);
      const cfg = { ...DEFAULTS, ...(t ? parseConfig(t) : {}) };
      setText(t);
      setValues(cfg);
      setBase(cfg);
    } catch (e) {
      setStatus({ tone: 'error', msg: e instanceof Error ? e.message : String(e) });
    } finally {
      setLoaded(true);
    }
  }, [io, path]);

  useEffect(() => { void load(); }, [load]);

  const dirty = useMemo(() => Object.keys(values).filter((k) => values[k] !== base[k]), [values, base]);
  const set = (k: string, v: string) => { setStatus(null); setValues((x) => ({ ...x, [k]: v })); };

  const problems = useMemo(() => {
    const p: string[] = [];
    const bed = parseBed(values.bed_mm ?? '');
    if (bed.some((n) => !(n > 0 && n <= 2000))) p.push('Bed size must be between 1 and 2000 mm on each axis.');
    const deg = Number(values.overhang_deg);
    if (!(deg >= 20 && deg <= 75)) p.push('Overhang angle must be between 20 and 75 degrees.');
    return p;
  }, [values]);

  const save = async () => {
    if (text === null || problems.length) return;
    setSaving(true);
    try {
      const updates = Object.fromEntries(dirty.map((k) => [k, values[k]]));
      await io.write(path, applyUpdates(text, updates));
      setStatus({ tone: 'ok', msg: `Saved ${dirty.length} setting${dirty.length === 1 ? '' : 's'}. Agents and scripts use them from their next run.` });
      await load();
      onSaved?.();
    } catch (e) {
      setStatus({ tone: 'error', msg: `Could not save: ${e instanceof Error ? e.message : String(e)}` });
    } finally {
      setSaving(false);
    }
  };

  const control = (f: Field) => {
    const v = values[f.key] ?? f.def;
    const id = `a3d-set-${f.key}`;
    switch (f.kind) {
      case 'select': {
        const opts = f.options!.some((o) => o.value === v) ? f.options! : [...f.options!, { value: v, label: `${v} (current)` }];
        return <select id={id} value={v} onChange={(e) => set(f.key, e.target.value)}>{opts.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}</select>;
      }
      case 'toggle':
        return (
          <label className="a3d-switch">
            <input id={id} type="checkbox" checked={v === 'true'} onChange={(e) => set(f.key, e.target.checked ? 'true' : 'false')} />
            <span>{v === 'true' ? 'On' : 'Off'}</span>
          </label>
        );
      case 'text':
        return <input id={id} value={v} onChange={(e) => set(f.key, e.target.value)} />;
      case 'bed': {
        const b = parseBed(v);
        return (
          <div className="a3d-bed">
            <span className="a3d-row">
              {['X', 'Y', 'Z'].map((ax, i) => (
                <label key={ax} className="a3d-num">{ax}
                  <input type="number" min={1} max={2000} value={b[i]} onChange={(e) => { const n = [...b]; n[i] = Number(e.target.value); set(f.key, bedString(n)); }} />
                </label>
              ))}
            </span>
            <span className="a3d-row">
              {BED_PRESETS.map((p) => (
                <button key={p.value} type="button" className="a3d-btn a3d-btn-small" aria-pressed={v === p.value} onClick={() => set(f.key, p.value)}>{p.label}</button>
              ))}
            </span>
          </div>
        );
      }
      case 'angle':
        return (
          <label className="a3d-slider a3d-slider-angle"><input id={id} type="range" min={20} max={75} step={1} value={Number(v) || 45} onChange={(e) => set(f.key, e.target.value)} /><output>{v}°</output></label>
        );
      case 'hidden':
        return null;
      case 'runs': {
        const models = parseMap(values.step_models, DEFAULT_MODELS);
        const efforts = parseMap(values.step_effort, DEFAULT_EFFORT);
        return (
          <table className="a3d-runs">
            <thead><tr><th>Step / agent</th><th>Model</th><th>Reasoning</th></tr></thead>
            <tbody>{RUN_TARGETS.map((t) => (
              <tr key={t.id}>
                <td>{t.label}</td>
                <td><select aria-label={`Model for ${t.label}`} value={models[t.id] === 'default' ? '' : models[t.id] ?? ''} onChange={(e) => set('step_models', mapString({ ...models, [t.id]: e.target.value || 'default' }))}>
                  {MODELS.map((m) => <option key={m.value} value={m.value.replace(/^claude-code:/, '')}>{m.label}</option>)}
                </select></td>
                <td><select aria-label={`Reasoning for ${t.label}`} value={efforts[t.id] ?? 'medium'} onChange={(e) => set('step_effort', mapString({ ...efforts, [t.id]: e.target.value }))}>
                  {EFFORTS.map((x) => <option key={x.value} value={x.value}>{x.label}</option>)}
                </select></td>
              </tr>
            ))}</tbody>
          </table>
        );
      }
      case 'weights': {
        const w = parseWeights(v);
        return (
          <div className="a3d-weights">
            {WEIGHT_DIMS.map((d) => (
              <label key={d.id} className="a3d-slider"><span>{d.label}</span>
                <input type="range" min={0} max={5} step={1} value={w[d.id]} onChange={(e) => set(f.key, weightsString({ ...w, [d.id]: Number(e.target.value) }))} />
                <output>{w[d.id]}</output>
              </label>
            ))}
          </div>
        );
      }
    }
  };

  if (!loaded) return <p className="a3d-muted">Reading settings…</p>;
  return (
    <form className="a3d-settings" onSubmit={(e) => { e.preventDefault(); void save(); }}>
      {text === null && (
        <p className="a3d-banner">No <code>_bmad/ai3d/config.yaml</code> in this workspace. Install the AI3D Forge module first; the form shows defaults until then.</p>
      )}
      {GROUPS.map((g) => (
        <section key={g.title} className="a3d-set-group">
          <h3>{g.title}</h3>
          {g.fields.filter((f) => f.kind !== 'hidden').map((f) => (
            <div key={f.key} className="a3d-field">
              <label htmlFor={`a3d-set-${f.key}`}>{f.label}</label>
              <div className="a3d-field-control">{control(f)}</div>
              <p className="a3d-muted">{f.help}</p>
            </div>
          ))}
        </section>
      ))}
      {problems.map((p) => <p key={p} className="a3d-banner a3d-banner-error">{p}</p>)}
      {status && <p className={status.tone === 'error' ? 'a3d-banner a3d-banner-error' : 'a3d-banner'} role="status">{status.msg}</p>}
      <span className="a3d-row">
        <button type="submit" className="a3d-btn a3d-btn-primary" disabled={!dirty.length || problems.length > 0 || text === null || saving}>
          {saving ? 'Saving…' : dirty.length ? `Save ${dirty.length} change${dirty.length === 1 ? '' : 's'}` : 'Saved'}
        </button>
        <button type="button" className="a3d-btn" disabled={!dirty.length} onClick={() => { setValues(base); setStatus(null); }}>Discard</button>
        <span className="a3d-muted">Writes {path.replace(workspace + '/', '')}</span>
      </span>
    </form>
  );
}
