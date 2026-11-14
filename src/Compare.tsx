import type { PanelHost } from '@nimbalyst/extension-sdk';
import type { FlowNode, Model } from './types';
import { Img } from './ui';
import { dirOf, nodeBranch } from './branches';

const IMG = /\.(png|jpe?g|webp|gif)$/i;

/** Two attempts side by side: settings (differences marked), description, outcome, cost, notes, images, 3D files. */
export function CompareView({ host, model, a, b, onClose, onSwap, onView3d, onOpen }: {
  host: PanelHost; model: Model; a: FlowNode; b: FlowNode;
  onClose: () => void; onSwap: () => void;
  onView3d: (n: FlowNode, stl: string) => void;
  onOpen: (rel: string, n: FlowNode) => void;
}) {
  const keys = Array.from(new Set([...Object.keys(a.settings), ...Object.keys(b.settings)])).sort();
  const row = (label: string, va: string, vb: string) => (
    <tr key={label} className={va !== vb ? 'a3d-diff' : undefined}><th>{label}</th><td>{va || <span className="a3d-muted">–</span>}</td><td>{vb || <span className="a3d-muted">–</span>}</td></tr>
  );
  const side = (n: FlowNode) => {
    const pics = n.files.filter((f) => IMG.test(f));
    const stls = n.files.filter((f) => /\.stl$/i.test(f));
    return (
      <div className="a3d-cmp-side">
        {pics.length > 0 && <div className="a3d-gallery">{pics.map((f) => <figure key={f}><Img host={host} path={`${dirOf(model, n)}/${f}`} mtime={model.stamp} alt={f} /><figcaption>{f}</figcaption></figure>)}</div>}
        <p className="a3d-row">
          {stls.map((f) => <button key={f} type="button" className="a3d-btn a3d-btn-small" onClick={() => onView3d(n, f)}>3D: {f.split('/').pop()}</button>)}
          {n.files.filter((f) => !IMG.test(f) && !/\.stl$/i.test(f)).map((f) => <button key={f} type="button" className="a3d-link" onClick={() => onOpen(f, n)}>{f}</button>)}
        </p>
      </div>
    );
  };
  return (
    <section className="a3d-node-detail a3d-compare">
      <header>
        <h3>Compare attempts{a.step !== b.step ? <span className="a3d-pill">different steps</span> : null}</h3>
        <span className="a3d-row">
          <button type="button" className="a3d-btn a3d-btn-small" onClick={onSwap}>Swap</button>
          <button type="button" className="a3d-btn a3d-btn-small" onClick={onClose}>Close</button>
        </span>
      </header>
      <table className="a3d-filetable a3d-cmp-table">
        <thead><tr><th></th><th>A · {a.label}</th><th>B · {b.label}</th></tr></thead>
        <tbody>
          {model.branches.length > 1 && row('Branch', nodeBranch(a), nodeBranch(b))}
          {row('Status', `${a.status}${a.verdict ? ` · ${a.verdict}` : ''}`, `${b.status}${b.verdict ? ` · ${b.verdict}` : ''}`)}
          {keys.map((k) => row(k, a.settings[k] ?? '', b.settings[k] ?? ''))}
          {row('Description', a.description, b.description)}
          {row('Outcome', a.outcome, b.outcome)}
          {row('Cost', a.cost ? `${a.cost.credits} ${a.cost.service}` : '', b.cost ? `${b.cost.credits} ${b.cost.service}` : '')}
          {row('Notes', (a.notes ?? []).map((x) => x.text).join(' · '), (b.notes ?? []).map((x) => x.text).join(' · '))}
        </tbody>
      </table>
      <div className="a3d-two">{side(a)}{side(b)}</div>
      <p className="a3d-muted a3d-small">Rows that differ are highlighted. A file an attempt replaced later lives in mesh/attempts/; older attempts that did not record their files show none.</p>
    </section>
  );
}
