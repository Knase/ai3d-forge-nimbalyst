import { useState } from 'react';
import type { PanelHost } from '@nimbalyst/extension-sdk';
import { RunPicker } from './RunPicker';
import type { RunChoice } from './runSettings';
import type { Model } from './types';
import { Img } from './ui';

export interface NewModelRequest {
  target: 'model' | 'branch';
  text: string;
  pictures: string[];
  link: string;
  branchName: string;
  run: RunChoice;
}

/** A concept from words, pictures and links: as a new model, or as a new branch of the selected model. */
export function NewModelDialog({ host, model, pictures: initial, defaultRun, busy, onPick, onCancel, onRun }: {
  host: PanelHost;
  model: Model | null;
  pictures: string[];
  defaultRun: RunChoice;
  busy: boolean;
  onPick: () => Promise<string[] | null>;
  onCancel: () => void;
  onRun: (r: NewModelRequest) => void;
}) {
  const [target, setTarget] = useState<'model' | 'branch'>('model');
  const [text, setText] = useState('');
  const [pictures, setPictures] = useState<string[]>(initial);
  const [path, setPath] = useState('');
  const [link, setLink] = useState('');
  const [branchName, setBranchName] = useState('');
  const [run, setRun] = useState(defaultRun);
  const add = (list: string[]) => setPictures((p) => Array.from(new Set([...p, ...list.map((x) => x.trim()).filter(Boolean)])));
  const linkOk = !link.trim() || /^https?:\/\/\S+$/i.test(link.trim());
  const valid = (text.trim() || pictures.length > 0 || link.trim()) && linkOk && (target === 'model' || branchName.trim());

  return (
    <div className="a3d-overlay" onClick={onCancel}>
      <form className="a3d-dialog a3d-dialog-wide a3d-attempt" onClick={(e) => e.stopPropagation()}
        onSubmit={(e) => { e.preventDefault(); if (valid) onRun({ target, text: text.trim(), pictures, link: link.trim(), branchName: branchName.trim(), run }); }}>
        <header>
          <h3>New concept</h3>
          <p className="a3d-muted">Muse writes the concept from what you give it: words, pictures, a link, or any mix. With a picture, Muse looks at it first and describes what it sees.</p>
        </header>

        {model && (
          <fieldset className="a3d-fields">
            <legend>Make it</legend>
            <span className="a3d-row">
              <label className="a3d-check"><input type="radio" name="a3d-nm-target" checked={target === 'model'} onChange={() => setTarget('model')} /> A new model</label>
              <label className="a3d-check"><input type="radio" name="a3d-nm-target" checked={target === 'branch'} onChange={() => setTarget('branch')} /> A new branch of {model.meta.title || model.slug}</label>
            </span>
            {target === 'branch' && <label>Branch name<input value={branchName} onChange={(e) => setBranchName(e.target.value)} placeholder="Wizard kitten, With shield…" /></label>}
          </fieldset>
        )}

        <section className="a3d-attempt-sec">
          <strong>Pictures to make it from</strong>
          {pictures.length > 0 && (
            <div className="a3d-gallery">{pictures.map((p) => (
              <figure key={p}>
                <Img host={host} path={p} mtime={0} alt={p.split('/').pop() ?? p} />
                <figcaption title={p}>{p.split('/').pop()} <button type="button" className="a3d-link" onClick={() => setPictures((x) => x.filter((y) => y !== p))}>remove</button></figcaption>
              </figure>
            ))}</div>
          )}
          <span className="a3d-row a3d-pathrow">
            <input className="a3d-in-grow" aria-label="Picture path" placeholder="Path to a picture, or use Choose…" value={path} onChange={(e) => setPath(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter' && path.trim()) { e.preventDefault(); add([path]); setPath(''); } }} />
            <button type="button" className="a3d-btn a3d-btn-small" disabled={!path.trim()} onClick={() => { add([path]); setPath(''); }}>Add</button>
            <button type="button" className="a3d-btn a3d-btn-small" onClick={async () => { const r = await onPick(); if (r) add(r); }}>Choose…</button>
          </span>
        </section>

        <label>Link (optional)
          <input value={link} onChange={(e) => setLink(e.target.value)} placeholder="https://… a model, a picture or a page to take the idea from" />
          {!linkOk && <span className="a3d-muted a3d-small">A link starts with http:// or https://</span>}
        </label>

        <label>What to make{pictures.length || link.trim() ? ' (optional: what to keep, what to change)' : ''}
          <textarea rows={3} autoFocus={!initial.length} value={text} onChange={(e) => setText(e.target.value)}
            placeholder={pictures.length ? 'Same character, but chibi proportions, standing, 60 mm, static, no cape.' : 'Subject, style, size, static or flexi.'} />
        </label>

        <details className="a3d-attempt-more">
          <summary>More: model and reasoning</summary>
          <RunPicker value={run} onChange={setRun} />
        </details>

        <footer className="a3d-attempt-foot">
          <span className="a3d-muted a3d-small">Agent run: ai3d-muse *concept{target === 'branch' ? ' in a new branch (flow_log.py branch add)' : ''}. Pictures are copied into refs/.</span>
          <span className="a3d-row a3d-row-end">
            <button type="button" className="a3d-btn" onClick={onCancel}>Cancel</button>
            <button type="submit" className="a3d-btn a3d-btn-primary" disabled={busy || !valid}>Run: write concept</button>
          </span>
        </footer>
      </form>
    </div>
  );
}
