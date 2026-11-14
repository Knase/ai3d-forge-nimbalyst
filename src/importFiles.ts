import type { PanelHost } from '@nimbalyst/extension-sdk';
import importSource from './import.py?raw';
import { isMac, sh } from './ui';

export type ImportKind = 'image' | 'mesh' | 'view';
export interface ImportResult {
  placed: { file: string; archived: string | null }[];
  skipped: { file: string; why: string }[];
}

export const IMAGE_EXT = ['png', 'jpg', 'jpeg', 'webp', 'gif'];
export const MESH_EXT = ['glb', 'gltf', 'obj', 'fbx', 'stl', '3mf'];
export const kindOf = (name: string): ImportKind | null => {
  const ext = name.split('.').pop()?.toLowerCase() ?? '';
  return IMAGE_EXT.includes(ext) ? 'image' : MESH_EXT.includes(ext) ? 'mesh' : null;
};

/**
 * The macOS file dialog, opened through the shell so the panel gets real paths and nothing is uploaded.
 * Returns the chosen paths, [] when the user cancelled, null when the dialog is not available.
 */
export async function pickWithSystemDialog(host: PanelHost, kind: ImportKind): Promise<string[] | null> {
  if (!isMac()) return null;
  const types = (kind !== 'mesh' ? IMAGE_EXT : MESH_EXT).map((e) => `"${e}"`).join(', ');
  const prompt = kind === 'image' ? 'Choose the generated image(s)' : kind === 'view' ? 'Choose the view images (front, left, back, right)' : 'Choose the 3D file (GLB, STL, 3MF…)';
  const script = [
    'tell application "Finder" to activate',
    `tell application "Finder" to set fs to choose file with prompt "${prompt}" of type {${types}} with multiple selections allowed`,
    'set out to ""', 'repeat with f in fs', 'set out to out & POSIX path of f & linefeed', 'end repeat', 'return out',
  ].map((l) => `-e ${sh(l)}`).join(' ');
  const res = await host.exec(`osascript ${script}`, { timeout: 600000 });
  if (!res.success) return /-128|cancel/i.test(res.stderr) ? [] : null;
  return res.stdout.split('\n').map((s) => s.trim()).filter(Boolean);
}

function b64(bytes: Uint8Array) {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

/** Write a browser File into the model through the shell, in chunks. Used when no path is available. */
export async function upload(host: PanelHost, modelDir: string, file: File): Promise<string> {
  const tmpDir = `${modelDir}/.import-tmp`;
  const tmp = `${tmpDir}/${file.name.replace(/[^\w.\- ]+/g, '_')}`;
  const init = await host.exec(`mkdir -p ${sh(tmpDir)} && : > ${sh(tmp)}`, { timeout: 15000 });
  if (!init.success) throw new Error(init.stderr.trim() || 'could not create the temporary file');
  // One shell command must stay under the 128 KB single-argument limit of Linux; base64 adds a third.
  const CHUNK = 60_000;
  if (file.size > 120_000_000) throw new Error(`${file.name} is too large to add this way; copy it into the model folder instead`);
  for (let off = 0; off < file.size; off += CHUNK) {
    const part = new Uint8Array(await file.slice(off, off + CHUNK).arrayBuffer());
    const res = await host.exec(
      `python3 -c "import sys,base64;open(sys.argv[1],'ab').write(base64.b64decode(sys.stdin.read()))" ${sh(tmp)} <<'A3D_B64'\n${b64(part)}\nA3D_B64`,
      { timeout: 60000 },
    );
    if (!res.success) throw new Error(res.stderr.trim() || `upload of ${file.name} failed`);
  }
  return tmp;
}

async function run(host: PanelHost, modelDir: string, kind: ImportKind, mode: 'copy' | 'move', paths: string[]): Promise<ImportResult> {
  const res = await host.exec(
    `python3 - ${sh(modelDir)} ${kind} ${mode} ${paths.map(sh).join(' ')} <<'A3D_IMPORT'\n${importSource}\nA3D_IMPORT`,
    { timeout: 120000 },
  );
  if (!res.success) throw new Error(res.stderr.trim().split('\n').pop() || 'import failed');
  return JSON.parse(res.stdout.trim().split('\n').pop() ?? '{}') as ImportResult;
}

export function importPaths(host: PanelHost, modelDir: string, kind: ImportKind, paths: string[]) {
  return run(host, modelDir, kind, 'copy', paths);
}

/** Files from a file input or a drop. Uses the real path when the host exposes one, else uploads the bytes. */
export async function importFiles(host: PanelHost, modelDir: string, kind: ImportKind, files: File[]): Promise<ImportResult> {
  const withPath = files.map((f) => (f as File & { path?: string }).path).filter((p): p is string => !!p);
  if (withPath.length === files.length) return run(host, modelDir, kind, 'copy', withPath);
  const tmp: string[] = [];
  for (const f of files) tmp.push(await upload(host, modelDir, f));
  const out = await run(host, modelDir, kind, 'move', tmp);
  void host.exec(`rmdir ${sh(`${modelDir}/.import-tmp`)} 2>/dev/null; true`, { timeout: 10000 });
  return out;
}

export function describeImport(r: ImportResult) {
  const parts: string[] = [];
  if (r.placed.length) parts.push(`Added ${r.placed.map((p) => p.file).join(', ')}.`);
  const arch = r.placed.filter((p) => p.archived).map((p) => p.archived);
  if (arch.length) parts.push(`The previous file was kept as ${arch.join(', ')}.`);
  if (r.skipped.length) parts.push(`Skipped: ${r.skipped.map((s) => `${s.file} (${s.why})`).join('; ')}.`);
  return parts.join(' ') || 'Nothing was added.';
}
