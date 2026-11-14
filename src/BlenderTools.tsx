import { useState } from 'react';
import type { BlenderStatus, KilnCommand, KilnResult } from './blender';
import { summarize } from './blender';
import type { Model } from './types';

export type Readiness = 'ready' | 'partial' | 'missing' | 'unknown';

export function readiness(s: BlenderStatus | null): Readiness {
  if (!s) return 'unknown';
  if (!s.bin) return 'missing';
  return s.mcp.some((m) => m.forSessions) ? 'ready' : 'partial';
}

const shortVersion = (v: string | null) => v?.match(/\d+\.\d+(\.\d+)?/)?.[0] ?? '';

export function BlenderChip({ status, checking, onClick }: { status: BlenderStatus | null; checking: boolean; onClick: () => void }) {
  const r = readiness(status);
  const text = checking ? 'checking…' : r === 'ready' ? `${shortVersion(status!.version)} · MCP` : r === 'partial' ? `${shortVersion(status!.version)} · no MCP` : r === 'missing' ? 'not found' : '';
  return (
    <button type="button" className={`a3d-chip a3d-chip-${r}`} onClick={onClick} title="Blender and the Blender MCP: status, setup guide">
      <i aria-hidden="true" />Blender <span className="a3d-muted">{text}</span>
    </button>
  );
}

function Row({ ok, label, value, hint }: { ok: boolean | null; label: string; value: string; hint?: string }) {
  return (
    <div className="a3d-status-row">
      <span className={ok === null ? 'a3d-st a3d-st-unknown' : ok ? 'a3d-st a3d-st-ok' : 'a3d-st a3d-st-bad'} aria-hidden="true">{ok === null ? '?' : ok ? '✓' : '✕'}</span>
      <span className="a3d-status-label">{label}</span>
      <span className="a3d-status-value">{value}{hint && <span className="a3d-muted"> — {hint}</span>}</span>
    </div>
  );
}

export function BlenderDialog({ status, checking, kilnInstalled, guide, onCheck, onGuide, onLaunch, onClose }: {
  status: BlenderStatus | null; checking: boolean; kilnInstalled: boolean; guide: boolean;
  onCheck: () => void; onGuide: () => void; onLaunch: () => void; onClose: () => void;
}) {
  const sessions = status?.mcp.filter((m) => m.forSessions) ?? [];
  const desktop = status?.mcp.filter((m) => !m.forSessions) ?? [];
  return (
    <div className="a3d-overlay" onClick={onClose}>
      <div className="a3d-dialog a3d-dialog-wide" role="dialog" aria-label="Blender" onClick={(e) => e.stopPropagation()}>
        <h3>Blender</h3>
        <p className="a3d-muted">The Kiln agent drives your open Blender through the Blender MCP. The quick tools in the Blender step run a background Blender and need only the app.</p>
        <div className="a3d-status">
          <Row ok={status ? !!status.bin : null} label="Blender app" value={status?.bin ? `${status.version ?? 'version unknown'}` : 'not found'}
            hint={status?.bin ? status.bin : 'install it into /Applications, or set “Blender executable” in Settings'} />
          <Row ok={status?.running ?? null} label="Running" value={status?.running ? 'yes' : status?.running === false ? 'no' : 'unknown'}
            hint={status?.running ? undefined : 'the agent needs Blender open with the MCP add-on server started'} />
          <Row ok={status ? sessions.length > 0 : null} label="MCP for agent sessions"
            value={sessions.length ? sessions.map((m) => `${m.name} (${m.where})`).join(', ') : 'not registered for Claude Code'}
            hint={sessions.length ? undefined : desktop.length ? 'found only in the Claude desktop app, which Nimbalyst sessions do not read' : 'see the setup guide, step 3'} />
          <Row ok={kilnInstalled} label="Kiln scripts" value={kilnInstalled ? 'installed' : 'not found'} hint={kilnInstalled ? undefined : 'update the AI3D Forge module'} />
        </div>
        <p className="a3d-muted a3d-small">⚠ The panel cannot see inside an agent session: “registered” means the config has it, not that this session connected. In a session, <code>/mcp</code> shows the live state.</p>
        <span className="a3d-row a3d-row-end">
          {guide && <button type="button" className="a3d-btn" onClick={onGuide}>Setup guide</button>}
          <button type="button" className="a3d-btn" disabled={!status?.bin} onClick={onLaunch}>Open Blender</button>
          <button type="button" className="a3d-btn" disabled={checking} onClick={onCheck}>{checking ? 'Checking…' : 'Check again'}</button>
          <button type="button" className="a3d-btn a3d-btn-primary" onClick={onClose}>Close</button>
        </span>
      </div>
    </div>
  );
}

