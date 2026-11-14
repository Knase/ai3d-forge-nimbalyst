import type { FileEntry, FlowNode, Model, Scan } from './types';
import type { Effort } from './runSettings';

/** What a step button does. */
export type Action =
  | { kind: 'agent'; label: string; skill: string; trigger: string; extra?: string }
  | { kind: 'human'; label: string; copy?: string; copyLabel?: string; folder?: string }
  | { kind: 'script'; label: string; script: 'readme' | 'view' | 'views-all' | 'portfolio' }
  | { kind: 'form'; label: string; form: 'print-log' | 'print-skip' };

export type StepState = 'done' | 'active' | 'waiting' | 'locked';

export interface StepView {
  id: string;
  n: number;
  title: string;
  agent: string;
  state: StepState;
  /** One line: what the result of this step is right now. */
  result: string;
  /** One line: what happens next on this step. */
  hint: string;
  /** Image shown on the step card, as a path relative to the model folder. */
  thumb: string | null;
  primary: Action | null;
  more: Action[];
}

const IMG = /\.(png|jpe?g|webp|gif)$/i;
export const isImage = (f: FileEntry) => IMG.test(f.name);
export const images = (list: FileEntry[]) => list.filter(isImage);

const has = (list: FileEntry[], test: RegExp) => list.some((f) => test.test(f.name));
const agent = (label: string, skill: string, trigger: string, extra?: string): Action => ({
  kind: 'agent', label, skill, trigger, extra,
});

function kb(n: number) {
  return n >= 1e6 ? `${(n / 1e6).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1000))} KB`;
}

export function fileSize(n: number) {
  return kb(n);
}

