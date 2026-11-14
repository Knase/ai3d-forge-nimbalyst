import { useEffect, useState } from 'react';
import type { PanelHost } from '@nimbalyst/extension-sdk';
import { sh } from './ui';

/** A generated Prism dashboard (self-contained HTML), shown inline in a sandboxed frame. */
export function DashboardFrame({ host, path, mtime, title }: { host: PanelHost; path: string; mtime: number; title: string }) {
  const [html, setHtml] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    setError(null);
    host.exec(`cat ${sh(path)}`, { timeout: 20000, maxBuffer: 30_000_000 }).then((r) => {
      if (!live) return;
      if (r.success) setHtml(r.stdout); else setError(r.stderr.trim() || 'Could not read the dashboard.');
    });
    return () => { live = false; };
  }, [host, path, mtime]);
  const dark = /dark/i.test(host.theme);
  if (error) return <p className="a3d-banner a3d-banner-error">{error}</p>;
  if (!html) return <p className="a3d-muted">Loading the dashboard…</p>;
  return <iframe className="a3d-dash-frame" title={title} sandbox="allow-scripts"
    srcDoc={html.replace('<html lang="en">', `<html lang="en" data-theme="${dark ? 'dark' : 'light'}">`)} />;
}