export interface QuickRequest { cmd: 'prep' | 'flexi'; opts: Record<string, string>; description: string }

const SIDES = ['auto', 'bottom', 'back', 'front', 'left', 'right', 'top'];

export function KilnDialog({ cmd, model, initial, onCancel, onRun }: {
  cmd: 'prep' | 'flexi'; model: Model; initial?: Record<string, string>;
  onCancel: () => void; onRun: (r: QuickRequest) => void;
}) {
  const scale = String(model.meta.scale_mm ?? '');
  const [o, setO] = useState<Record<string, string>>(() => ({
    ...(cmd === 'prep' ? { height: scale || '100', orient: 'auto', cut: '1.0', voxel: '' } : { segments: '6', clearance: '0.4', gap: '1.5', pin_d: '3.0' }),
    ...(initial ?? {}),
  }));
  const [description, setDescription] = useState('');
  const set = (k: string, v: string) => setO((x) => ({ ...x, [k]: v }));
  const num = (k: string, label: string, help: string, step = '0.1') => (
    <label key={k}>{label}
      <input type="number" step={step} min="0" value={o[k] ?? ''} onChange={(e) => set(k, e.target.value)} />
      <span className="a3d-muted a3d-small">{help}</span>
    </label>
  );
  return (
    <div className="a3d-overlay" onClick={onCancel}>
      <form className="a3d-dialog a3d-dialog-wide" onClick={(e) => e.stopPropagation()} onSubmit={(e) => { e.preventDefault(); onRun({ cmd, opts: o, description: description.trim() }); }}>
        <h3>{cmd === 'prep' ? 'Quick prep in Blender' : 'Flexi joints in Blender'}</h3>
        <p className="a3d-muted">Runs in a background Blender, no agent, no tokens. It becomes a new attempt in the graph; the current print.stl is kept in mesh/attempts/.</p>
        <div className="a3d-form-grid">
          {cmd === 'prep' ? <>
            {num('height', 'Size (mm)', 'tallest dimension after scaling', '1')}
            <label>Side on the bed
              <select value={o.orient} onChange={(e) => set('orient', e.target.value)}>{SIDES.map((s) => <option key={s} value={s}>{s}</option>)}</select>
              <span className="a3d-muted a3d-small">auto picks the lowest overhang among stable sides</span>
            </label>
            {num('cut', 'Flat cut (mm)', 'sliced off the bed side for a flat base')}
            {num('voxel', 'Voxel size (mm)', 'empty = automatic; smaller keeps detail, slower')}
          </> : <>
            {num('segments', 'Segments', 'number of body parts', '1')}
            {num('clearance', 'Clearance (mm)', 'gap in the joint; use your coupon result', '0.05')}
            {num('gap', 'Gap between segments (mm)', 'cut width')}
            {num('pin_d', 'Pin diameter (mm)', 'smaller for narrow bodies')}
          </>}
        </div>
        <label>Description: what is different this time
          <textarea rows={2} value={description} onChange={(e) => setDescription(e.target.value)} placeholder={cmd === 'prep' ? 'Back on the bed instead of bottom: the belly has the detail.' : 'Six segments, clearance from the coupon.'} />
        </label>
        <span className="a3d-row a3d-row-end">
          <button type="button" className="a3d-btn" onClick={onCancel}>Cancel</button>
          <button type="submit" className="a3d-btn a3d-btn-primary">Run in Blender</button>
        </span>
      </form>
    </div>
  );
}

