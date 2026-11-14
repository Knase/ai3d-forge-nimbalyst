import type { PanelHost } from '@nimbalyst/extension-sdk';
import statusSource from './blender_status.py?raw';
import { isMac, sh } from './ui';

export interface BlenderStatus {
  bin: string | null;
  configured: string;
  version: string | null;
  running: boolean | null;
  mcp: { where: string; name: string; forSessions: boolean }[];
  /** Every MCP server found in the configs (used for the Apify check). */
  servers?: { where: string; name: string; forSessions: boolean }[];
  checkedAt: number;
}

export type KilnCommand = 'analyze' | 'prep' | 'flexi' | 'render' | 'coupon';

export interface KilnResult {
  ok: boolean;
  command?: string;
  problems?: string[];
  files?: string[];
  archived?: string | null | string[];
  side_on_bed?: string;
  source?: string;
  before?: Record<string, any>;
  after?: Record<string, any>;
  analysis?: Record<string, any>;
  orientations?: { side: string; overhang_pct: number; height_mm?: number; footprint_mm2?: number; stable?: boolean }[];
  flexi?: Record<string, any>;
  [k: string]: unknown;
}

export async function checkBlender(host: PanelHost, configured: string): Promise<BlenderStatus> {
  const res = await host.exec(`python3 - ${sh(host.workspacePath)} ${sh(configured || 'auto')} <<'A3D_BL'\n${statusSource}\nA3D_BL`, { timeout: 60000 });
  if (!res.success) throw new Error(res.stderr.trim().split('\n').pop() || 'Blender check failed');
  return JSON.parse(res.stdout.trim().split('\n').pop() ?? '{}') as BlenderStatus;
}

/** One headless Kiln command in a background Blender. Never throws for a bad shape: read ok / problems. */
export async function runKiln(host: PanelHost, bin: string, kilnRun: string, cmd: KilnCommand, modelDir: string, opts: Record<string, string>): Promise<KilnResult> {
  const args = Object.entries(opts).filter(([, v]) => v !== '').map(([k, v]) => sh(`${k}=${v}`)).join(' ');
  const res = await host.exec(`${sh(bin)} -b --factory-startup -P ${sh(kilnRun)} -- ${cmd} ${sh(modelDir)} ${args}`, { timeout: 900000, maxBuffer: 20_000_000 });
  const line = (res.stdout ?? '').split('\n').reverse().find((l) => l.startsWith('A3D_RESULT '));
  if (line) return JSON.parse(line.slice('A3D_RESULT '.length)) as KilnResult;
  const tail = `${res.stderr ?? ''}\n${res.stdout ?? ''}`.trim().split('\n').filter(Boolean).slice(-3).join(' · ');
  return { ok: false, command: cmd, problems: [`Blender did not finish: ${tail || 'no output'}`], crashed: true };
}

/** Open a file in the Blender app (a new window). .blend opens directly; meshes are imported into an empty scene. */
export async function openInBlender(host: PanelHost, bin: string | null, path: string) {
  const app = isMac() && (!bin || bin.includes('.app/'));
  if (!path) return host.exec(app ? 'open -a Blender' : `nohup ${sh(bin ?? 'blender')} >/dev/null 2>&1 &`, { timeout: 15000 });
  const ext = path.split('.').pop()?.toLowerCase() ?? '';
  if (ext === 'blend') {
    const cmd = app ? `open -a Blender ${sh(path)}` : `nohup ${sh(bin ?? 'blender')} ${sh(path)} >/dev/null 2>&1 &`;
    return host.exec(cmd, { timeout: 15000 });
  }
  const p = JSON.stringify(path);
  const op = ext === 'stl' ? `bpy.ops.wm.stl_import(filepath=${p})`
    : ext === 'obj' ? `bpy.ops.wm.obj_import(filepath=${p})`
    : ext === 'fbx' ? `bpy.ops.import_scene.fbx(filepath=${p})`
    : `bpy.ops.import_scene.gltf(filepath=${p})`;
  const expr = `import bpy; bpy.ops.wm.read_homefile(use_empty=True); ${op}`;
  return host.exec(`nohup ${sh(bin ?? 'blender')} --python-expr ${sh(expr)} >/dev/null 2>&1 &`, { timeout: 15000 });
}

/** One line for a flow node or a banner. */
export function summarize(r: KilnResult): string {
  if (!r.ok && r.problems?.length) return r.problems.join(' ');
  const a = (r.after ?? r.analysis) as Record<string, any> | undefined;
  const b = r.before as Record<string, any> | undefined;
  const parts: string[] = [];
  if (r.command === 'flexi' && r.flexi) parts.push(`${r.flexi.joints ?? '?'} joints`);
  if (a?.overhang_pct != null) parts.push(`overhang ${a.overhang_pct} %${b?.overhang_pct != null ? ` (was ${b.overhang_pct} %)` : ''}`);
  if (r.side_on_bed) parts.push(`${r.side_on_bed} on bed`);
  if (a?.size_mm) parts.push(`${(a.size_mm as number[]).map((n) => Math.round(n)).join('×')} mm`);
  if (a?.watertight === false) parts.push('not watertight');
  return parts.join(', ') || (r.files?.length ? `wrote ${r.files.join(', ')}` : 'done');
}
