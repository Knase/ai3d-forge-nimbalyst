/** AI3D Forge module settings: the single source of truth is `_bmad/ai3d/config.yaml`. */
export type FieldKind = 'select' | 'toggle' | 'text' | 'bed' | 'angle' | 'weights' | 'runs' | 'hidden';

export interface Field {
  key: string;
  label: string;
  help: string;
  kind: FieldKind;
  def: string;
  options?: { value: string; label: string }[];
}

export const WEIGHT_DIMS = [
  { id: 'demand', label: 'Demand' },
  { id: 'print_fit', label: 'Print fit' },
  { id: 'differentiation', label: 'Stand-out' },
  { id: 'ip_safety', label: 'IP safety' },
  { id: 'ease', label: 'Ease' },
];

export const BED_PRESETS = [
  { label: 'Bambu A1 mini', value: '180x180x180' },
  { label: 'Bambu A1 / P1 / X1', value: '256x256x256' },
  { label: 'Prusa MK4', value: '250x210x220' },
];

export const GROUPS: { title: string; fields: Field[] }[] = [
  {
    title: 'Pipeline',
    fields: [
      { key: 'image_backend', label: 'Image model', help: 'Gemini model the image prompts are written for.', kind: 'select', def: 'nano-banana-pro',
        options: [{ value: 'nano-banana-pro', label: 'Nano Banana Pro (quality)' }, { value: 'nano-banana-2', label: 'Nano Banana 2 (speed)' }] },
      { key: 'model3d_service', label: '3D service', help: 'Cloud image-to-3D service the 3D specs are written for.', kind: 'select', def: 'tripo3d',
        options: [{ value: 'tripo3d', label: 'Tripo3D' }, { value: 'meshy', label: 'Meshy' }, { value: 'rodin', label: 'Rodin / Hyper3D' }, { value: 'hitem3d', label: 'Hitem3D' }] },
      { key: 'blender_mcp', label: 'Blender MCP connected', help: 'Kiln drives Blender live. Off: Anvil writes a headless fallback.', kind: 'toggle', def: 'true' },
      { key: 'blender_bin', label: 'Blender executable', help: 'For the quick tools (background Blender). auto = /Applications/Blender.app or blender on PATH.', kind: 'text', def: 'auto' },
      { key: 'printbox_watch', label: 'PrintBox handoff', help: 'Keep metadata.json valid for the PrintBox watch folder.', kind: 'toggle', def: 'true' },
      { key: 'publish_target', label: 'Publish target', help: 'Default marketplace for listings.', kind: 'select', def: 'makerworld',
        options: [{ value: 'makerworld', label: 'MakerWorld' }, { value: 'printables', label: 'Printables' }, { value: 'thingiverse', label: 'Thingiverse' }, { value: 'cults3d', label: 'Cults3D' }] },
      { key: 'models_folder', label: 'Models folder', help: 'Where the per-model directories live. Scans and agents read this.', kind: 'text', def: '{project-root}/models' },
      { key: 'trends_folder', label: 'Trends folder', help: 'Trend research: one folder per trend.', kind: 'text', def: '{project-root}/trends' },
      { key: 'insights_folder', label: 'Insights folder', help: 'Idea preparation: one folder per idea.', kind: 'text', def: '{project-root}/insights' },
    ],
  },
  {
    title: 'Printer',
    fields: [
      { key: 'bed_mm', label: 'Bed size (mm)', help: 'X × Y × Z. The 3D view checks every model against it.', kind: 'bed', def: '256x256x256' },
      { key: 'overhang_deg', label: 'Overhang angle', help: 'Faces steeper than this from vertical need support. Used by the 3D view; Kiln has its own parameter.', kind: 'angle', def: '45' },
    ],
  },
  {
    title: 'Agent runs',
    fields: [
      { key: 'step_models', label: 'Model and reasoning per step', help: 'Which Claude model runs each step and how much it thinks first. Run command… and New attempt… can change it for one run. Effort is passed as a thinking keyword in the prompt (think / think hard / ultrathink).', kind: 'runs',
        def: 'concept=opus,image=sonnet,mesh=sonnet,blender=sonnet,validate=sonnet,print=haiku,publish=haiku,scout=opus,ideas=opus,help=haiku' },
      { key: 'step_effort', label: 'Reasoning per step', help: '', kind: 'hidden',
        def: 'concept=high,image=medium,mesh=medium,blender=high,validate=medium,print=low,publish=low,scout=high,ideas=high,help=low' },
    ],
  },
  {
    title: 'Idea scoring',
    fields: [
      { key: 'score_weights', label: 'Weights', help: 'How much each dimension counts in the Prism ranking (0 = ignore, 5 = most important).', kind: 'weights', def: 'demand=3,print_fit=3,differentiation=2,ip_safety=2,ease=1' },
    ],
  },
];

export const FIELDS = GROUPS.flatMap((g) => g.fields);
export const DEFAULTS: Record<string, string> = Object.fromEntries(FIELDS.map((f) => [f.key, f.def]));

export function parseBed(v: string): [number, number, number] {
  const n = (v.match(/\d+(?:\.\d+)?/g) ?? []).map(Number);
  if (n.length === 1) return [n[0], n[0], n[0]];
  return n.length >= 3 ? [n[0], n[1], n[2]] : [256, 256, 256];
}
export const bedString = (b: number[]) => b.join('x');

export function parseWeights(v: string): Record<string, number> {
  const out: Record<string, number> = Object.fromEntries(WEIGHT_DIMS.map((d) => [d.id, 1]));
  for (const part of v.split(/[,\s]+/)) {
    const [k, val] = part.split('=');
    if (k in out && val !== undefined && !Number.isNaN(Number(val))) out[k] = Number(val);
  }
  return out;
}
export const weightsString = (w: Record<string, number>) => WEIGHT_DIMS.map((d) => `${d.id}=${w[d.id]}`).join(',');

/** Parse `key: value` lines (quotes and trailing comments stripped). */
export function parseConfig(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^([A-Za-z_][\w-]*)\s*:\s*(.*?)\s*(?:#.*)?$/);
    if (m && m[2] !== '') out[m[1]] = m[2].trim().replace(/^["']|["']$/g, '');
  }
  return out;
}

const quote = (v: string) => `"${v.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;

/** Change only the given keys; every other line, comment and value stays as it was. */
export function applyUpdates(text: string, updates: Record<string, string>): string {
  let out = text;
  const appended: string[] = [];
  for (const [k, v] of Object.entries(updates)) {
    const re = new RegExp(`^${k}\\s*:.*$`, 'm');
    if (re.test(out)) out = out.replace(re, () => `${k}: ${quote(v)}`);
    else appended.push(`${k}: ${quote(v)}`);
  }
  if (appended.length) {
    const stamp = new Date().toISOString().replace(/\.\d+Z$/, 'Z');
    out = `${out.replace(/\n*$/, '\n')}\n# AI3D Forge values (set from the Nimbalyst panel, ${stamp})\n${appended.join('\n')}\n`;
  }
  return out;
}

export interface ConfigIO {
  read(path: string): Promise<string | null>;
  write(path: string, text: string): Promise<void>;
}