export function BlenderBlock({ model, status, kilnRun, busy, last, onRun, onPrep, onFlexi, onOpen, onCommand, onSetup }: {
  model: Model; status: BlenderStatus | null; kilnRun: string | null; busy: KilnCommand | null; last: KilnResult | null;
  onRun: (cmd: 'analyze' | 'render' | 'coupon') => void; onPrep: () => void; onFlexi: () => void;
  onOpen: (rel: string) => void; onCommand: () => void; onSetup: () => void;
}) {
  const can = !!status?.bin && !!kilnRun && !busy;
  const raw = model.files.mesh.find((f) => /^raw\./i.test(f.name));
  const stl = model.files.mesh.find((f) => f.name === 'print.stl') ?? model.files.mesh.find((f) => f.name === 'clean.stl');
  const blend = model.files.mesh.find((f) => f.name === 'work.blend');
  const why = !status ? 'Checking Blender…' : !status.bin ? 'Blender not found.' : !kilnRun ? 'Kiln scripts not found: update the module.' : null;
  const orient = last?.command === 'analyze' ? last.orientations ?? [] : [];
  const a = (last?.analysis ?? last?.after) as Record<string, any> | undefined;
  return (
    <section className="a3d-block">
      <h4>Blender quick tools <span className="a3d-muted">no agent, no tokens</span></h4>
      {why && <p className="a3d-muted">{why} <button type="button" className="a3d-link" onClick={onSetup}>Blender setup</button></p>}
      <p className="a3d-row">
        <button type="button" className="a3d-btn" disabled={!can || (!raw && !stl)} onClick={() => onRun('analyze')}>{busy === 'analyze' ? 'Analyzing…' : 'Analyze'}</button>
        <button type="button" className="a3d-btn" disabled={!can || !raw} onClick={onPrep} title={raw ? '' : 'needs mesh/raw.*'}>{busy === 'prep' ? 'Preparing…' : 'Quick prep…'}</button>
        <button type="button" className="a3d-btn" disabled={!can || !stl} onClick={onFlexi} title={stl ? '' : 'needs mesh/print.stl'}>{busy === 'flexi' ? 'Building joints…' : 'Flexi…'}</button>
        <button type="button" className="a3d-btn" disabled={!can || (!raw && !stl)} onClick={() => onRun('render')}>{busy === 'render' ? 'Rendering…' : 'Render previews'}</button>
        <button type="button" className="a3d-btn" disabled={!can} onClick={() => onRun('coupon')}>{busy === 'coupon' ? 'Exporting…' : 'Clearance coupon'}</button>
      </p>
      <p className="a3d-row">
        <span className="a3d-muted">Open in Blender:</span>
        {blend && <button type="button" className="a3d-btn a3d-btn-small" disabled={!status?.bin} onClick={() => onOpen('mesh/work.blend')}>work.blend</button>}
        {stl && <button type="button" className="a3d-btn a3d-btn-small" disabled={!status?.bin} onClick={() => onOpen(`mesh/${stl.name}`)}>{stl.name}</button>}
        {raw && <button type="button" className="a3d-btn a3d-btn-small" disabled={!status?.bin} onClick={() => onOpen(`mesh/${raw.name}`)}>{raw.name}</button>}
        <span className="a3d-tabs-spacer" />
        <button type="button" className="a3d-btn a3d-btn-small" onClick={onCommand} title="Kiln agent runs one instruction in your open Blender">Blender command…</button>
      </p>
      {busy && <p className="a3d-muted">Running in a background Blender. Voxel remesh on a large mesh can take a minute or two.</p>}
      {last && !busy && (
        <div className={last.ok ? 'a3d-kiln-result' : 'a3d-kiln-result a3d-kiln-bad'}>
          <p><strong>{last.command === 'analyze' ? 'Analysis' : last.command === 'prep' ? 'Quick prep' : last.command === 'flexi' ? 'Flexi' : last.command === 'render' ? 'Render' : 'Coupon'}{last.ok ? '' : ' — problem'}:</strong> {summarize(last)}</p>
          {a && last.command === 'analyze' && (
            <dl className="a3d-metrics">
              {a.size_mm && <div className="a3d-metric"><dt>Size</dt><dd>{(a.size_mm as number[]).join(' × ')} mm</dd></div>}
              {a.watertight != null && <div className={a.watertight ? 'a3d-metric a3d-good' : 'a3d-metric a3d-bad'}><dt>Watertight</dt><dd>{a.watertight ? 'yes' : 'no'}</dd></div>}
              {a.shells != null && <div className="a3d-metric"><dt>Shells</dt><dd>{a.shells}</dd></div>}
              {a.overhang_pct != null && <div className="a3d-metric"><dt>Overhang</dt><dd>{a.overhang_pct} %</dd></div>}
              {a.triangles != null && <div className="a3d-metric"><dt>Triangles</dt><dd>{Number(a.triangles).toLocaleString()}</dd></div>}
            </dl>
          )}
          {orient.length > 0 && (
            <table className="a3d-filetable a3d-orient">
              <thead><tr><th>Side on bed</th><th>Overhang</th><th>Height</th><th>Stable</th></tr></thead>
              <tbody>{orient.map((r) => (
                <tr key={r.side}><td>{r.side}</td><td className="a3d-num">{r.overhang_pct} %</td><td className="a3d-num">{r.height_mm != null ? `${r.height_mm} mm` : ''}</td><td>{r.stable == null ? '' : r.stable ? 'yes' : 'no'}</td></tr>
              ))}</tbody>
            </table>
          )}
          {last.command === 'analyze' && <p className="a3d-muted a3d-small">Measured on {String(last.source ?? '')}.</p>}
        </div>
      )}
    </section>
  );
}
