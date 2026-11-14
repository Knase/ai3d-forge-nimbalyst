/**
 * Which Claude model and how much reasoning an agent run gets. Defaults per step live in
 * _bmad/ai3d/config.yaml (step_models, step_effort); Run command… and New attempt… override them per run.
 */

export type Effort = 'low' | 'medium' | 'high' | 'max';

export interface RunChoice { model: string; effort: Effort }

/** Model ids for Nimbalyst's claude-code provider ('' = the provider default). */
export const MODELS: { value: string; label: string }[] = [
  { value: '', label: 'Default (Nimbalyst setting)' },
  { value: 'claude-code:opus', label: 'Opus — deepest, slowest, most expensive' },
  { value: 'claude-code:sonnet', label: 'Sonnet — balanced' },
  { value: 'claude-code:haiku', label: 'Haiku — fastest, cheapest' },
];

export const EFFORTS: { value: Effort; label: string; keyword: string }[] = [
  { value: 'low', label: 'Low — no extra thinking', keyword: '' },
  { value: 'medium', label: 'Medium — think', keyword: 'think' },
  { value: 'high', label: 'High — think hard', keyword: 'think hard' },
  { value: 'max', label: 'Max — ultrathink', keyword: 'ultrathink' },
];

/** Run targets: the seven steps plus the agents that run outside a step. */
export const RUN_TARGETS: { id: string; label: string }[] = [
  { id: 'concept', label: '1 Concept (Muse)' }, { id: 'image', label: '2 Image (Lumen)' }, { id: 'mesh', label: '3 3D mesh (Chisel)' },
  { id: 'blender', label: '4 Blender (Kiln)' }, { id: 'validate', label: '5 Validate (Anvil)' }, { id: 'print', label: '6 Test print (Anvil)' },
  { id: 'publish', label: '7 Publish (Herald)' }, { id: 'scout', label: 'Trends (Scout)' }, { id: 'ideas', label: 'Insights (Muse, Prism)' },
  { id: 'help', label: 'Help (Compass)' },
];

export const DEFAULT_MODELS = 'concept=opus,image=sonnet,mesh=sonnet,blender=sonnet,validate=sonnet,print=haiku,publish=haiku,scout=opus,ideas=opus,help=haiku';
export const DEFAULT_EFFORT = 'concept=high,image=medium,mesh=medium,blender=high,validate=medium,print=low,publish=low,scout=high,ideas=high,help=low';

export function parseMap(v: string | undefined, fallback: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of `${fallback},${v ?? ''}`.split(/[,\s]+/)) {
    const [k, val] = part.split('=');
    if (k && val !== undefined) out[k.trim()] = val.trim();
  }
  return out;
}

export const mapString = (m: Record<string, string>) => RUN_TARGETS.map((t) => `${t.id}=${m[t.id] ?? ''}`).join(',');

const SKILL_TARGET: Record<string, string> = {
  'ai3d-scout': 'scout', 'ai3d-prism': 'ideas', 'ai3d-help': 'help', 'ai3d-muse': 'concept', 'ai3d-lumen': 'image', 'ai3d-iterate': 'image',
  'ai3d-chisel': 'mesh', 'ai3d-kiln': 'blender', 'ai3d-anvil': 'validate', 'ai3d-herald': 'publish', 'ai3d-forge': 'concept',
};

/** The configured choice for a step, or for the agent when the run is not on a step. */
export function defaultRun(config: Record<string, string>, step: string | null, skill: string, trigger?: string): RunChoice {
  let target = step ?? SKILL_TARGET[skill] ?? 'concept';
  if (!step && skill === 'ai3d-muse' && (trigger === '*prepare' || trigger === '*idea')) target = 'ideas';
  const models = parseMap(config.step_models, DEFAULT_MODELS);
  const efforts = parseMap(config.step_effort, DEFAULT_EFFORT);
  const short = models[target] ?? '';
  const model = !short || short === 'default' ? '' : short.includes(':') ? short : `claude-code:${short}`;
  const e = efforts[target] as Effort;
  return { model, effort: EFFORTS.some((x) => x.value === e) ? e : 'medium' };
}

export const modelLabel = (m: string) => (m ? m.replace(/^claude-code:/, '').replace(/^./, (c) => c.toUpperCase()) : 'default model');
export const effortKeyword = (e: Effort) => EFFORTS.find((x) => x.value === e)?.keyword ?? '';
