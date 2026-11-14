import type { Action, AgentAction } from './flow';
import type { Model, Scan } from './types';

/**
 * What every panel button runs. The shell builders are used by the panel itself, by the tooltips and by
 * the Help tab, so what you read is what runs. scripts/gen-commands.mjs prints REFERENCE as docs/panel-commands.md.
 */

/** Shell quoting (same as ui.tsx; kept here so this file has no React import and gen-commands.mjs can bundle it). */
const sh = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

const a = (label: string, skill: string, trigger: string): AgentAction => ({ kind: 'agent', label, skill, trigger });

/** Every agent command of each step, for "Run command…" and the reference. */
export const STEP_AGENT: Record<string, AgentAction[]> = {
  concept: [a('Write concept', 'ai3d-muse', '*concept'), a('Re-check model type', 'ai3d-muse', '*type')],
  image: [a('Write image prompt', 'ai3d-lumen', '*prompt'), a('Review inbox', 'ai3d-lumen', '*review'), a('Accept image', 'ai3d-lumen', '*accept'),
    a('Prepare views for 3D (front, left, back, right)', 'ai3d-lumen', '*views'), a('Review the views', 'ai3d-lumen', '*review-views')],
  mesh: [a('Write 3D spec', 'ai3d-chisel', '*3d-prompt'), a('Review mesh', 'ai3d-chisel', '*review-mesh'), a('Accept mesh', 'ai3d-chisel', '*accept-mesh')],
  blender: [a('Optimize in Blender', 'ai3d-kiln', '*optimize'), a('Inspect only', 'ai3d-kiln', '*inspect'), a('Build flexi joints', 'ai3d-kiln', '*flexi'),
    a('Render previews', 'ai3d-kiln', '*render'), a('Export clearance coupon', 'ai3d-kiln', '*coupon'), a('Blender command (free text)', 'ai3d-kiln', '*run')],
  validate: [a('Validate and write slicing notes', 'ai3d-anvil', '*validate'), a('Slicing notes', 'ai3d-anvil', '*slice')],
  print: [a('Log with Anvil (reads the photos)', 'ai3d-anvil', '*print-log')],
  publish: [a('Write README', 'ai3d-herald', '*readme'), a('Mark ready', 'ai3d-herald', '*ready'), a('Write listing', 'ai3d-herald', '*listing'), a('Mark published', 'ai3d-herald', '*publish')],
};

/** Placeholder paths for the reference, when no model or tool path is known. */
const P = {
  dir: '<branch folder>', root: '<models folder>', model: '<model folder>',
  flow: '<skills>/ai3d-forge/scripts/flow_log.py', readme: '<skills>/ai3d-herald/scripts/build-readme.py',
  viewer: '<skills>/ai3d-prism/scripts/build-viewer.py', insights: '<skills>/ai3d-prism/scripts/build-insights.py',
  print: '<skills>/ai3d-anvil/scripts/print_log.py', kiln: '<skills>/ai3d-kiln/scripts/kiln_run.py',
  trend: '<skills>/ai3d-scout/scripts/trend_lib.py', status: '<skills>/ai3d-help/scripts/status.py', blender: '<Blender>',
};
const q = (s: string) => (s.startsWith('<') ? s : sh(s));

export const shell = {
  readme: (tool: string, dir: string, root: string) => `python3 ${q(tool)} ${q(dir)} && python3 ${q(tool)} ${q(root)} --catalog`,
  view: (tool: string, dir: string) => `python3 ${q(tool)} ${q(dir)}`,
  portfolio: (tool: string, root: string) => `python3 ${q(tool)} portfolio ${q(root)}`,
  printSkip: (tool: string, dir: string) => `python3 ${q(tool)} skip ${q(dir)} --reason ${sh('skipped from the panel')}`,
  branchAdd: (tool: string, model: string, o: { name: string; fromNode?: string | null; fromStep?: string; source?: string; review?: boolean; description?: string }) =>
    [`python3 ${q(tool)} branch add ${q(model)} --name ${sh(o.name)}`, o.fromNode ? `--from-node ${sh(o.fromNode)}` : '', o.fromStep ? `--from-step ${o.fromStep}` : '',
      o.source ? `--source ${sh(o.source)}` : '', o.review ? '--review' : '', o.description ? `--description ${sh(o.description)}` : ''].filter(Boolean).join(' '),
  branchPromote: (tool: string, model: string, id: string) => `python3 ${q(tool)} branch promote ${q(model)} ${sh(id)}`,
  branchSet: (tool: string, model: string, id: string, status: string) => `python3 ${q(tool)} branch set ${q(model)} ${sh(id)} --status ${status}`,
  migrate: (tool: string, model: string) => `python3 ${q(tool)} migrate-branches ${q(model)}`,
  helpStatus: (tool: string, root: string, slug?: string) => `python3 ${q(tool)} ${q(root)}${slug ? ` --model ${sh(slug)}` : ''}`,
};

