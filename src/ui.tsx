import { useEffect, useRef, useState } from 'react';
import type { PanelHost } from '@nimbalyst/extension-sdk';

export const sh = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
export const openCmd = () =>
  /Win/i.test(navigator.platform) ? 'start ""' : /Mac/i.test(navigator.platform) ? 'open' : 'xdg-open';
export const fileUrl = (abs: string, mtime: number) =>
  `file://${encodeURI(abs).replace(/#/g, '%23').replace(/\?/g, '%3F')}?v=${mtime}`;
export const MIME: Record<string, string> = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif' };

export const isMac = () => /Mac/i.test(navigator.platform);
export const isWin = () => /Win/i.test(navigator.platform);

/** Shell command that shows a file selected in the system file manager. */
export function revealCmd(path: string) {
  if (isMac()) return `open -R ${sh(path)}`;
  if (isWin()) return `explorer /select,"${path.replace(/\//g, '\\')}"`;
  return `xdg-open ${sh(path.replace(/\/[^/]*$/, ''))}`;
}

/** Local image. Falls back to reading the file through the shell if file:// is blocked. */
export function Img({ host, path, mtime, alt, onClick }: { host: PanelHost; path: string; mtime: number; alt: string; onClick?: () => void }) {
  const [src, setSrc] = useState(() => fileUrl(path, mtime));
  const tried = useRef(false);
  useEffect(() => {
    tried.current = false;
    setSrc(fileUrl(path, mtime));
  }, [path, mtime]);
  const onError = async () => {
    if (tried.current) return;
    tried.current = true;
    const res = await host.exec(`base64 < ${sh(path)}`, { timeout: 20000 });
    const ext = path.split('.').pop()?.toLowerCase() ?? 'png';
    if (res.success) setSrc(`data:${MIME[ext] ?? 'image/png'};base64,${res.stdout.replace(/\s+/g, '')}`);
  };
  return <img src={src} alt={alt} onError={onError} onClick={onClick} loading="lazy" />;
}

