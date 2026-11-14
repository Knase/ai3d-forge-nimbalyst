import { useRef, useState } from 'react';
import type { PanelHost } from '@nimbalyst/extension-sdk';
import { fileSize } from './flow';
import type { ImportKind } from './importFiles';
import { IMAGE_EXT, MESH_EXT } from './importFiles';
import type { FileEntry, Model, Scan } from './types';
import { Img } from './ui';

export type FileType = 'images' | 'meshes' | 'docs';
interface Row { rel: string; f: FileEntry; }

const IMG = /\.(png|jpe?g|webp|gif)$/i;
const MESH = /\.(stl|3mf|glb|gltf|obj|fbx|blend)$/i;
const DOC = /\.(md|json|txt|ya?ml)$/i;

export function fileRows(m: Model, type: FileType): Row[] {
  const from = (folder: string, list: FileEntry[], test: RegExp) => list.filter((f) => test.test(f.name)).map((f) => ({ rel: `${folder}/${f.name}`, f }));
  if (type === 'images') return [...from('inbox', m.files.inbox, IMG), ...from('images', m.files.images, IMG), ...from('renders', m.files.renders, IMG), ...from('refs', m.files.refs, IMG)];
  if (type === 'meshes') return [...from('mesh', m.files.mesh, MESH), ...from('print', m.files.print, /\.3mf$/i), ...from('mesh/attempts', m.attempts, MESH)];
  const top: Row[] = [];
  if (m.concept) top.push({ rel: 'concept.md', f: { name: 'concept.md', size: m.concept.length, mtime: m.stamp } });
  if (m.hasReadme) top.push({ rel: 'README.md', f: { name: 'README.md', size: 0, mtime: m.stamp } });
  return [...top, ...from('prompts', m.files.prompts, DOC), ...from('print', m.files.print, DOC), ...from('publish', m.files.publish, DOC)];
}

const day = (ts: number) => new Date(ts * 1000).toLocaleDateString([], { month: 'short', day: 'numeric' });