/** Build the seven steps for one model from what is on disk. */
export function buildSteps(m: Model, scan: Scan): StepView[] {
  const st = m.meta.stages ?? {};
  const f = m.files;
  const inbox = images(f.inbox);
  const accepted = images(f.images);
  const renders = images(f.renders);
  const raw = f.mesh.find((x) => /^raw\./i.test(x.name));
  const cands = (m.candidates ?? []).filter((x) => /\.(stl|glb|gltf|obj|fbx)$/i.test(x.name));
  const printStl = f.mesh.find((x) => x.name === 'print.stl') ?? f.mesh.find((x) => x.name === 'clean.stl');
  const flexi = m.meta.model_type === 'flexi';
  const after = m.analysis?.after ?? m.analysis?.analysis ?? null;
  const status = m.meta.status ?? 'concept';

  const conceptDone = !!st.concept?.done || /\*\*Subject:\*\*\s*\S/.test(m.concept ?? '');
  const imageDone = !!st.image?.done || accepted.length > 0;
  const meshDone = !!st.mesh?.done || (!!raw && !!printStl);
  const blenderDone = !!printStl;
  const validateDone = has(f.print, /^slicing-notes\.md$/);
  const publishDone = m.hasReadme && (status === 'ready' || status === 'published');
  const tests = m.printLog.filter((e) => !e.skipped);
  const lastTest = tests[tests.length - 1] ?? null;
  const printSkipped = !lastTest && m.printLog.some((e) => e.skipped);
  const printDone = !!st.print_test?.done || m.printLog.length > 0;
  const done = [conceptDone, imageDone, meshDone, blenderDone, validateDone, printDone, publishDone];
  // views for multi-view 3D that were asked for, or wait for review, hold the image step until the mesh exists
  if (!raw && (images(m.viewsInbox ?? []).length || (m.viewsPrompt && !images(m.views ?? []).length))) done[1] = false;
  // a branch copied every step before the one it starts at from its parent branch: those count as done here
  const own = m.branch && m.branch !== 'main' ? m.branches?.find((b) => b.id === m.branch) : null;
  const inherited = own ? Math.max(0, ['concept', 'image', 'mesh', 'blender', 'validate', 'print', 'publish'].indexOf(own.from_step)) : 0;
  for (let i = 0; i < inherited; i++) done[i] = true;
  const firstOpen = done.indexOf(false);

  const steps: Omit<StepView, 'state' | 'n'>[] = [];

  // 1 Concept
  steps.push({
    id: 'concept', title: 'Concept', agent: 'Muse',
    result: conceptDone ? `${m.meta.model_type ?? 'type not set'} · ${m.meta.scale_mm ? m.meta.scale_mm + ' mm' : 'scale not set'}` : 'No concept yet',
    hint: conceptDone ? 'Concept is written. Re-run to change type or scale.' : 'Muse writes the concept and picks static / flexi / functional.',
    thumb: null,
    primary: conceptDone ? null : agent('Write concept', 'ai3d-muse', '*concept'),
    more: [agent('Re-check model type', 'ai3d-muse', '*type')],
  });

  // 2 Image
  let imgPrimary: Action | null;
  let imgHint: string;
  const views = images(m.views ?? []);
  const viewsWaiting = images(m.viewsInbox ?? []);
  const viewsAsked = !!m.viewsPrompt && !views.length && !viewsWaiting.length && !raw;
  if (imageDone && viewsAsked) {
    imgPrimary = {
      kind: 'human', label: 'Generate the views in Gemini, save them into inbox/views/',
      copy: m.viewsPrompt?.text ?? '', copyLabel: `Copy ${m.viewsPrompt?.name}`, folder: 'inbox/views',
    };
    imgHint = `Your turn: run each view prompt of ${m.viewsPrompt?.name} in Gemini with the accepted image attached; save front.png, left.png, back.png, right.png into inbox/views/.`;
  } else if (imageDone && viewsWaiting.length > 0) {
    imgPrimary = agent(`Review ${viewsWaiting.length} view${viewsWaiting.length === 1 ? '' : 's'}`, 'ai3d-lumen', '*review-views');
    imgHint = 'Lumen checks the views against the accepted image (same proportions, colours, pose) and files them as front / left / back / right.';
  } else if (imageDone) {
    imgPrimary = null;
    imgHint = `${accepted.length} image${accepted.length === 1 ? '' : 's'} accepted.${views.length ? ` ${views.length} views for multi-view 3D.`
      : ' Optional: prepare front / left / back / right views for multi-view 3D (Other actions → Prepare views).'}`;
  } else if (inbox.length > 0) {
    imgPrimary = agent(`Review ${inbox.length} image${inbox.length === 1 ? '' : 's'} in inbox`, 'ai3d-lumen', '*review');
    imgHint = 'Lumen reads the inbox images and either accepts one or writes the next prompt.';
  } else if (m.imagePrompt) {
    imgPrimary = {
      kind: 'human', label: 'Generate in Gemini, save into inbox/',
      copy: m.imagePrompt.text ?? '', copyLabel: `Copy ${m.imagePrompt.name}`, folder: 'inbox',
    };
    imgHint = `Your turn: paste ${m.imagePrompt.name} into Gemini and save the image into inbox/.`;
  } else {
    imgPrimary = agent('Write image prompt', 'ai3d-lumen', '*prompt');
    imgHint = 'Lumen writes the first Gemini prompt.';
  }
  steps.push({
    id: 'image', title: 'Image', agent: 'Lumen',
    result: imageDone ? `${accepted.length} accepted${views.length ? ` · ${views.length} views` : ''}` : inbox.length ? `${inbox.length} in inbox` : m.imagePrompt ? `${m.imagePrompt.name} ready` : 'No prompt yet',
    hint: imgHint,
    thumb: accepted[0] ? `images/${accepted[0].name}` : inbox[0] ? `inbox/${inbox[0].name}` : null,
    primary: imgPrimary,
    more: [
      agent('Write next prompt', 'ai3d-lumen', '*prompt'),
      agent('Review inbox', 'ai3d-lumen', '*review'),
      agent('Accept image', 'ai3d-lumen', '*accept'),
      agent('Prepare views for 3D (front, left, back, right)', 'ai3d-lumen', '*views'),
      agent('Review the views', 'ai3d-lumen', '*review-views'),
    ],
  });

  // 3 Mesh
  let meshPrimary: Action | null;
  let meshHint: string;
  if (meshDone) {
    meshPrimary = null;
    meshHint = 'Mesh accepted.';
  } else if (raw) {
    meshPrimary = agent('Review the mesh', 'ai3d-chisel', '*review-mesh');
    meshHint = 'Chisel checks the mesh against the concept and accepts it or changes the settings.';
  } else if (cands.length) {
    meshPrimary = agent('Compare the variants', 'ai3d-chisel', '*review-mesh');
    meshHint = `${cands.length} variants are waiting in mesh/candidates/. Use one as the raw mesh (Files → 3D files → “Use as raw mesh”), or let Chisel compare them and recommend one.`;
  } else if (m.prompt3d) {
    meshPrimary = {
      kind: 'human', label: 'Run the 3D service, then Add 3D model…',
      copy: m.prompt3d, copyLabel: 'Copy 3D spec', folder: 'mesh',
    };
    meshHint = 'Your turn: upload the accepted image to the 3D service and add the export with “Add 3D model…” (GLB or STL; if the service gives several variants, add them all and choose one).';
  } else {
    meshPrimary = agent('Write 3D spec', 'ai3d-chisel', '*3d-prompt');
    meshHint = 'Chisel writes the service settings for the accepted image.';
  }
  steps.push({
    id: 'mesh', title: '3D mesh', agent: 'Chisel',
    result: raw ? `${raw.name} · ${kb(raw.size)}` : cands.length ? `${cands.length} variants to choose from` : m.prompt3d ? '3D spec ready' : 'No mesh yet',
    hint: meshHint, thumb: null, primary: meshPrimary,
    more: [
      agent('Write 3D spec', 'ai3d-chisel', '*3d-prompt'),
      agent('Review mesh', 'ai3d-chisel', '*review-mesh'),
      agent('Accept mesh', 'ai3d-chisel', '*accept-mesh'),
    ],
  });

  // 4 Blender
  const blenderMore: Action[] = [
    agent('Inspect only', 'ai3d-kiln', '*inspect'),
    agent('Optimize again', 'ai3d-kiln', '*optimize'),
    agent('Build flexi joints', 'ai3d-kiln', '*flexi'),
    agent('Render previews', 'ai3d-kiln', '*render'),
    { kind: 'script', label: 'Build interactive 3D view', script: 'view' },
    agent('Export clearance coupon', 'ai3d-kiln', '*coupon'),
    agent('Blender command (free text)', 'ai3d-kiln', '*run'),
  ];
  steps.push({
    id: 'blender', title: 'Blender', agent: 'Kiln',
    result: printStl
      ? [after?.overhang_pct != null ? `overhang ${after.overhang_pct} %` : null, m.analysis?.side_on_bed ? `${m.analysis.side_on_bed} on bed` : null, kb(printStl.size)].filter(Boolean).join(' · ')
      : 'Not optimised yet',
    hint: printStl
      ? flexi ? 'Print file exists. Build or rebuild flexi joints if needed.' : 'Print file exists.'
      : 'Kiln works in Blender: solid mesh, bed side, flat cut, overhang check. It asks you for two verdicts.',
    thumb: renders[0] ? `renders/${renders[0].name}` : null,
    primary: printStl ? null : agent('Optimize in Blender', 'ai3d-kiln', '*optimize'),
    more: blenderMore,
  });

  // 5 Validate
  steps.push({
    id: 'validate', title: 'Validate', agent: 'Anvil',
    result: validateDone ? 'Slicing notes written' : 'Not validated yet',
    hint: validateDone ? 'Checklist and slicing notes are in print/.' : 'Anvil runs the print-ready checklist and writes the slicing notes.',
    thumb: null,
    primary: validateDone ? null : agent('Validate and write slicing notes', 'ai3d-anvil', '*validate', 'When the checklist passes, continue with *slice.'),
    more: [agent('Validate', 'ai3d-anvil', '*validate'), agent('Slicing notes', 'ai3d-anvil', '*slice')],
  });

  // 6 Test print
  const photos = images(m.printPhotos);
  steps.push({
    id: 'print', title: 'Test print', agent: 'Anvil',
    result: lastTest ? `${lastTest.result}${lastTest.printer ? ` · ${lastTest.printer}` : ''}${tests.length > 1 ? ` · ${tests.length} prints` : ''}` : printSkipped ? 'Skipped' : 'Not printed yet',
    hint: lastTest ? (lastTest.change ? `Change next time: ${lastTest.change}` : 'Logged. Print again after changes, or move on.') : printSkipped ? 'Skipped for this model.'
      : 'Print mesh/print.stl, then log the result with a photo. Or skip it for a shape you have already proven.',
    thumb: photos.length ? `print/photos/${photos[photos.length - 1].name}` : null,
    primary: printDone ? null : { kind: 'human', label: 'Print mesh/print.stl, then log the result', folder: 'print' },
    more: [
      { kind: 'form', label: 'Log a test print…', form: 'print-log' },
      { kind: 'form', label: 'Skip the test print', form: 'print-skip' },
      agent('Log with Anvil (reads the photos)', 'ai3d-anvil', '*print-log'),
    ],
  });

  // 7 Publish
  let pubPrimary: Action | null;
  if (!m.hasReadme) {
    pubPrimary = m.meta.summary && scan.tools.buildReadme
      ? { kind: 'script', label: 'Build README', script: 'readme' }
      : agent('Write README', 'ai3d-herald', '*readme');
  } else if (status !== 'ready' && status !== 'published') {
    pubPrimary = agent('Mark ready', 'ai3d-herald', '*ready');
  } else {
    pubPrimary = null;
  }
  const pubMore: Action[] = [
    agent('Write README text', 'ai3d-herald', '*readme'),
    agent('Mark ready', 'ai3d-herald', '*ready'),
    agent('Write listing', 'ai3d-herald', '*listing'),
    agent('Mark published', 'ai3d-herald', '*publish'),
  ];
  if (scan.tools.buildReadme) pubMore.unshift({ kind: 'script', label: 'Rebuild README (no agent)', script: 'readme' });
  steps.push({
    id: 'publish', title: 'Publish', agent: 'Herald',
    result: m.hasReadme ? `README · ${status}` : 'No README yet',
    hint: publishDone ? 'Model is ready.' : m.hasReadme ? 'README exists. Mark the model ready when you are happy with it.' : 'Herald builds the README with images, description and the STL link.',
    thumb: null, primary: pubPrimary, more: pubMore,
  });

  return steps.map((s, i) => {
    let state: StepState;
    if (done[i]) state = 'done';
    else if (firstOpen === i) state = s.primary?.kind === 'human' ? 'waiting' : 'active';
    else state = 'locked';
    return { ...s, n: i + 1, state };
  });
}

