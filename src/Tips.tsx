import type { ReactNode } from 'react';

/** step-tips.md split by `## <id>` headings. */
export function parseTips(md: string | null): Record<string, string> {
  const out: Record<string, string> = {};
  if (!md) return out;
  let cur: string | null = null;
  for (const line of md.split('\n')) {
    const h = /^## (\S+)\s*$/.exec(line);
    if (h) { cur = h[1].toLowerCase(); out[cur] = ''; continue; }
    if (cur) out[cur] += `${line}\n`;
  }
  return out;
}

/** Inline markdown: **bold** (which may hold `code`) and `code`. */
function codes(text: string, key: string): ReactNode[] {
  return text.split(/(`[^`]+`)/g).filter(Boolean).map((t, i) => (t.startsWith('`') && t.endsWith('`') && t.length > 1 ? <code key={`${key}c${i}`}>{t.slice(1, -1)}</code> : t));
}

function inline(text: string): ReactNode[] {
  return text.split(/(\*\*.+?\*\*)/g).filter(Boolean).flatMap<ReactNode>((t, i) =>
    t.startsWith('**') && t.endsWith('**') && t.length > 4 ? [<strong key={`b${i}`}>{codes(t.slice(2, -2), `b${i}`)}</strong>] : codes(t, `t${i}`));
}

/** A small, safe renderer for the tips file: ### headings, - bullets (with continuation lines), paragraphs. */
export function Markdown({ text }: { text: string }) {
  const blocks: ReactNode[] = [];
  let list: string[] = [];
  let para: string[] = [];
  const flush = () => {
    if (list.length) { blocks.push(<ul key={blocks.length}>{list.map((x, i) => <li key={i}>{inline(x)}</li>)}</ul>); list = []; }
    if (para.length) { blocks.push(<p key={blocks.length}>{inline(para.join(' '))}</p>); para = []; }
  };
  for (const raw of text.split('\n')) {
    const line = raw.trimEnd();
    if (!line.trim()) { flush(); continue; }
    const h = /^###\s+(.*)$/.exec(line);
    if (h) { flush(); blocks.push(<h4 key={blocks.length}>{inline(h[1])}</h4>); continue; }
    const b = /^\s*-\s+(.*)$/.exec(line);
    if (b) { if (para.length) flush(); list.push(b[1]); continue; }
    if (list.length && /^\s+/.test(raw)) { list[list.length - 1] += ` ${line.trim()}`; continue; }
    if (list.length) flush();
    para.push(line.trim());
  }
  flush();
  return <>{blocks}</>;
}

export function StepTips({ tips, step, onClose }: { tips: Record<string, string>; step: string; onClose?: () => void }) {
  const text = tips[step];
  return (
    <section className="a3d-tips" aria-label={`Tips for ${step}`}>
      {onClose && <button type="button" className="a3d-link" style={{ float: 'right' }} onClick={onClose}>Close</button>}
      {text ? <Markdown text={text} /> : <p className="a3d-muted">No tips found. They come from <code>ai3d-help/references/step-tips.md</code>: update the module if it is missing.</p>}
    </section>
  );
}
