import { useEffect, useMemo, useRef, useState } from 'react';

export interface Command {
  id: string;
  title: string;
  hint?: string;
  disabled?: string | false;
  run: () => void;
}

/** Cmd/Ctrl+K command list: type to filter, arrows to move, Enter to run. */
export function Palette({ commands, onClose }: { commands: Command[]; onClose: () => void }) {
  const [q, setQ] = useState('');
  const [i, setI] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const list = useMemo(() => {
    const words = q.toLowerCase().split(/\s+/).filter(Boolean);
    return commands.filter((c) => words.every((w) => `${c.title} ${c.hint ?? ''}`.toLowerCase().includes(w)));
  }, [q, commands]);
  useEffect(() => { input.current?.focus(); }, []);
  useEffect(() => { setI(0); }, [q]);

  const run = (c: Command | undefined) => {
    if (!c || c.disabled) return;
    onClose();
    c.run();
  };
  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); setI((x) => Math.min(list.length - 1, x + 1)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setI((x) => Math.max(0, x - 1)); }
    else if (e.key === 'Enter') { e.preventDefault(); run(list[i]); }
    else if (e.key === 'Escape') { e.preventDefault(); onClose(); }
  };

  return (
    <div className="a3d-overlay a3d-overlay-top" onClick={onClose}>
      <div className="a3d-palette" role="dialog" aria-label="Commands" onClick={(e) => e.stopPropagation()} onKeyDown={onKey}>
        <input ref={input} value={q} placeholder="Type a command…" aria-label="Filter commands" onChange={(e) => setQ(e.target.value)} />
        <ul role="listbox">
          {list.length === 0 && <li className="a3d-muted a3d-palette-empty">No command matches.</li>}
          {list.map((c, n) => (
            <li key={c.id} role="option" aria-selected={n === i} aria-disabled={!!c.disabled}>
              <button type="button" className={n === i ? 'a3d-cmd a3d-cmd-on' : 'a3d-cmd'} disabled={!!c.disabled} onMouseEnter={() => setI(n)} onClick={() => run(c)}>
                <span>{c.title}</span>
                <span className="a3d-muted">{c.disabled || c.hint || ''}</span>
              </button>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
