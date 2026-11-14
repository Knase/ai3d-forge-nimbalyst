// Prints the panel's command reference (src/commands.ts REFERENCE) as Markdown.
//   node scripts/gen-commands.mjs > ../skills/ai3d-help/references/panel-commands.md
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const out = await build({ entryPoints: [path.join(root, 'src/commands.ts')], bundle: true, format: 'esm', write: false, platform: 'node' });
const mod = await import(`data:text/javascript;base64,${Buffer.from(out.outputFiles[0].text).toString('base64')}`);
const esc = (s) => String(s).replace(/\|/g, '\\|');
const lines = [
  '# AI3D Forge panel — what each button runs',
  '',
  'Generated from `nimbalyst-extension/src/commands.ts` (`node scripts/gen-commands.mjs`); the panel uses the same',
  'builders, so this is what runs. `<skills>` is where the module is installed (usually `.claude/skills`),',
  '`<branch folder>` is `models/<slug>/branches/<branch>/` (or the model folder before branches/ exists).',
  '',
  'Agent buttons start a new session in Nimbalyst with a prompt: “Use the `<skill>` skill from the AI3D Forge BMAD',
  'module and run its `<trigger>` action”, then the model folder, the branch work folder, the flow node, your',
  'settings and instruction. On a step, **Run command…** (or ⋯ next to the main button) shows that prompt in full.',
  '',
  '| Where | Button | Kind | Runs |',
  '|---|---|---|---|',
  ...mod.REFERENCE.map((r) => `| ${esc(r.area)} | ${esc(r.button)} | ${r.kind} | \`${esc(r.runs)}\` |`),
  '',
  '## Agent commands per step',
  '',
  '| Step | Button | Skill | Trigger |',
  '|---|---|---|---|',
  ...Object.entries(mod.STEP_AGENT).flatMap(([step, list]) => list.map((x) => `| ${step} | ${esc(x.label)} | \`${x.skill}\` | \`${x.trigger}\` |`)),
  '',
];
process.stdout.write(lines.join('\n'));
