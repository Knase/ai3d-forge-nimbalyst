import { useRef, useState } from 'react';
import type { Model } from './types';

export interface PrintLogRequest {
  result: 'ok' | 'issues' | 'fail';
  printer: string; filament: string; settings: string; change: string; notes: string;
  photoPaths: string[]; photoFiles: File[];
}

/** Record one test print. Photos: the system dialog on macOS (paths), else a file input (uploaded through the shell). */
export function PrintLogDialog({ model, last, onPickPhotos, onCancel, onSave }: {
  model: Model;
  last: { printer?: string; filament?: string; settings?: string } | null;
  onPickPhotos: () => Promise<string[] | null>;
  onCancel: () => void;
  onSave: (r: PrintLogRequest) => void;
}) {
  const [r, setR] = useState<PrintLogRequest>({
    result: 'ok', printer: last?.printer ?? '', filament: last?.filament ?? '', settings: last?.settings ?? '',
    change: '', notes: '', photoPaths: [], photoFiles: [],
  });
  const input = useRef<HTMLInputElement>(null);
  const set = (k: keyof PrintLogRequest, v: string) => setR((x) => ({ ...x, [k]: v }));
  const pick = async () => {
    const paths = await onPickPhotos();
    if (paths === null) input.current?.click();
    else if (paths.length) setR((x) => ({ ...x, photoPaths: [...x.photoPaths, ...paths] }));
  };
  const count = r.photoPaths.length + r.photoFiles.length;
  return (
    <div className="a3d-overlay" onClick={onCancel}>
      <form className="a3d-dialog a3d-dialog-wide" onClick={(e) => e.stopPropagation()} onSubmit={(e) => { e.preventDefault(); onSave(r); }}>
        <h3>Test print · {model.meta.title || model.slug}</h3>
        <fieldset className="a3d-fields a3d-result">
          <legend>Result</legend>
          {([['ok', 'OK, prints as intended'], ['issues', 'Prints, with issues'], ['fail', 'Failed']] as const).map(([v, l]) => (
            <label key={v} className="a3d-radio"><input type="radio" name="a3d-result" checked={r.result === v} onChange={() => set('result', v)} /> {l}</label>
          ))}
        </fieldset>
        <div className="a3d-form-grid">
          <label>Printer<input value={r.printer} onChange={(e) => set('printer', e.target.value)} placeholder="Bambu A1" /></label>
          <label>Filament<input value={r.filament} onChange={(e) => set('filament', e.target.value)} placeholder="PLA Basic, green" /></label>
        </div>
        <label>Settings<input value={r.settings} onChange={(e) => set('settings', e.target.value)} placeholder="0.2 mm layers, 3 walls, 15 % infill, no supports" /></label>
        <label>What to change next time<input value={r.change} onChange={(e) => set('change', e.target.value)} placeholder="clearance 0.45 instead of 0.4; tail joint stuck" /></label>
        <label>Notes<textarea rows={2} value={r.notes} onChange={(e) => set('notes', e.target.value)} /></label>
        <p className="a3d-row">
          <button type="button" className="a3d-btn" onClick={() => void pick()}>Add photos…</button>
          <span className="a3d-muted">{count ? `${count} photo${count === 1 ? '' : 's'}` : 'Photos are copied into print/photos/.'}</span>
          <input ref={input} type="file" accept="image/*" multiple hidden onChange={(e) => { const fs = Array.from(e.target.files ?? []); e.target.value = ''; setR((x) => ({ ...x, photoFiles: [...x.photoFiles, ...fs] })); }} />
        </p>
        <span className="a3d-row a3d-row-end">
          <button type="button" className="a3d-btn" onClick={onCancel}>Cancel</button>
          <button type="submit" className="a3d-btn a3d-btn-primary">Save</button>
        </span>
      </form>
    </div>
  );
}