export type AgentAction = Extract<Action, { kind: 'agent' }>;

export const STEP_IDS = ['concept', 'image', 'mesh', 'blender', 'validate', 'print', 'publish'] as const;

const act = (label: string, skill: string, trigger: string): AgentAction => ({ kind: 'agent', label, skill, trigger });

/** Agent actions that start a new attempt, that is, a new node in the model's flow graph. */
const ATTEMPT_TRIGGERS = new Set([
  'ai3d-muse *concept', 'ai3d-lumen *prompt', 'ai3d-lumen *views', 'ai3d-chisel *3d-prompt',
  'ai3d-kiln *optimize', 'ai3d-kiln *flexi', 'ai3d-anvil *validate', 'ai3d-herald *readme',
]);
export const isAttempt = (a: Action): a is AgentAction => a.kind === 'agent' && ATTEMPT_TRIGGERS.has(`${a.skill} ${a.trigger}`);

/** What "New attempt" can run on each step. */
export const ATTEMPT_CHOICES: Record<string, AgentAction[]> = {
  concept: [act('Write concept', 'ai3d-muse', '*concept')],
  image: [act('Write image prompt', 'ai3d-lumen', '*prompt'), act('Prepare views for 3D', 'ai3d-lumen', '*views')],
  mesh: [act('Write 3D spec', 'ai3d-chisel', '*3d-prompt')],
  blender: [act('Optimize in Blender', 'ai3d-kiln', '*optimize'), act('Build flexi joints', 'ai3d-kiln', '*flexi')],
  validate: [act('Validate and write slicing notes', 'ai3d-anvil', '*validate')],
  publish: [act('Write README', 'ai3d-herald', '*readme')],
};