/** One line for a button's tooltip: what it runs. */
export function describe(act: Action, scan: Scan | null, m: Model | null): string {
  const t = scan?.tools;
  const dir = m?.dir ?? P.dir;
  switch (act.kind) {
    case 'agent':
      return `Starts a new agent session: skill ${act.skill}, command ${act.trigger}${m ? ` on ${m.slug}${m.branches.length > 1 ? ` / ${m.branch}` : ''}` : ''}. ⋯ shows the full prompt.`;
    case 'script':
      if (act.script === 'readme') return `Runs: ${shell.readme(t?.buildReadme ?? P.readme, dir, scan?.root ?? P.root)}`;
      if (act.script === 'view') return `Runs: ${shell.view(t?.buildViewer ?? P.viewer, dir)}, then opens view/index.html`;
      if (act.script === 'views-all') return `Runs build-viewer.py for every model with an STL`;
      return `Runs: ${shell.portfolio(t?.buildInsights ?? P.insights, scan?.root ?? P.root)}`;
    case 'form':
      return act.form === 'print-skip' ? `Runs: ${shell.printSkip(t?.printLog ?? P.print, dir)}` : 'Opens the test print form; Save runs print_log.py add and flow_log.py add';
    default:
      return act.copy ? 'Copies the text to the clipboard; you do this step yourself' : 'You do this step yourself';
  }
}

export interface RefRow { area: string; button: string; kind: 'agent' | 'script' | 'headless Blender' | 'shell' | 'form'; runs: string }

const agentRun = (x: AgentAction) => `agent session → ${x.skill} ${x.trigger} (prompt + model, branch work folder, flow node, your instruction)`;
const STEP_TITLES: Record<string, string> = { concept: 'Concept', image: 'Image', mesh: '3D mesh', blender: 'Blender', validate: 'Validate', print: 'Test print', publish: 'Publish' };