function Listing({ host, model, type, rows, onZoom, onOpen, onReveal, onView }: {
  host: PanelHost; model: Model; type: FileType; rows: Row[];
  onZoom: (z: { path: string; mtime: number; name: string }) => void;
  onOpen: (m: Model, rel: string) => void;
  onReveal: (m: Model, rel: string) => void;
  onView?: (m: Model) => void;
}) {
  const made = new Map<string, string>();
  for (const n of model.flow.nodes) for (const f of n.files) made.set(f, n.label);
  if (!rows.length) return <p className="a3d-muted a3d-files-empty">{type === 'images' ? 'No images.' : type === 'meshes' ? 'No 3D files.' : 'No documents.'}</p>;
  if (type === 'images') {
    return (
      <div className="a3d-gallery a3d-gallery-files">
        {rows.map(({ rel, f }) => {
          const path = `${model.dir}/${rel}`;
          return (
            <figure key={rel}>
              <Img host={host} path={path} mtime={f.mtime} alt={f.name} onClick={() => onZoom({ path, mtime: f.mtime, name: rel })} />
              <figcaption title={rel}><span className="a3d-file-folder">{rel.split('/')[0]}</span> {f.name}</figcaption>
              <span className="a3d-fig-actions">
                <span className="a3d-muted">{made.get(rel) ?? day(f.mtime)}</span>
                <button type="button" className="a3d-link" onClick={() => onReveal(model, rel)}>Show in Finder</button>
              </span>
            </figure>
          );
        })}
      </div>
    );
  }
  return (
    <table className="a3d-filetable">
      <thead><tr><th>File</th><th>Size</th><th>Date</th><th>From attempt</th><th><span className="a3d-sr">Actions</span></th></tr></thead>
      <tbody>
        {rows.map(({ rel, f }) => (
          <tr key={rel}>
            <td><span className="a3d-file-folder">{rel.slice(0, rel.lastIndexOf('/') + 1)}</span><strong>{f.name}</strong>
              {/^mesh\/print\.stl$/.test(rel) && <span className="a3d-pill a3d-pill-done">to print</span>}
              {/^mesh\/raw\./.test(rel) && <span className="a3d-pill">as generated</span>}</td>
            <td className="a3d-num">{f.size ? fileSize(f.size) : ''}</td>
            <td className="a3d-num">{day(f.mtime)}</td>
            <td className="a3d-muted">{made.get(rel) ?? ''}</td>
            <td><span className="a3d-row a3d-row-end">
              {onView && /\.stl$/i.test(f.name) && rel.startsWith('mesh/') && !rel.includes('attempts') && <button type="button" className="a3d-btn a3d-btn-small" onClick={() => onView(model)}>3D view</button>}
              <button type="button" className="a3d-btn a3d-btn-small" onClick={() => onOpen(model, rel)}>{type === 'docs' ? 'Open' : /\.(stl|3mf)$/i.test(f.name) ? 'Open in slicer' : 'Open in app'}</button>
              <button type="button" className="a3d-btn a3d-btn-small" onClick={() => onReveal(model, rel)}>Show in Finder</button>
            </span></td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export function FilesTab({ host, scan, model, nodeFilter, importing, onClearFilter, onSelectModel, onZoom, onOpen, onReveal, onView, onPick, onFiles }: {
  host: PanelHost;
  scan: Scan;
  model: Model | null;
  /** Show only the files of this attempt of the selected model. */
  nodeFilter: string | null;
  importing: boolean;
  onClearFilter: () => void;
  onSelectModel: (slug: string) => void;
  onZoom: (z: { path: string; mtime: number; name: string }) => void;
  onOpen: (m: Model, rel: string) => void;
  onReveal: (m: Model, rel: string) => void;
  onView: (m: Model) => void;
  /** Open the system dialog; resolves false when it is not available and the file input must be used. */
  onPick: (kind: ImportKind) => Promise<boolean>;
  onFiles: (files: File[]) => void;
}) {
  const [type, setType] = useState<FileType>('images');
  const [over, setOver] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const [inputKind, setInputKind] = useState<ImportKind>('image');
  const node = model && nodeFilter ? model.flow.nodes.find((n) => n.id === nodeFilter) ?? null : null;
  const others = scan.models.filter((m) => m.slug !== model?.slug);
  const count = (m: Model, t: FileType) => fileRows(m, t).length;

  const pick = async (kind: ImportKind) => {
    if (await onPick(kind)) return;
    setInputKind(kind);
    setTimeout(() => input.current?.click(), 0);
  };
  const rows = model ? fileRows(model, type).filter((r) => !node || node.files.includes(r.rel)) : [];

  return (
    <section className="a3d-files-tab">
      <header className="a3d-head">
        <div>
          <h1>Files</h1>
          <p className="a3d-muted">{model ? <>The selected model first, every other model below.</> : 'Pick a model in Models to see its files first.'}</p>
        </div>
        <span className="a3d-seg" role="group" aria-label="File type">
          {([['images', 'Images'], ['meshes', '3D files'], ['docs', 'Documents']] as const).map(([id, label]) => (
            <button key={id} type="button" aria-pressed={type === id} onClick={() => setType(id)}>{label}{model ? ` ${count(model, id)}` : ''}</button>
          ))}
        </span>
      </header>

      {model && (
        <section className={over ? 'a3d-files-current a3d-drop-over' : 'a3d-files-current'}
          onDragOver={(e) => { e.preventDefault(); setOver(true); }} onDragLeave={() => setOver(false)}
          onDrop={(e) => { e.preventDefault(); setOver(false); const fs = Array.from(e.dataTransfer.files); if (fs.length) onFiles(fs); }}>
          <div className="a3d-files-bar">
            <h3>{model.meta.title || model.slug}</h3>
            <span className="a3d-row">
              <button type="button" className="a3d-btn a3d-btn-primary" disabled={importing} onClick={() => void pick('image')}>Add image…</button>
              <button type="button" className="a3d-btn a3d-btn-primary" disabled={importing} onClick={() => void pick('mesh')}>Add 3D model…</button>
              <button type="button" className="a3d-btn" onClick={() => onReveal(model, '')}>Show folder in Finder</button>
            </span>
          </div>
          <p className="a3d-muted a3d-files-hint">
            {importing ? 'Adding files…' : 'Or drop files here. Images go to inbox/, a GLB becomes mesh/raw.glb (the previous one is kept in mesh/attempts/), STL goes to mesh/, 3MF to print/.'}
          </p>
          {node && (
            <p className="a3d-banner">Only the files of the attempt “{node.label}”.<button type="button" className="a3d-link" onClick={onClearFilter}>Show all files</button></p>
          )}
          <Listing host={host} model={model} type={type} rows={rows} onZoom={onZoom} onOpen={onOpen} onReveal={onReveal} onView={onView} />
          <input ref={input} type="file" multiple hidden accept={(inputKind === 'image' ? IMAGE_EXT : MESH_EXT).map((e) => `.${e}`).join(',')}
            onChange={(e) => { const fs = Array.from(e.target.files ?? []); e.target.value = ''; if (fs.length) onFiles(fs); }} />
        </section>
      )}

      {others.length > 0 && (
        <section className="a3d-files-others">
          <h3 className="a3d-files-others-title">Other models</h3>
          {others.map((m) => (
            <details key={m.slug}>
              <summary>
                <span className="a3d-files-name">{m.meta.title || m.slug}</span>
                <span className="a3d-muted">{count(m, type)} {type === 'images' ? 'images' : type === 'meshes' ? '3D files' : 'documents'}</span>
                <button type="button" className="a3d-btn a3d-btn-small" onClick={(e) => { e.preventDefault(); onSelectModel(m.slug); }}>Select</button>
              </summary>
              <Listing host={host} model={m} type={type} rows={fileRows(m, type)} onZoom={onZoom} onOpen={onOpen} onReveal={onReveal} />
            </details>
          ))}
        </section>
      )}
    </section>
  );
}