/** Setting keys offered when you add settings to an attempt (free text is allowed too). */
export const SETTING_HINTS: Record<string, string[]> = {
  concept: ['model_type', 'scale_mm', 'style'],
  image: ['backend', 'mode', 'aspect', 'references'],
  mesh: ['service', 'texture', 'topology', 'segmentation', 'symmetry', 'face_limit'],
  blender: ['side_on_bed', 'cut_mm', 'overhang_deg', 'flexi', 'segments', 'clearance_mm'],
  validate: ['slicer', 'nozzle_mm', 'layer_mm'],
  publish: ['status'],
};

export interface AttemptInfo {
  node: FlowNode;
  /** Absolute path of flow_log.py. */
  flowLog: string | null;
}

/** The prompt sent to the agent session for one action. */
export function agentPrompt(a: Extract<Action, { kind: 'agent' }>, m: Model | null, scan: Scan, input?: string, attempt?: AttemptInfo, effort?: Effort) {
  const rel = scan.root.startsWith(scan.workspace) ? scan.root.slice(scan.workspace.length + 1) || '.' : scan.root;
  const lines = [`Use the \`${a.skill}\` skill from the AI3D Forge BMAD module and run its \`${a.trigger}\` action.`];
  const ws = (p: string) => (p.startsWith(scan.workspace) ? p.slice(scan.workspace.length + 1) || '.' : p);
  if (m) {
    lines.push(`Model: \`${m.slug}\` — model folder \`${ws(m.rootDir ?? `${scan.root}/${m.slug}`)}/\`. Work only on this model.`);
    if (m.migrated || m.branches?.length > 1) {
      const b = m.branches.find((x) => x.id === m.branch);
      lines.push(`Branch: \`${m.branch}\`${b && b.name !== m.branch ? ` (${b.name})` : ''}. Work folder: \`${ws(m.dir)}/\` — read and write every step file`
        + ' (concept.md, metadata.json, prompts/, inbox/, images/, mesh/, print/, renders/, publish/, README.md) in this folder, not in the model folder.'
        + ' flow.json stays in the model folder; flow_log.py accepts the work folder and records the branch.');
      if (b?.source) lines.push(`This branch started from a ${b.source.kind}: ${b.source.kind === 'text' ? 'see refs/source.md' : b.source.ref}${b.source.kind === 'link' ? ' (also in refs/source.md)' : ''}.`);
      if (b?.description) lines.push(`Why this branch: ${b.description}`);
    }
  } else lines.push(`Models folder: \`${rel}/\`.`);
  if (input) lines.push(`Input from the user: ${input}`);
  if (attempt && m) {
    const n = attempt.node;
    lines.push(`Flow node: \`${n.id}\` (step ${n.step}), created by the panel with status running. Do not add a new node: update this one when you finish`
      + (attempt.flowLog ? ` with \`python3 ${attempt.flowLog} update ${m.dir} ${n.id} ...\`` : '')
      + ' (rules: ai3d-forge/references/flow-graph.md).');
    if (n.parent) lines.push(`This attempt grows from node \`${n.parent}\`.`);
    const kv = Object.entries(n.settings);
    if (kv.length) lines.push(`Settings for this attempt, use exactly these and do not fall back to defaults: ${kv.map(([k, v]) => `${k}=${v}`).join(', ')}.`);
    if (n.description) lines.push(`What is different this time: ${n.description}`);
  }
  if (a.extra) lines.push(a.extra);
  lines.push('Follow the skill\'s HALT rules: stop and ask me whenever a verdict or an off-tool step is needed.');
  if (effort === 'medium') lines.push('Think about the options before you act.');
  if (effort === 'high') lines.push('Think hard: weigh the options and check the numbers before you act.');
  if (effort === 'max') lines.push('Ultrathink: this step needs your deepest reasoning before you act.');
  return lines.join('\n');
}