/** Every button of the panel and what it runs. */
export const REFERENCE: RefRow[] = [
  ...Object.entries(STEP_AGENT).flatMap(([step, list]) => list.map((x) => ({ area: `Flow · ${STEP_TITLES[step]}`, button: x.label, kind: 'agent' as const, runs: agentRun(x) }))),
  { area: 'Flow · every step', button: 'Run command…', kind: 'agent', runs: 'any command of the step with your instruction added to the prompt; an attempt command first runs flow_log.py add (below)' },
  { area: 'Flow · every attempt', button: 'New attempt… / Run again with changes… / Continue from here…', kind: 'shell',
    runs: `python3 ${P.flow} add ${P.dir} --step <step> --label <label> --status running --parent <node> --settings-json '{…}' → agent session → python3 ${P.flow} settle ${P.dir} <node> --status open|error` },
  { area: 'Flow · node', button: 'Accepted / Rejected / Clear', kind: 'shell', runs: `python3 ${P.flow} update ${P.dir} <node> --verdict accepted|rejected|none` },
  { area: 'Flow · node', button: 'Add note', kind: 'shell', runs: `python3 ${P.flow} note ${P.dir} <node> '<text>'` },
  { area: 'Flow · node', button: 'Cost Save', kind: 'shell', runs: `python3 ${P.flow} update ${P.dir} <node> --cost <service>:<credits>` },
  { area: 'Flow · node', button: 'Archive / Unarchive attempt', kind: 'shell', runs: `python3 ${P.flow} update ${P.dir} <node> --archived yes|no` },
  { area: 'Flow · branches', button: 'New branch… / New branch from here…', kind: 'shell',
    runs: shell.branchAdd(P.flow, P.model, { name: '<name>', fromNode: '<node>', fromStep: '<step>', source: 'image:<file>|mesh:<file>|link:<url>|text:<brief>' }) + ' [--review]' },
  { area: 'Flow · branches', button: 'Make primary', kind: 'shell', runs: shell.branchPromote(P.flow, P.model, '<branch>') },
  { area: 'Flow · branches', button: 'Mark as variant / Archive / Reopen', kind: 'shell', runs: shell.branchSet(P.flow, P.model, '<branch>', 'variant|archived|open') },
  { area: 'Flow · branches', button: 'Move files to branches/', kind: 'shell', runs: shell.migrate(P.flow, P.model) },
  { area: 'Flow · Blender', button: 'Analyze', kind: 'headless Blender', runs: `${P.blender} -b --factory-startup -P ${P.kiln} -- analyze ${P.dir}` },
  { area: 'Flow · Blender', button: 'Quick prep…', kind: 'headless Blender', runs: `flow_log.py add (blender, running) → ${P.blender} -b --factory-startup -P ${P.kiln} -- prep ${P.dir} side=<side> cut_mm=<mm> … → flow_log.py update` },
  { area: 'Flow · Blender', button: 'Flexi…', kind: 'headless Blender', runs: `flow_log.py add → ${P.blender} -b --factory-startup -P ${P.kiln} -- flexi ${P.dir} segments=<n> clearance_mm=<mm> → flow_log.py update` },
  { area: 'Flow · Blender', button: 'Render previews / Coupon', kind: 'headless Blender', runs: `${P.blender} -b --factory-startup -P ${P.kiln} -- render|coupon ${P.dir}` },
  { area: 'Flow · Blender', button: 'Open in Blender', kind: 'shell', runs: 'open -a Blender <file>.blend, or Blender --python-expr "import …" for a mesh' },
  { area: 'Flow · Blender', button: 'Blender command…', kind: 'agent', runs: agentRun(a('', 'ai3d-kiln', '*run')) + ' — Kiln runs your instruction in the open Blender through the Blender MCP' },
  { area: 'Flow · Test print', button: 'Log a test print…', kind: 'form', runs: `python3 ${P.print} add ${P.dir} --result ok|issues|fail --printer … --photos … → flow_log.py add --step print` },
  { area: 'Flow · Test print', button: 'Skip', kind: 'shell', runs: shell.printSkip(P.print, P.dir) },
  { area: 'Flow · Publish', button: 'Build README / Rebuild README (no agent)', kind: 'script', runs: shell.readme(P.readme, P.dir, P.root) },
  { area: 'Flow · header', button: '3D view', kind: 'script', runs: shell.view(P.viewer, P.dir) + ' → opens view/index.html' },
  { area: 'Flow · header', button: 'Open STL in slicer / Show in Finder', kind: 'shell', runs: 'open <file> · open -R <file>' },
  { area: 'Flow · Image', button: 'Add views… (after Prepare views)', kind: 'shell', runs: `osascript (file dialog) → python3 - ${P.dir} view <files> (import.py: copies into inbox/views/)` },
  { area: 'Flow · every step', button: 'Model and reasoning (Run command…, New attempt…, Settings → Agent runs)', kind: 'agent',
    runs: 'sendPrompt({ model: claude-code:opus|sonnet|haiku }) + a thinking line in the prompt (think / think hard / ultrathink); recorded on the node as run_model, run_effort' },
  { area: 'Files', button: 'Add image… / Add 3D model… / drop', kind: 'shell', runs: `osascript (file dialog) → python3 - ${P.dir} image|mesh <files> (import.py: images → inbox/; one 3D file → mesh/raw.<ext>, the old one goes to mesh/attempts/; several → mesh/candidates/; identical files are skipped)` },
  { area: 'Files', button: 'Use as raw mesh (on a candidate)', kind: 'shell', runs: `python3 - ${P.dir} promote copy mesh/candidates/<file> (import.py: copies it to mesh/raw.<ext>)` },
  { area: 'Models', button: 'Portfolio', kind: 'script', runs: shell.portfolio(P.insights, P.root) },
  { area: 'Models', button: 'New model…', kind: 'agent', runs: agentRun(a('', 'ai3d-muse', '*concept')) },
  { area: 'Trends', button: 'Analyse a trend / Similar model / Season / Re-check', kind: 'agent', runs: 'agent session: ai3d-scout *trend | *similar | *season | *watch' },
  { area: 'Trends', button: 'Status, ideas, links', kind: 'shell', runs: `python3 ${P.trend} set|new|link …` },
  { area: 'Insights', button: 'Prepare / Score / New model', kind: 'agent', runs: 'agent session: ai3d-muse *prepare · ai3d-prism *score · ai3d-muse *concept' },
  { area: 'Insights', button: 'Find on the web (Muse)', kind: 'agent', runs: 'agent session → ai3d-muse *refs: web search for pages and pictures; each saved with trend_lib.py ref (pictures downloaded into refs/)' },
  { area: 'Insights', button: 'Add link / Add picture…', kind: 'shell', runs: `python3 ${P.trend} ref <idea folder> --url <URL> | --file <picture> [--note …]` },
  { area: 'Models · Files', button: 'New model… / Concept from this… (picture)', kind: 'agent',
    runs: `agent session → ai3d-muse *concept with the pictures and link in the prompt; as a branch: python3 ${P.flow} branch add ${P.model} --name <name> --from-step concept --source text:<brief> --ref <picture> first` },
  { area: 'Tab bar', button: 'N running → show session / forget', kind: 'shell', runs: 'no command: lists agent runs still in their first turn; forget only stops the panel waiting' },
  { area: 'Insights', button: 'Go / Later / No', kind: 'shell', runs: `python3 ${P.trend} decide <insight dir> go|later|no` },
  { area: 'Help', button: 'Status (no agent)', kind: 'shell', runs: shell.helpStatus(P.status, P.root, '<slug>') },
  { area: 'Help', button: 'Ask ai3d-help: status / next / how / tips', kind: 'agent', runs: 'agent session: ai3d-help *status | *next | *how <step> | *tips <step>' },
  { area: 'Tab bar', button: 'Blender chip → Check', kind: 'shell', runs: 'python3 - <workspace> (blender_status.py: finds Blender, its version, MCP servers in .mcp.json and ~/.claude.json)' },
  { area: 'Every few seconds', button: '(refresh)', kind: 'shell', runs: 'python3 - <workspace> (scan.py: reads models/, trends/, insights/ and flow_log.py list for every model)' },
];
