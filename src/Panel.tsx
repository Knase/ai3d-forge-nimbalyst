import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import type { PanelHost, PanelHostProps } from '@nimbalyst/extension-sdk';
import scanSource from './scan.py?raw';
import { agentPrompt, ATTEMPT_CHOICES, buildSteps, fileSize, images, isAttempt, type Action, type AgentAction, type AttemptInfo, type StepView } from './flow';
import { AttemptDialog, type AttemptRequest } from './AttemptDialog';
import { FlowGraph, NodeDetail, visibleNodes } from './FlowGraph';
import { CompareView } from './Compare';
import { PrintLogDialog, type PrintLogRequest } from './PrintLog';
import { defaultParent, nodesOfStep, rerunParent, stepIndex } from './flowGraph';
import { settings } from './settings';
import { BlenderBlock, BlenderChip, BlenderDialog, KilnDialog, type QuickRequest } from './BlenderTools';
import { checkBlender, openInBlender, runKiln, summarize, type BlenderStatus, type KilnCommand, type KilnResult } from './blender';
import { FilesTab } from './FilesTab';
import { describeImport, importFiles, importPaths, kindOf, pickWithSystemDialog, upload, type ImportKind } from './importFiles';
import { IdeasTab, type IdeaAction } from './IdeasTab';
import { ModelsTab } from './ModelsTab';
import { TrendsTab, type TrendAction } from './TrendsTab';
import { Palette, type Command } from './Palette';
import { SettingsForm } from './SettingsForm';
import type { ConfigIO } from './config';
import * as runStore from './runs';
import { Img, isMac, openCmd, revealCmd, sh } from './ui';
import { branchLabel, branchNodes, currentBranch, dirOf, laneIndex, nodeBranch, parentFor, withBranch } from './branches';
import { describe, shell } from './commands';
import { HelpTab } from './HelpTab';
import { NewBranchDialog, type BranchRequest } from './NewBranchDialog';
import { RunCommandDialog, type RunRequest } from './RunCommandDialog';
import { parseTips, StepTips } from './Tips';
import { missingFeatures, outdated, updateCommand } from './health';
import { EXPECTED_MODULE } from './version';
import { NewModelDialog, type NewModelRequest } from './NewModelDialog';
import { defaultRun, effortKeyword, modelLabel } from './runSettings';
import type { FileEntry, FlowNode, Folder, Insight, Model, Run, Scan, Trend, TrendIdea } from './types';

const POLL_MS = 4000;

/** Model and reasoning recorded on an attempt node, so the graph shows what each try ran with. */
function runSettingsOf(config: Record<string, string>, step: string, a: AgentAction, over?: { model: string; effort: 'low' | 'medium' | 'high' | 'max' }) {
  const c = { ...defaultRun(config, step, a.skill, a.trigger), ...(over ?? {}) };
  return { run_model: c.model ? c.model.replace(/^claude-code:/, '') : 'default', run_effort: c.effort };
}
const GLOBAL = '_global';

async function scanWorkspace(host: PanelHost): Promise<Scan> {
  const cmd = `python3 - ${sh(host.workspacePath)} ${sh(settings.modelsRoot)} <<'A3D_SCAN'\n${scanSource}\nA3D_SCAN`;
  const res = await host.exec(cmd, { timeout: 20000 });
  if (!res.success) throw new Error(res.stderr.trim() || 'Could not scan the models folder (is python3 installed?).');
  return JSON.parse(res.stdout) as Scan;
}

/** Config file access through the shell, used by the Settings tab. */
function execIo(host: PanelHost): ConfigIO {
  return {
    read: async (p) => {
      const r = await host.exec(`[ -f ${sh(p)} ] && cat ${sh(p)}`, { timeout: 10000 });
      return r.success ? r.stdout : null;
    },
    write: async (p, t) => {
      if (t.includes('A3D_CFG_EOF')) throw new Error('Refusing to write: the text contains the heredoc marker.');
      const r = await host.exec(`cat > ${sh(p)} <<'A3D_CFG_EOF'\n${t.replace(/\n*$/, '\n')}A3D_CFG_EOF`, { timeout: 10000 });
      if (!r.success) throw new Error(r.stderr.trim() || 'write failed');
    },
  };
}

function Gallery({ host, model, folder, title, onZoom, empty }: {
  host: PanelHost; model: Model; folder: Folder; title: string; empty?: string;
  onZoom: (z: { path: string; mtime: number; name: string }) => void;
}) {
  const list = images(model.files[folder]);
  if (!list.length && !empty) return null;
  return (
    <section className="a3d-block">
      <h4>{title} <span className="a3d-count">{list.length}</span></h4>
      {list.length === 0 ? <p className="a3d-muted">{empty}</p> : (
        <div className="a3d-gallery">
          {list.map((f) => {
            const path = `${model.dir}/${folder}/${f.name}`;
            return (
              <figure key={f.name}>
                <Img host={host} path={path} mtime={f.mtime} alt={f.name} onClick={() => onZoom({ path, mtime: f.mtime, name: f.name })} />
                <figcaption title={f.name}>{f.name}</figcaption>
              </figure>
            );
          })}
        </div>
      )}
    </section>
  );
}

function TextBlock({ title, text, onOpen, copyLabel }: { title: string; text: string | null; onOpen?: () => void; copyLabel?: string }) {
  const [copied, setCopied] = useState(false);
  if (!text) return null;
  const copy = async () => {
    await navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };
  return (
    <section className="a3d-block">
      <h4>
        {title}
        <span className="a3d-block-actions">
          <button type="button" className="a3d-btn a3d-btn-small" onClick={copy}>{copied ? 'Copied' : copyLabel ?? 'Copy'}</button>
          {onOpen && <button type="button" className="a3d-btn a3d-btn-small" onClick={onOpen}>Open file</button>}
        </span>
      </h4>
      <pre className="a3d-text">{text}</pre>
    </section>
  );
}

function FileList({ title, model, folder, files, onOpen, onExternal }: {
  title: string; model: Model; folder: Folder; files: FileEntry[];
  onOpen: (path: string) => void; onExternal: (path: string) => void;
}) {
  if (!files.length) return null;
  return (
    <section className="a3d-block">
      <h4>{title}</h4>
      <ul className="a3d-files">
        {files.map((f) => {
          const path = `${model.dir}/${folder}/${f.name}`;
          const isText = /\.(md|json|txt|ya?ml)$/i.test(f.name);
          return (
            <li key={f.name}>
              <span className="a3d-file-name">{folder}/{f.name}</span>
              <span className="a3d-muted">{fileSize(f.size)}</span>
              <button type="button" className="a3d-btn a3d-btn-small" onClick={() => (isText ? onOpen(path) : onExternal(path))}>
                {isText ? 'Open' : 'Open in app'}
              </button>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

function Metrics({ model }: { model: Model }) {
  const a = model.analysis;
  const after = a?.after ?? a?.analysis ?? null;
  const flexi = a?.flexi ?? null;
  if (!after && !flexi) return null;
  const items: [string, string, ('good' | 'bad')?][] = [];
  if (after?.overhang_pct != null) items.push(['Overhang', `${after.overhang_pct} %`]);
  if (a?.before?.overhang_pct != null) items.push(['Overhang before', `${a.before.overhang_pct} %`]);
  if (a?.side_on_bed) items.push(['Side on bed', String(a.side_on_bed)]);
  if (a?.cut_mm != null) items.push(['Flat cut', `${a.cut_mm} mm`]);
  if (after?.size_mm) items.push(['Size', `${after.size_mm.join(' × ')} mm`]);
  if (after?.watertight != null) items.push(['Watertight', after.watertight ? 'yes' : 'no', after.watertight ? 'good' : 'bad']);
  if (after?.shells != null) items.push(['Shells', String(after.shells)]);
  if (flexi) {
    items.push(['Joints', `${flexi.joints} of ${Math.max(0, (flexi.segments ?? 1) - 1 + (flexi.skipped_cuts?.length ?? 0))} cuts`]);
    items.push(['Joint check', flexi.ok ? 'all held and free' : 'failed', flexi.ok ? 'good' : 'bad']);
    if (flexi.clearance_mm != null) items.push(['Clearance', `${flexi.clearance_mm} mm`]);
  }
  return (
    <section className="a3d-block">
      <h4>Print analysis</h4>
      <dl className="a3d-metrics">
        {items.map(([k, v, tone]) => (
          <div key={k} className={tone ? `a3d-metric a3d-${tone}` : 'a3d-metric'}><dt>{k}</dt><dd>{v}</dd></div>
        ))}
      </dl>
    </section>
  );
}

function when(ts: number) {
  const d = new Date(ts);
  const today = new Date().toDateString() === d.toDateString();
  return today ? d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : d.toLocaleDateString([], { month: 'short', day: 'numeric' });
}

export function ForgePanel({ host }: PanelHostProps) {
  const [theme, setTheme] = useState<string>(() => String(host.theme ?? 'light'));
  useEffect(() => host.onThemeChanged?.((t: unknown) => setTheme(String(t))), [host]);
  const [scan, setScan] = useState<Scan | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [slug, setSlug] = useState<string | null>(null);
  const [stepId, setStepId] = useState<string | null>(null);
  const [viewKey, setViewKey] = useState<string>(GLOBAL);
  const [viewRun, setViewRun] = useState<number | null>(null);
  const [dialog, setDialog] = useState<'new' | 'scout' | 'score' | 'blender' | 'trend' | 'similar' | 'season' | null>(null);
  const [tab, setTab] = useState<'models' | 'flow' | 'files' | 'trends' | 'insights' | 'help' | 'settings'>('models');
  const [palette, setPalette] = useState(false);
  const [dialogText, setDialogText] = useState('');
  const [zoom, setZoom] = useState<{ path: string; mtime: number; name: string } | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [moreOpen, setMoreOpen] = useState(false);
  const [flowView, setFlowView] = useState<'graph' | 'steps'>('graph');
  const [nodeId, setNodeId] = useState<string | null>(null);
  const [attempt, setAttempt] = useState<AttemptRequest | null>(null);
  const [fileNode, setFileNode] = useState<string | null>(null);
  const [trendSel, setTrendSel] = useState<string | null>(null);
  const [ideaSel, setIdeaSel] = useState<string | null>(null);
  const [compare, setCompare] = useState<string[]>([]);
  const [showArchived, setShowArchived] = useState(false);
  const [printForm, setPrintForm] = useState(false);
  const [notify, setNotify] = useState<boolean>(() => host.storage.get<boolean>('notify') ?? true);
  const [importing, setImporting] = useState(false);
  const [blender, setBlender] = useState<BlenderStatus | null>(null);
  const [blenderChecking, setBlenderChecking] = useState(false);
  const [blenderOpen, setBlenderOpen] = useState(false);
  const [kilnBusy, setKilnBusy] = useState<KilnCommand | null>(null);
  const [kilnLast, setKilnLast] = useState<Record<string, KilnResult>>({});
  const [kilnDialog, setKilnDialog] = useState<'prep' | 'flexi' | null>(null);
  const [branchSel, setBranchSel] = useState<Record<string, string>>(() => host.storage.get<Record<string, string>>('branchSel') ?? {});
  const [runDialog, setRunDialog] = useState<{ step: string; action: AgentAction | null } | null>(null);
  const [branchDialog, setBranchDialog] = useState<{ from: FlowNode | null } | null>(null);
  const [newModel, setNewModel] = useState<{ pictures: string[] } | null>(null);
  const [tipsOpen, setTipsOpen] = useState(false);
  const [tipsText, setTipsText] = useState<string | null>(null);
  const [statusText, setStatusText] = useState<string | null>(null);
  const [statusBusy, setStatusBusy] = useState(false);
  const lastJson = useRef('');
  const scanning = useRef(false);
  // Off in this project (your choice, kept per workspace), or a project without AI3D Forge: the panel stays idle,
  // it does not scan, check Blender or notify.
  const [off, setOff] = useState<boolean>(() => host.storage.get<boolean>('off') === true);
  const idleRef = useRef<'off' | 'none' | null>(off ? 'off' : null);
  const lastScanAt = useRef(0);
  const switchOff = useCallback((v: boolean) => { setOff(v); idleRef.current = v ? 'off' : null; void host.storage.set('off', v); }, [host]);

  const runs = useSyncExternalStore(runStore.subscribe, runStore.snapshot);

  const refresh = useCallback(async () => {
    if (scanning.current) return;
    scanning.current = true;
    try {
      const next = await scanWorkspace(host);
      lastScanAt.current = Date.now();
      if (idleRef.current !== 'off') idleRef.current = !next.installed && !next.tools.flowLog && next.models.length === 0 ? 'none' : null;
      const json = JSON.stringify(next);
      if (json !== lastJson.current) {
        lastJson.current = json;
        setScan(next);
      }
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      scanning.current = false;
    }
  }, [host]);

  useEffect(() => {
    runStore.attachStorage(host.storage);
    if (idleRef.current !== 'off') void refresh();
    const timer = setInterval(() => {
      if (document.hidden || idleRef.current === 'off') return;
      // a project without AI3D Forge is looked at once a minute, in case the module gets installed
      if (idleRef.current === 'none' && Date.now() - lastScanAt.current < 60000) return;
      void refresh();
    }, POLL_MS);
    // Internal host event, announced when a session is created: lets the transcript appear
    // while the first turn is still running. If the host renames it, the transcript shows
    // when the turn ends instead.
    const off = host.onWorkspaceEvent('sessions:refresh-list', (data) => {
      const id = (data as { sessionId?: unknown } | undefined)?.sessionId;
      if (typeof id === 'string') runStore.noteSessionCreated(id);
    });
    return () => { clearInterval(timer); off(); };
  }, [host, refresh]);

  useEffect(() => runStore.onRunFinished((key, run) => {
    if (!notify) return;
    const where = key === GLOBAL ? '' : ` · ${key}`;
    const msg = `${run.status === 'error' ? 'Failed' : 'Finished'}: ${run.label}${where}`;
    setNote(`${msg}. ${run.status === 'error' ? run.error ?? '' : 'Check the agent session for questions.'}`);
    try {
      if (document.hidden && typeof Notification !== 'undefined' && Notification.permission === 'granted') new Notification('AI3D Forge', { body: msg });
    } catch { /* notifications are optional */ }
  }), [notify]);

  const toggleNotify = useCallback(() => {
    const next = !notify;
    setNotify(next);
    void host.storage.set('notify', next);
    try { if (next && typeof Notification !== 'undefined' && Notification.permission === 'default') void Notification.requestPermission(); } catch { /* ignore */ }
    setNote(next ? 'Notifications on: a message when an agent run ends (a system notification when the panel is hidden).' : 'Notifications off.');
  }, [notify, host]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); setPalette((v) => !v); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  useEffect(() => {
    if (!zoom && !dialog && !attempt && !runDialog && !branchDialog) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { setZoom(null); setDialog(null); setAttempt(null); setRunDialog(null); setBranchDialog(null); } };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [zoom, dialog, attempt, runDialog, branchDialog]);

  const models = scan?.models ?? [];
  const baseModel = models.find((m) => m.slug === slug) ?? null;
  // the selected model as seen from its selected branch (the primary one unless you picked another)
  const model = useMemo(() => (baseModel ? withBranch(baseModel, branchSel[baseModel.slug]) : null), [baseModel, branchSel]);
  const tips = useMemo(() => parseTips(tipsText), [tipsText]);
  const stepsBySlug = useMemo(() => {
    const out: Record<string, StepView[]> = {};
    if (scan) for (const m of scan.models) out[m.slug] = buildSteps(m, scan);
    return out;
  }, [scan]);

  // Select the first model once models arrive; drop a selection that no longer exists.
  useEffect(() => {
    if (!scan) return;
    if (slug && !models.some((m) => m.slug === slug)) setSlug(null);
    else if (!slug && models.length) { setSlug(models[0].slug); setViewKey(models[0].slug); }
  }, [scan, slug, models]);

  // Badge: models where the next move is yours.
  useEffect(() => {
    const waiting = Object.values(stepsBySlug).filter((steps) => steps.some((s) => s.state === 'waiting')).length;
    host.setGutterBadge?.(waiting > 0 ? waiting : null, { tone: 'warning' });
  }, [stepsBySlug, host]);

  const steps = useMemo(() => (model && scan ? buildSteps(model, scan) : []), [model, scan]);

  const setBranch = useCallback((id: string) => {
    if (!baseModel) return;
    setBranchSel((x) => {
      const next = { ...x, [baseModel.slug]: id };
      void host.storage.set('branchSel', next);
      return next;
    });
    setNodeId(null); setStepId(null); setCompare([]); setFileNode(null); setMoreOpen(false);
  }, [baseModel, host]);

  const stepTipsPath = scan?.tools.stepTips ?? null;
  useEffect(() => {
    if (!stepTipsPath) return;
    void host.exec(`cat ${sh(stepTipsPath)}`, { timeout: 10000 }).then((r) => { if (r.success) setTipsText(r.stdout); });
  }, [stepTipsPath, host]);
  const current = steps.find((s) => s.state === 'active' || s.state === 'waiting') ?? steps[steps.length - 1];
  const step = steps.find((s) => s.id === stepId) ?? current;
  // several agent runs may be in their first turn at once; only a repeat of the very same action is refused
  const busy = false;
  const activeRuns = runStore.active();

  const external = useCallback(async (path: string) => {
    const res = await host.exec(`${openCmd()} ${sh(path)}`, { timeout: 15000 });
    if (!res.success) setNote(`Could not open ${path}: ${res.stderr.trim()}`);
  }, [host]);

  /** The model's nodes as they are on disk now (the scan may be a few seconds old). */
  const freshNodes = useCallback(async (m: Model): Promise<FlowNode[]> => {
    if (!scan?.tools.flowLog) return m.flow.nodes;
    const r = await host.exec(`python3 ${sh(scan.tools.flowLog)} list ${sh(m.dir)}`, { timeout: 15000 });
    try { return r.success ? (JSON.parse(r.stdout).nodes as FlowNode[]) : m.flow.nodes; } catch { return m.flow.nodes; }
  }, [scan, host]);

  const currentModel = model;
  const doAction = useCallback(async (a: Action, s: StepView | null, input?: string, opts?: Partial<AttemptRequest> & { target?: Model }) => {
    if (!scan) return;
    // an action may name the branch view it runs on (a branch created a moment ago is not in the scan yet)
    const model = opts?.target ?? currentModel;
    setNote(null);
    setMoreOpen(false);
    if (a.kind === 'script') {
      if (a.script === 'readme') {
        if (!model || !scan.tools.buildReadme) return;
        const py = sh(scan.tools.buildReadme);
        const res = await host.exec(`python3 ${py} ${sh(model.dir)} && python3 ${py} ${sh(scan.root)} --catalog`, { timeout: 60000 });
        setNote(res.success ? 'README and catalog rebuilt.' : `README build failed: ${res.stderr.trim()}`);
      } else if (a.script === 'view' || a.script === 'views-all') {
        if (!scan.tools.buildViewer) { setNote('The Prism scripts were not found. Update the AI3D Forge module.'); return; }
        const targets = a.script === 'view'
          ? (model ? [model] : [])
          : scan.models.filter((m) => m.files.mesh.some((f) => /\.stl$/i.test(f.name)));
        if (!targets.length) { setNote(a.script === 'view' ? 'Select a model first.' : 'No model has an STL yet.'); return; }
        setNote(`Building ${targets.length === 1 ? 'the 3D view' : `${targets.length} 3D views`}…`);
        let last: { view?: string; mb?: number; note?: string } | null = null;
        const failed: string[] = [];
        for (const m of targets) {
          const res = await host.exec(`python3 ${sh(scan.tools.buildViewer)} ${sh(m.dir)}`, { timeout: 120000, maxBuffer: 20_000_000 });
          if (!res.success) { failed.push(`${m.slug}: ${res.stderr.trim().split('\n').pop()}`); continue; }
          try { last = JSON.parse(res.stdout.trim().split('\n').pop() ?? '{}'); } catch { last = null; }
        }
        if (targets.length === 1 && last?.view) await external(last.view);
        setNote(failed.length ? `3D view failed: ${failed.join('; ')}`
          : targets.length === 1 ? `3D view built (${last?.mb ?? '?'} MB) and opened in your browser.${last?.note ? ' ' + last.note : ''}`
          : `${targets.length} 3D views built. Open one from its model.`);
      } else if (a.script === 'portfolio') {
        if (!scan.tools.buildInsights) { setNote('The Prism scripts were not found. Update the AI3D Forge module.'); return; }
        setNote('Building the portfolio dashboard…');
        const res = await host.exec(`python3 ${sh(scan.tools.buildInsights)} portfolio ${sh(scan.root)}`, { timeout: 60000 });
        setNote(res.success ? 'Portfolio dashboard built.' : `Portfolio build failed: ${res.stderr.trim()}`);
        if (res.success) setTab('insights');
      }
      void refresh();
      return;
    }
    if (a.kind === 'form') {
      if (a.form === 'print-log') setPrintForm(true);
      else if (model && scan.tools.printLog) {
        const res = await host.exec(`python3 ${sh(scan.tools.printLog)} skip ${sh(model.dir)} --reason ${sh('skipped from the panel')}`, { timeout: 15000 });
        setNote(res.success ? 'Test print skipped for this model. Log a print later if you make one.' : `Could not save: ${res.stderr.trim()}`);
        void refresh();
      }
      return;
    }
    if (a.kind !== 'agent') return;
    if (!runStore.hasAi()) { setNote('The AI service is not available to this extension. Check its AI permission in Settings.'); return; }
    const key = model && s ? model.slug : GLOBAL;
    const name = model && s ? `AI3D · ${model.slug}${model.branch !== 'main' ? `/${model.branch}` : ''} · ${a.label}` : `AI3D · ${a.label}`;
    if (runStore.isBusy(key, a.label)) { setNote(`“${a.label}” is already running. Its session is in the pane on the right.`); return; }

    // An attempt becomes a node in the model's flow graph before the agent starts, so the graph shows it at once
    // and records it even when the agent forgets to.
    let info: AttemptInfo | undefined;
    const flowLog = scan.tools.flowLog;
    if (model && s && flowLog && isAttempt(a)) {
      const all = await freshNodes(model);
      const nodes = branchNodes(model, all);
      const parent = opts?.parent !== undefined ? opts.parent : parentFor(model, all, s.id);
      const count = nodesOfStep(nodes, s.id).filter((n) => !n.inferred).length + 1;
      const version = Math.max(0, ...model.files.prompts.map((f) => Number(/^image-v(\d+)\.md$/.exec(f.name)?.[1] ?? 0)),
        ...nodes.map((n) => Number(/^Image prompt v(\d+)/.exec(n.label)?.[1] ?? 0))) + 1;
      const viewsN = Math.max(0, ...nodes.map((n) => Number(/^Views v(\d+)/.exec(n.label)?.[1] ?? 0)),
        ...model.files.prompts.map((f) => Number(/^views-v(\d+)\.md$/.exec(f.name)?.[1] ?? 0))) + 1;
      const isViews = a.trigger === '*views';
      const label = isViews ? `Views v${viewsN}` : s.id === 'image' ? `Image prompt v${version}` : `${s.title} · try ${count}`;
      const extra = isViews ? { mode: 'views', views: 'front,left,back,right' } : {};
      const cmd = [`python3 ${sh(flowLog)} add ${sh(model.dir)} --step ${s.id} --label ${sh(label)} --status running`,
        parent ? `--parent ${sh(parent)}` : '', opts?.description ? `--description ${sh(opts.description)}` : '',
        `--settings-json ${sh(JSON.stringify({ ...extra, ...(opts?.settings ?? {}), ...runSettingsOf(scan.config, s.id, a, opts?.run) }))}`].filter(Boolean).join(' ');
      const res = await host.exec(cmd, { timeout: 15000 });
      if (res.success) {
        try { info = { node: JSON.parse(res.stdout.trim().split('\n').pop() ?? ''), flowLog }; setNodeId(info.node.id); } catch { /* fall through: run without a node */ }
      }
      if (!info) setNote('The flow node could not be created; the step runs without it.');
      else void refresh();
    }
    const choice = { ...defaultRun(scan.config, s?.id ?? null, a.skill, a.trigger), ...(opts?.run ?? {}) };
    const onSettled = info && model && flowLog
      ? (status: 'done' | 'error', error?: string) => {
          const o = status === 'error' ? ` --outcome ${sh(`Run failed: ${error ?? 'unknown error'}`)}` : '';
          void host.exec(`python3 ${sh(flowLog)} settle ${sh(model.dir)} ${sh(info!.node.id)} --status ${status === 'error' ? 'error' : 'open'}${o}`, { timeout: 15000 }).then(() => refresh());
        }
      : undefined;
    const run = runStore.startRun(key, s?.id ?? 'global', a.label, agentPrompt(a, s ? model : null, scan, input, info, choice.effort), name, onSettled, choice.model);
    if (!run) { setNote(`“${a.label}” is already running.`); onSettled?.('error', 'not started'); return; }
    setViewKey(key);
    setViewRun(null);
  }, [scan, currentModel, host, refresh, external, freshNodes]);

  const openNew = useCallback((step: string, from?: Partial<AttemptRequest>) => {
    if (!model) return;
    if (step === 'print') { setPrintForm(true); return; }
    if (!ATTEMPT_CHOICES[step]?.length) return;
    setAttempt({
      step,
      parent: from?.parent !== undefined ? from.parent : parentFor(model, model.flow.nodes, step),
      settings: from?.settings ?? {},
      description: from?.description ?? '',
    });
  }, [model]);

  const askCompass = useCallback((trigger: string, arg?: string) => {
    const where = model ? `Selected model: ${model.slug}${model.branches.length > 1 ? `, branch ${model.branch}` : ''}.` : '';
    void doAction({ kind: 'agent', label: `Compass ${trigger}${arg ? ` ${arg}` : ''}`, skill: 'ai3d-help', trigger }, null, [arg, where].filter(Boolean).join(' · '));
  }, [doAction, model]);

  const runCommand = useCallback((r: RunRequest) => {
    const st = steps.find((x) => x.id === runDialog?.step) ?? null;
    setRunDialog(null);
    if (!st) return;
    if (isAttempt(r.action)) void doAction(r.action, st, undefined, { description: r.instruction, run: r.run });
    else void doAction(r.action, st, r.instruction || undefined, { run: r.run });
  }, [steps, runDialog, doAction]);

  const setVerdict = useCallback(async (n: FlowNode, v: 'accepted' | 'rejected' | 'none') => {
    if (!model || !scan?.tools.flowLog) return;
    const res = await host.exec(`python3 ${sh(scan.tools.flowLog)} update ${sh(model.dir)} ${sh(n.id)} --verdict ${v}`, { timeout: 15000 });
    if (!res.success) setNote(`Could not save the verdict: ${res.stderr.trim()}`);
    void refresh();
  }, [model, scan, host, refresh]);

  const flowCmd = useCallback(async (args: string) => {
    if (!model || !scan?.tools.flowLog) return false;
    const res = await host.exec(`python3 ${sh(scan.tools.flowLog)} ${args}`, { timeout: 15000 });
    if (!res.success) setNote(`Could not save: ${res.stderr.trim().split('\n').pop()}`);
    void refresh();
    return res.success;
  }, [model, scan, host, refresh]);

  /** Run one shell command built by commands.ts; returns the last stdout line parsed as JSON, or null on failure. */
  const runShell = useCallback(async (cmd: string, what: string) => {
    const res = await host.exec(cmd, { timeout: 60000 });
    void refresh();
    if (!res.success) { setNote(`${what} failed: ${res.stderr.trim().split('\n').pop()}`); return null; }
    try { return JSON.parse(res.stdout.trim().split('\n').pop() ?? 'null'); } catch { return {}; }
  }, [host, refresh]);

  const createBranch = useCallback(async (r: BranchRequest) => {
    setBranchDialog(null);
    if (!model || !scan?.tools.flowLog) { setNote('flow_log.py was not found: update the module.'); return; }
    const source = r.kind === 'none' ? undefined : `${r.kind}:${r.ref}`;
    setNote(`Creating branch “${r.name}”…`);
    const out = await runShell(shell.branchAdd(scan.tools.flowLog, model.rootDir, { name: r.name, fromNode: r.fromNode, fromStep: r.fromStep, source, review: r.review, description: r.description }), 'New branch');
    if (!out?.id) return;
    await refresh();
    setBranch(out.id);
    setTab('flow');
    setNote(`Branch “${r.name}” created in branches/${out.id}/ (starts at ${r.fromStep}${out.inherited?.length ? `, ${out.inherited.length} files copied` : ''}). Its steps are shown now.`);
  }, [model, scan, runShell, refresh, setBranch]);

  /** A concept from words, pictures and a link: a new model, or a new branch of the selected model. */
  const startConcept = useCallback(async (r: NewModelRequest) => {
    setNewModel(null);
    if (!scan) return;
    const parts = [
      r.pictures.length ? `Reference pictures — look at each one with the Read tool before you write anything, describe what you see, and build the concept from them: ${r.pictures.map((p) => `\`${p}\``).join(', ')}.` : '',
      r.link ? `Reference link (open it): ${r.link}` : '',
      r.text ? `What I want: ${r.text}` : r.pictures.length || r.link ? 'Make a printable model of what the references show; say what you kept and what you changed for printing.' : '',
    ].filter(Boolean);
    if (r.target === 'model' || !model || !scan.tools.flowLog) {
      const copy = r.pictures.length ? ' Copy the reference pictures into the new model\'s work folder refs/.' : '';
      void doAction({ kind: 'agent', label: `New model${r.text ? `: ${r.text.slice(0, 30)}` : ''}`, skill: 'ai3d-muse', trigger: '*concept' }, null, parts.join(' ') + copy, { run: r.run });
      return;
    }
    const brief = [r.text, r.link ? `Link: ${r.link}` : ''].filter(Boolean).join(' · ') || 'Concept from the reference pictures';
    const cmd = `${shell.branchAdd(scan.tools.flowLog, model.rootDir, { name: r.branchName, fromStep: 'concept', source: `text:${brief}`, description: r.text })}${r.pictures.map((p) => ` --ref ${sh(p)}`).join('')}`;
    const out = await runShell(cmd, 'New branch');
    if (!out?.id) return;
    const empty = { inbox: [], images: [], renders: [], refs: [], mesh: [], print: [], prompts: [], publish: [] };
    const stub = { id: out.id, name: r.branchName, parent_branch: 'main', from_node: null, from_step: 'concept', source: { kind: 'text' as const, ref: brief }, description: r.text,
      status: 'open' as const, created_at: null, primary: false, exists: true,
      work: { dir: out.dir, meta: {}, concept: null, files: empty, attempts: [], imagePrompt: null, prompt3d: null, analysis: null, hasReadme: false, view: null, printLog: [], printPhotos: [], source: null, stamp: 0 } };
    const target: Model = { ...model, ...stub.work, meta: { title: model.meta.title }, dir: out.dir, branch: out.id, migrated: true, branches: [...model.branches, stub] };
    const st = steps.find((x) => x.id === 'concept') ?? null;
    const refsLine = (out.refs ?? []).length ? ` The reference pictures are in this branch: ${(out.refs as string[]).join(', ')} — look at them with the Read tool first.` : '';
    await doAction({ kind: 'agent', label: 'Write concept', skill: 'ai3d-muse', trigger: '*concept' }, st, undefined,
      { description: `${brief}.${refsLine} Write this branch's own concept.md and metadata.json in its work folder; do not create a new model.`, run: r.run, target });
    await refresh();
    setBranch(out.id);
    setTab('flow');
  }, [scan, model, steps, doAction, runShell, refresh, setBranch]);

  const branchAction = useCallback(async (what: 'promote' | 'variant' | 'archived' | 'open' | 'migrate', id: string) => {
    if (!model || !scan?.tools.flowLog) return;
    const t = scan.tools.flowLog;
    const cmd = what === 'promote' ? shell.branchPromote(t, model.rootDir, id) : what === 'migrate' ? shell.migrate(t, model.rootDir) : shell.branchSet(t, model.rootDir, id, what);
    const out = await runShell(cmd, what === 'migrate' ? 'Moving files' : 'Branch');
    if (!out) return;
    if (what === 'archived' && id === model.branch) setBranch(model.primary);
    setNote(what === 'promote' ? `“${id}” is the primary branch now: the Models tab, the catalog and the portfolio use it.`
      : what === 'migrate' ? 'The work files are in branches/main/ now; metadata.json and concept.md stay in the model folder too.'
      : what === 'variant' ? `“${id}” is a variant: it gets its own README and listing.` : what === 'archived' ? `“${id}” is archived: hidden, nothing deleted.` : `“${id}” is open again.`);
  }, [model, scan, runShell, setBranch]);

  const runStatus = useCallback(async () => {
    if (!scan?.tools.helpStatus) return;
    setStatusBusy(true);
    const res = await host.exec(shell.helpStatus(scan.tools.helpStatus, scan.workspace), { timeout: 30000 });
    setStatusText(res.success ? res.stdout.trim() : `status.py failed: ${res.stderr.trim()}`);
    setStatusBusy(false);
  }, [scan, host]);

  const toggleCompare = useCallback((n: FlowNode) => {
    setCompare((c) => (c.includes(n.id) ? c.filter((x) => x !== n.id) : [...c, n.id].slice(-2)));
  }, []);

  /** Build a 3D view of one attempt's STL into view/compare-<node>.html and open it. */
  const view3d = useCallback(async (n: FlowNode, stl: string) => {
    if (!model || !scan?.tools.buildViewer) { setNote('The Prism scripts were not found.'); return; }
    const dir = dirOf(model, n);
    const out = `${dir}/view/compare-${n.id}.html`;
    const res = await host.exec(`python3 ${sh(scan.tools.buildViewer)} ${sh(dir)} --stl ${sh(`${dir}/${stl}`)} --out ${sh(out)}`, { timeout: 120000, maxBuffer: 20_000_000 });
    if (!res.success) { setNote(`3D view failed: ${res.stderr.trim().split('\n').pop()}`); return; }
    await external(out);
  }, [model, scan, host, external]);

  const savePrintLog = useCallback(async (r: PrintLogRequest) => {
    setPrintForm(false);
    if (!model || !scan?.tools.printLog) { setNote('print_log.py was not found: update the module.'); return; }
    const m = model;
    setNote('Saving the test print…');
    const paths = [...r.photoPaths];
    try { for (const f of r.photoFiles) paths.push(await upload(host, m.dir, f)); } catch (e) { setNote(`Photo upload failed: ${e instanceof Error ? e.message : String(e)}`); return; }
    const args = [`add ${sh(m.dir)} --result ${r.result}`, `--printer ${sh(r.printer)}`, `--filament ${sh(r.filament)}`, `--settings ${sh(r.settings)}`,
      `--change ${sh(r.change)}`, `--notes ${sh(r.notes)}`, paths.length ? `--photos ${sh(paths.join(','))}` : ''].filter(Boolean).join(' ');
    const res = await host.exec(`python3 ${sh(scan.tools.printLog)} ${args}`, { timeout: 30000 });
    void host.exec(`rm -rf ${sh(`${m.dir}/.import-tmp`)}`, { timeout: 10000 });
    if (!res.success) { setNote(`Could not save: ${res.stderr.trim().split('\n').pop()}`); return; }
    let entry: { photos?: string[] } = {};
    try { entry = JSON.parse(res.stdout.trim().split('\n').pop() ?? '{}'); } catch { /* the log is written */ }
    if (scan.tools.flowLog) {
      const now = await freshNodes(m);
      const n = nodesOfStep(branchNodes(m, now), 'print').filter((x) => !x.inferred).length + 1;
      const printParent = parentFor(m, now, 'print');
      const files = ['print/print-log.md', ...(entry.photos ?? [])].join(',');
      const settings = JSON.stringify(Object.fromEntries(Object.entries({ printer: r.printer, filament: r.filament, settings: r.settings }).filter(([, v]) => v)));
      await host.exec([`python3 ${sh(scan.tools.flowLog)} add ${sh(m.dir)} --step print --agent you --label ${sh(`Test print ${n}`)} --status done`,
        `--outcome ${sh(`${r.result}${r.change ? `; change: ${r.change}` : ''}`)}`, `--files ${sh(files)}`, `--settings-json ${sh(settings)}`,
        printParent ? `--parent ${sh(printParent)}` : ''].filter(Boolean).join(' '), { timeout: 15000 });
      if (r.result !== 'issues') {
        const list = await host.exec(`python3 ${sh(scan.tools.flowLog)} list ${sh(m.dir)}`, { timeout: 15000 });
        try {
          const nodes = branchNodes(m, JSON.parse(list.stdout).nodes as FlowNode[]).filter((x) => x.step === 'print' && !x.inferred);
          const last = nodes[nodes.length - 1];
          if (last) await host.exec(`python3 ${sh(scan.tools.flowLog)} update ${sh(m.dir)} ${sh(last.id)} --verdict ${r.result === 'ok' ? 'accepted' : 'rejected'}`, { timeout: 15000 });
        } catch { /* verdict is optional */ }
      }
    }
    setNote(`Test print saved (${r.result}).${r.result === 'fail' ? ' Run the Blender step again with the change, or go back to the mesh.' : ''}`);
    void refresh();
  }, [model, scan, host, refresh, freshNodes]);

  const openRel = useCallback((rel: string, n?: FlowNode) => {
    if (!model) return;
    const abs = `${n ? dirOf(model, n) : model.dir}/${rel}`;
    if (/\.(md|json|txt|ya?ml)$/i.test(rel)) void host.openFile(abs); else void external(abs);
  }, [model, host, external]);

  const selectModel = useCallback((s: string, go?: 'flow' | 'files') => {
    setSlug(s); setStepId(null); setNodeId(null); setFileNode(null); setViewKey(s); setViewRun(null); setNote(null);
    if (go) setTab(go);
  }, []);

  const reveal = useCallback(async (m: Model, rel: string) => {
    const target = rel ? `${m.dir}/${rel}` : m.dir;
    const res = await host.exec(rel ? revealCmd(target) : `${openCmd()} ${sh(target)}`, { timeout: 15000 });
    if (!res.success) setNote(`Could not show ${target}: ${res.stderr.trim()}`);
  }, [host]);

  const openFileOf = useCallback((m: Model, rel: string) => {
    const abs = `${m.dir}/${rel}`;
    if (/\.(md|json|txt|ya?ml)$/i.test(rel)) void host.openFile(abs); else void external(abs);
  }, [host, external]);

  const finishImport = useCallback(async (job: Promise<{ placed: { file: string; archived: string | null }[]; skipped: { file: string; why: string }[] }>) => {
    setImporting(true);
    try {
      const r = await job;
      setNote(describeImport(r));
      const flowLog = scan?.tools.flowLog;
      if (model && flowLog) {
        for (const pl of r.placed) {
          if (!pl.archived) continue;
          const old = pl.file;
          const owner = [...branchNodes(model)].reverse().find((n) => !n.inferred && n.files.includes(old));
          if (owner) await host.exec(`python3 ${sh(flowLog)} update ${sh(model.dir)} ${sh(owner.id)} --move-file ${sh(`${old}=${pl.archived}`)}`, { timeout: 15000 });
        }
      }
    } catch (e) { setNote(`Could not add the files: ${e instanceof Error ? e.message : String(e)}`); }
    setImporting(false);
    void refresh();
  }, [refresh, scan, model, host]);

  /** System file dialog. Resolves false when it is not available here (the caller then uses a file input). */
  const pickFiles = useCallback(async (kind: ImportKind): Promise<boolean> => {
    if (!model) return true;
    const paths = await pickWithSystemDialog(host, kind);
    if (paths === null) return false;
    if (paths.length) await finishImport(importPaths(host, model.dir, kind, paths));
    return true;
  }, [model, host, finishImport]);

  const addFiles = useCallback((files: File[]) => {
    if (!model) return;
    const groups: Record<ImportKind, File[]> = { image: [], mesh: [], view: [] };
    const unknown: string[] = [];
    for (const f of files) { const k = kindOf(f.name); if (k) groups[k].push(f); else unknown.push(f.name); }
    const job = (async () => {
      const out = { placed: [] as { file: string; archived: string | null }[], skipped: unknown.map((file) => ({ file, why: 'not an image or a 3D file' })) };
      for (const k of ['image', 'mesh'] as const) {
        if (!groups[k].length) continue;
        const r = await importFiles(host, model.dir, k, groups[k]);
        out.placed.push(...r.placed); out.skipped.push(...r.skipped);
      }
      return out;
    })();
    void finishImport(job);
  }, [model, host, finishImport]);

  const blenderBin = scan?.config.blender_bin ?? 'auto';
  const recheckBlender = useCallback(async () => {
    setBlenderChecking(true);
    try { setBlender(await checkBlender(host, blenderBin)); } catch (e) { setNote(`Blender check failed: ${e instanceof Error ? e.message : String(e)}`); }
    setBlenderChecking(false);
  }, [host, blenderBin]);
  const scanReady = !!scan;
  const notProject = !!scan && !scan.installed && !scan.tools.flowLog && scan.models.length === 0;
  useEffect(() => { if (scanReady && !off && !notProject) void recheckBlender(); }, [scanReady, off, notProject, recheckBlender]);

  const openGuide = useCallback(() => {
    if (scan?.tools.blenderGuide) void host.openFile(scan.tools.blenderGuide);
    else setNote('The setup guide is in the module: skills/ai3d-kiln/references/blender-setup.md');
  }, [scan, host]);

  /** A headless Kiln command. prep and flexi are attempts: they get a node in the flow graph. */
  const runQuick = useCallback(async (cmd: KilnCommand, opts: Record<string, string> = {}, description = '') => {
    if (!model || !scan) return;
    if (!scan.tools.kilnRun || !blender?.bin) { setBlenderOpen(true); return; }
    const m = model;
    const flowLog = scan.tools.flowLog;
    setKilnBusy(cmd);
    setNote(null);
    let nodeId: string | null = null;
    if ((cmd === 'prep' || cmd === 'flexi') && flowLog) {
      const all = await freshNodes(m);
      const nodes = branchNodes(m, all);
      const own = nodesOfStep(nodes, 'blender').filter((n) => n.verdict !== 'rejected' && n.status !== 'error');
      const parent = cmd === 'flexi' && own.length ? own[own.length - 1].id : parentFor(m, all, 'blender');
      const label = `${cmd === 'prep' ? 'Quick prep' : 'Flexi (script)'} · try ${nodesOfStep(nodes, 'blender').filter((n) => !n.inferred).length + 1}`;
      const settings = Object.fromEntries(Object.entries(opts).filter(([, v]) => v !== ''));
      const add = await host.exec([`python3 ${sh(flowLog)} add ${sh(m.dir)} --step blender --agent kiln_run --label ${sh(label)} --status running`,
        parent ? `--parent ${sh(parent)}` : '', description ? `--description ${sh(description)}` : '', `--settings-json ${sh(JSON.stringify(settings))}`].filter(Boolean).join(' '), { timeout: 15000 });
      try { nodeId = add.success ? JSON.parse(add.stdout.trim().split('\n').pop() ?? '').id : null; } catch { nodeId = null; }
      void refresh();
    }
    const r = await runKiln(host, blender.bin, scan.tools.kilnRun, cmd, m.dir, opts);
    if (nodeId && flowLog) {
      const files = (r.files ?? []).join(',');
      await host.exec([`python3 ${sh(flowLog)} update ${sh(m.dir)} ${sh(nodeId)} --status ${r.crashed ? 'error' : 'done'}`,
        !r.ok && !r.crashed ? '--verdict rejected' : '', `--outcome ${sh(summarize(r))}`, files ? `--files ${sh(files)}` : ''].filter(Boolean).join(' '), { timeout: 15000 });
    }
    // the attempt that owned the replaced print.stl now points at its archived copy
    if (flowLog && typeof r.archived === 'string' && r.archived) {
      const owner = [...branchNodes(m, await freshNodes(m))].reverse().find((n) => !n.inferred && n.id !== nodeId && n.files.includes('mesh/print.stl'));
      if (owner) await host.exec(`python3 ${sh(flowLog)} update ${sh(m.dir)} ${sh(owner.id)} --move-file ${sh(`mesh/print.stl=${r.archived}`)}`, { timeout: 15000 });
    }
    setKilnLast((x) => ({ ...x, [m.slug]: r }));
    const kept = Array.isArray(r.archived) ? r.archived.join(', ') : r.archived;
    setNote(`${cmd}: ${summarize(r)}${kept ? ` Previous file kept as ${kept}.` : ''}`);
    setKilnBusy(null);
    void refresh();
  }, [model, scan, blender, host, refresh, freshNodes]);

  const openBlender = useCallback(async (rel: string | null) => {
    const res = await openInBlender(host, blender?.bin ?? null, rel && model ? `${model.dir}/${rel}` : '');
    if (!res.success) setNote(`Could not open Blender: ${res.stderr.trim()}`);
    else setNote(rel ? `Opening ${rel} in Blender…` : 'Opening Blender…');
  }, [host, blender, model]);

  const relPath = useCallback((abs: string) => (scan && abs.startsWith(scan.workspace) ? abs.slice(scan.workspace.length + 1) || '.' : abs), [scan]);
  const scoutAct = (label: string, trigger: string): Action => ({ kind: 'agent', label, skill: 'ai3d-scout', trigger });

  const trendLibRun = useCallback(async (args: string) => {
    if (!scan?.tools.trendLib) { setNote('trend_lib.py was not found: update the AI3D Forge module.'); return null; }
    const res = await host.exec(`python3 ${sh(scan.tools.trendLib)} ${args}`, { timeout: 20000 });
    if (!res.success) { setNote(`Could not save: ${res.stderr.trim().split('\n').pop()}`); return null; }
    void refresh();
    try { return JSON.parse(res.stdout.trim().split('\n').pop() ?? 'null'); } catch { return null; }
  }, [scan, host, refresh]);

  const onTrendAgent = useCallback((action: TrendAction, t: Trend | null, preset?: string) => {
    if (!scan) return;
    if (action === 'trend' || action === 'similar' || action === 'season') { setDialog(action); setDialogText(preset ?? ''); return; }
    if (action === 'watch') { void doAction(scoutAct('Re-check watched trends', '*watch'), null, `Trends folder: \`${relPath(scan.trendsRoot)}\`.`); return; }
    if (!t) return;
    const where = `Trend: \`${relPath(t._dir)}/trend.json\` (${t.title}).`;
    if (action === 'score') void doAction({ kind: 'agent', label: `Score ideas: ${t.title}`, skill: 'ai3d-prism', trigger: '*score' }, null, `trend ${t.slug}. ${where}`);
    if (action === 'refresh') void doAction(scoutAct(`Refresh: ${t.title}`, t.kind === 'similar' ? '*similar' : t.kind === 'season' ? '*season' : '*trend'), null,
      `Refresh the existing trend ${t.slug}: add new dated signals (keep the old ones), update summary and ideas. ${where}`);
  }, [scan, doAction, relPath]);

  const prepareFromTrend = useCallback(async (t: Trend, idea: TrendIdea) => {
    if (!scan) return;
    const r = await trendLibRun(`new insight ${sh(scan.ideasRoot)} --title ${sh(idea.name)} --subject-kind other --trend ${sh(t.slug)} --idea ${sh(idea.id)} --trends-dir ${sh(scan.trendsRoot)}`);
    if (r?.slug) { setIdeaSel(r.slug); setTab('insights'); setNote(`“${idea.name}” is in Insights now. Prepare runs Muse.`); }
  }, [scan, trendLibRun]);

  const linkLine = useCallback((extra: string) => scan?.tools.trendLib
    ? `After the model folder exists, link it: \`python3 ${scan.tools.trendLib} link <model dir> ${extra} --trends-dir ${scan.trendsRoot} --insights-dir ${scan.ideasRoot}\`.` : '', [scan]);

  const modelFromTrend = useCallback((t: Trend, idea: TrendIdea) => {
    if (!scan) return;
    void doAction({ kind: 'agent', label: `New model: ${idea.name}`, skill: 'ai3d-muse', trigger: '*concept' }, null,
      `Idea \`${idea.id}\` (${idea.name}${idea.pitch ? `: ${idea.pitch}` : ''}${idea.model_type ? `, ${idea.model_type}` : ''}) from trend \`${relPath(t._dir)}/trend.json\`. ${linkLine(`--trend ${t.slug} --idea ${idea.id}`)}`);
  }, [scan, doAction, relPath, linkLine]);

  const onIdeaAgent = useCallback((action: IdeaAction, i: Insight, extra?: string) => {
    const where = `Insight: \`${relPath(i._dir)}/insight.json\` (${i.title}).`;
    const refTool = scan?.tools.trendLib ? ` Save every reference with \`python3 ${scan.tools.trendLib} ref ${i._dir} --url <URL> --title <what it is> --note <why it helps>\` (a picture URL is downloaded into refs/).` : '';
    if (action === 'refs') void doAction({ kind: 'agent', label: `References: ${i.title}`, skill: 'ai3d-muse', trigger: '*refs' }, null,
      `${i.slug}. ${where} Search the web for pages and pictures: the real subject from several sides, the target style, and existing printed models.${extra ? ` Look especially for: ${extra}.` : ''}${refTool}`);
    if (action === 'prepare') void doAction({ kind: 'agent', label: `Prepare: ${i.title}`, skill: 'ai3d-muse', trigger: '*prepare' }, null,
      `${i.slug}. ${where} Find the references on the web (links and pictures), do not write them from memory.${refTool}`);
    if (action === 'score') void doAction({ kind: 'agent', label: `Score: ${i.title}`, skill: 'ai3d-prism', trigger: '*score' }, null, `insight ${i.slug}. ${where}`);
    if (action === 'concept') void doAction({ kind: 'agent', label: `New model: ${i.title}`, skill: 'ai3d-muse', trigger: '*concept' }, null,
      `${i.status === 'draft' ? `From the idea ${i.slug}, which is not prepared yet: work from its description and whatever references it has, and say what you had to assume.` : `From the prepared insight ${i.slug}: use its brief.md and chosen variant.`} ${where} ${linkLine(`--insight ${i.slug}`)}`);
  }, [doAction, relPath, linkLine, scan]);

  const createIdea = useCallback(async (title: string, kind: string, description: string, prepare: boolean) => {
    if (!scan) return;
    const r = await trendLibRun(`new insight ${sh(scan.ideasRoot)} --title ${sh(title)} --subject-kind ${sh(kind)} --description ${sh(description)}`);
    if (!r?.slug) return;
    setIdeaSel(r.slug);
    if (prepare) void doAction({ kind: 'agent', label: `Prepare: ${title}`, skill: 'ai3d-muse', trigger: '*prepare' }, null,
      `${r.slug}. Insight: \`${relPath(r.dir)}/insight.json\` (${title}).`);
  }, [scan, trendLibRun, doAction, relPath]);

  const choosePhoto = useCallback(async () => {
    const paths = await pickWithSystemDialog(host, 'image');
    if (paths === null) { setNote('The file dialog is not available here: paste a link, a path or a name.'); return; }
    if (paths.length) setDialogText((t) => [t.trim(), ...paths].filter(Boolean).join(' '));
  }, [host]);

  const submitDialog = () => {
    const text = dialogText.trim();
    if (!text) return;
    if (dialog === 'new') void doAction({ kind: 'agent', label: 'New model', skill: 'ai3d-muse', trigger: '*concept' }, null, text);
    if (dialog === 'score') void doAction({ kind: 'agent', label: `Score ideas: ${text}`, skill: 'ai3d-prism', trigger: '*score' }, null, text);
    if (dialog === 'blender') void doAction({ kind: 'agent', label: `Blender: ${text.slice(0, 40)}`, skill: 'ai3d-kiln', trigger: '*run' }, steps.find((x) => x.id === 'blender') ?? null, text);
    const tr = scan ? `Trends folder: \`${relPath(scan.trendsRoot)}\`.` : '';
    if (dialog === 'trend') void doAction(scoutAct(`Trend: ${text.slice(0, 40)}`, '*trend'), null, `${text}. ${tr}`);
    if (dialog === 'similar') void doAction(scoutAct(`Similar: ${text.slice(0, 40)}`, '*similar'), null, `${text}. ${tr}`);
    if (dialog === 'season') void doAction(scoutAct(`Season: ${text.slice(0, 40)}`, '*season'), null, `${text}. ${tr}`);
    if (dialog === 'scout') void doAction({ kind: 'agent', label: `Scout: ${text}`, skill: 'ai3d-scout', trigger: '*scout' }, null, text);
    setDialog(null);
    setDialogText('');
  };

  const runList: Run[] = runs[viewKey] ?? [];
  const shownRun = runList.find((r) => r.at === viewRun) ?? runList[0] ?? null;
  const Transcript = host.components?.SessionTranscript;

  const renderPrimary = (s: StepView) => {
    const a = s.primary;
    if (!a) return <p className="a3d-done-line">Step complete.</p>;
    if (s.state === 'locked') {
      const blocker = steps.find((x) => x.state === 'active' || x.state === 'waiting');
      return <p className="a3d-muted">Finish step {blocker?.n} ({blocker?.title}) first.</p>;
    }
    if (a.kind === 'human') {
      return (
        <div className="a3d-your-turn">
          <strong>Your turn</strong>
          <span>{a.label}</span>
          <span className="a3d-row">
            {a.copy && (
              <button type="button" className="a3d-btn a3d-btn-primary" onClick={async () => { await navigator.clipboard.writeText(a.copy!); setNote('Copied to clipboard.'); }}>
                {a.copyLabel ?? 'Copy'}
              </button>
            )}
            {a.folder === 'print' && model && <>
              <button type="button" className="a3d-btn a3d-btn-primary" onClick={() => setPrintForm(true)}>Log a test print…</button>
              <button type="button" className="a3d-btn" onClick={() => void doAction({ kind: 'form', label: 'Skip', form: 'print-skip' }, s)}>Skip</button>
            </>}
            {a.folder && model && (a.folder === 'inbox' || a.folder === 'mesh' || a.folder === 'inbox/views') && (
              <button type="button" className="a3d-btn a3d-btn-primary" disabled={importing}
                onClick={async () => { if (!(await pickFiles(a.folder === 'inbox' ? 'image' : a.folder === 'inbox/views' ? 'view' : 'mesh'))) { setTab('files'); setNote('Use “Add…” here, or drop the file onto this page.'); } }}>
                {a.folder === 'inbox' ? 'Add image…' : a.folder === 'inbox/views' ? 'Add views…' : 'Add 3D model…'}
              </button>
            )}
            {a.folder && model && a.folder !== 'print' && (
              <button type="button" className="a3d-btn" onClick={async () => { await host.exec(`mkdir -p ${sh(`${model.dir}/${a.folder}`)}`, { timeout: 10000 }); void external(`${model.dir}/${a.folder}`); }}>Open {a.folder}/ folder</button>
            )}
          </span>
        </div>
      );
    }
    return (
      <span className="a3d-row">
        <button type="button" className="a3d-btn a3d-btn-primary a3d-btn-large" disabled={busy} onClick={() => doAction(a, s)} title={describe(a, scan, model)}>
          {a.kind === 'agent' ? `Run: ${a.label}` : a.label}
        </button>
        {a.kind === 'agent' && <button type="button" className="a3d-btn" disabled={busy} aria-label="Show the command and add an instruction"
          title="Show the prompt and add your own instruction" onClick={() => setRunDialog({ step: s.id, action: a })}>⋯</button>}
      </span>
    );
  };

  const renderResults = (m: Model, s: StepView) => {
    const open = (p: string) => host.openFile(p);
    const fl = (title: string, folder: Folder, filter?: (f: FileEntry) => boolean) => (
      <FileList title={title} model={m} folder={folder} files={m.files[folder].filter(filter ?? (() => true))} onOpen={open} onExternal={external} />
    );
    switch (s.id) {
      case 'concept':
        return <>
          <TextBlock title="concept.md" text={m.concept} onOpen={() => open(`${m.dir}/concept.md`)} />
          <Gallery host={host} model={m} folder="refs" title="References" onZoom={setZoom} />
        </>;
      case 'image':
        return <>
          <Gallery host={host} model={m} folder="inbox" title="Inbox" onZoom={setZoom} empty="Empty. Generated images go here." />
          <Gallery host={host} model={m} folder="images" title="Accepted" onZoom={setZoom} />
          {m.imagePrompt && <TextBlock title={`Latest prompt — ${m.imagePrompt.name}`} text={m.imagePrompt.text} copyLabel="Copy prompt" onOpen={() => open(`${m.dir}/prompts/${m.imagePrompt!.name}`)} />}
          {fl('Prompt history', 'prompts', (f) => /^image-v\d+\.md$|^prompt-log\.md$/.test(f.name))}
          {([['images/views', 'Views for multi-view 3D', m.views ?? []], ['inbox/views', 'Views waiting for review', m.viewsInbox ?? []]] as const).map(([dir, title, list]) => images([...list]).length > 0 && (
            <section className="a3d-block" key={dir}>
              <h4>{title} <span className="a3d-count">{images([...list]).length}</span></h4>
              <div className="a3d-gallery">{images([...list]).map((f) => {
                const path = `${m.dir}/${dir}/${f.name}`;
                return <figure key={f.name}><Img host={host} path={path} mtime={f.mtime} alt={f.name} onClick={() => setZoom({ path, mtime: f.mtime, name: `${dir}/${f.name}` })} /><figcaption>{f.name}</figcaption></figure>;
              })}</div>
            </section>
          ))}
          {m.viewsPrompt && <TextBlock title={`View prompts — ${m.viewsPrompt.name}`} text={m.viewsPrompt.text} copyLabel="Copy view prompts" onOpen={() => open(`${m.dir}/prompts/${m.viewsPrompt!.name}`)} />}
        </>;
      case 'mesh':
        return <>
          <TextBlock title="3D spec — 3d-prompt.md" text={m.prompt3d} copyLabel="Copy spec" onOpen={() => open(`${m.dir}/prompts/3d-prompt.md`)} />
          {fl('Mesh files', 'mesh')}
          <Gallery host={host} model={m} folder="images" title="Source image" onZoom={setZoom} />
          {images(m.views ?? []).length > 0 && <p className="a3d-muted">{images(m.views ?? []).length} views in images/views/: Chisel writes a multi-view spec (Tripo3D: front, left, back, right; Meshy: up to 4, front first).</p>}
        </>;
      case 'blender':
        return <>
          <Gallery host={host} model={m} folder="renders" title="Renders" onZoom={setZoom} empty="No renders yet. Kiln saves them here." />
          {(m.files.mesh.some((f) => /\.stl$/i.test(f.name))) && (
            <section className="a3d-block">
              <h4>Interactive view</h4>
              <p className="a3d-muted">
                Orbit the model, shade overhangs in red, cut it at any height and check the bed fit.
                {m.view ? (m.view.stale ? ' The view is older than the model files: rebuild it.' : ' The view is up to date.') : ' Not built yet.'}
              </p>
              <p className="a3d-row">
                <button type="button" className="a3d-btn a3d-btn-primary" disabled={!scan?.tools.buildViewer} onClick={() => doAction({ kind: 'script', label: '3D view', script: 'view' }, null)}>
                  {m.view ? 'Rebuild and open' : 'Build and open'}
                </button>
              </p>
            </section>
          )}
          <BlenderBlock model={m} status={blender} kilnRun={scan?.tools.kilnRun ?? null} busy={kilnBusy} last={kilnLast[m.slug] ?? null}
            onRun={(c) => void runQuick(c)} onPrep={() => setKilnDialog('prep')} onFlexi={() => setKilnDialog('flexi')}
            onOpen={(rel) => void openBlender(rel)} onCommand={() => { setDialog('blender'); setDialogText(''); }} onSetup={() => setBlenderOpen(true)} />
          <Metrics model={m} />
          {fl('Mesh files', 'mesh')}
          {fl('Logs', 'print', (f) => /kiln-log|analysis/.test(f.name))}
        </>;
      case 'print':
        return <>
          {m.printPhotos.length > 0 && (
            <section className="a3d-block">
              <h4>Photos <span className="a3d-count">{m.printPhotos.length}</span></h4>
              <div className="a3d-gallery">{images(m.printPhotos).map((f) => {
                const path = `${m.dir}/print/photos/${f.name}`;
                return <figure key={f.name}><Img host={host} path={path} mtime={f.mtime} alt={f.name} onClick={() => setZoom({ path, mtime: f.mtime, name: f.name })} /><figcaption>{f.name}</figcaption></figure>;
              })}</div>
            </section>
          )}
          {m.printLog.length > 0 ? (
            <section className="a3d-block">
              <h4>Test prints <span className="a3d-block-actions"><button type="button" className="a3d-btn a3d-btn-small" onClick={() => setPrintForm(true)}>Log another…</button>
                <button type="button" className="a3d-btn a3d-btn-small" onClick={() => open(`${m.dir}/print/print-log.md`)}>Open log</button></span></h4>
              <table className="a3d-filetable">
                <thead><tr><th>Date</th><th>Result</th><th>Printer · filament</th><th>Change next time</th></tr></thead>
                <tbody>{[...m.printLog].reverse().map((e, n) => (
                  <tr key={n}><td className="a3d-num">{e.at.slice(0, 10)}</td>
                    <td>{e.skipped ? <span className="a3d-pill">skipped</span> : <span className={`a3d-pill a3d-pr-${e.result}`}>{e.result}</span>}</td>
                    <td>{[e.printer, e.filament].filter(Boolean).join(' · ')}{e.settings && <div className="a3d-muted">{e.settings}</div>}</td>
                    <td>{e.change ?? e.reason}</td></tr>
                ))}</tbody>
              </table>
            </section>
          ) : <p className="a3d-muted">No test print logged yet.</p>}
          {fl('3D files', 'mesh', (f) => /\.stl$/i.test(f.name))}
        </>;
      case 'validate':
        return <>
          <Metrics model={m} />
          {fl('Validation and slicing', 'print')}
        </>;
      default:
        return <>
          {m.hasReadme && (
            <section className="a3d-block">
              <h4>README</h4>
              <p className="a3d-row">
                <button type="button" className="a3d-btn" onClick={() => open(`${m.dir}/README.md`)}>Open README.md</button>
                <button type="button" className="a3d-btn" onClick={() => scan && open(`${scan.root}/README.md`)}>Open catalog</button>
              </p>
            </section>
          )}
          <Gallery host={host} model={m} folder="renders" title="Images used in the README" onZoom={setZoom} />
          {fl('Listings', 'publish')}
        </>;
    }
  };

  const printFile = model?.files.mesh.find((f) => f.name === 'print.stl') ?? model?.files.mesh.find((f) => f.name === 'clean.stl');

  const commands: Command[] = [
    { id: 'view', title: 'Build 3D view of the selected model', hint: model?.slug, disabled: !printFile ? 'needs an STL' : !scan?.tools.buildViewer ? 'Prism not installed' : false, run: () => void doAction({ kind: 'script', label: '3D view', script: 'view' }, null) },
    { id: 'views-all', title: 'Rebuild every 3D view', disabled: !scan?.tools.buildViewer ? 'Prism not installed' : false, run: () => void doAction({ kind: 'script', label: 'All views', script: 'views-all' }, null) },
    { id: 'portfolio', title: 'Build the portfolio dashboard', disabled: !scan?.tools.buildInsights ? 'Prism not installed' : false, run: () => void doAction({ kind: 'script', label: 'Portfolio', script: 'portfolio' }, null) },
    { id: 'new', title: 'New model…', hint: 'agent run', run: () => setNewModel({ pictures: [] }) },
    { id: 'readme', title: 'Rebuild README and catalog (no agent)', hint: model?.slug, disabled: !model ? 'select a model' : !scan?.tools.buildReadme ? 'script not found' : false, run: () => void doAction({ kind: 'script', label: 'README', script: 'readme' }, null) },
    { id: 'attempt', title: 'New attempt on the current step…', hint: step ? step.title : undefined, disabled: !model || !step ? 'select a model' : !scan?.tools.flowLog ? 'flow_log.py not found' : false, run: () => { if (step) { setTab('flow'); openNew(step.id); } } },
    { id: 'graph', title: 'Show the flow graph', run: () => { setTab('flow'); setFlowView('graph'); } },
    { id: 'branch', title: 'New branch… (another image, link, mesh or settings)', hint: model?.slug, disabled: !model ? 'select a model' : !scan?.tools.flowLog ? 'flow_log.py not found' : false, run: () => { setTab('flow'); setBranchDialog({ from: null }); } },
    { id: 'run-cmd', title: 'Run a command on the current step…', hint: step?.title, disabled: !model || !step ? 'select a model' : false, run: () => { if (step) { setTab('flow'); setRunDialog({ step: step.id, action: null }); } } },
    { id: 'tips', title: 'Tips for the current step', hint: step?.title, run: () => { setTab('flow'); setTipsOpen(true); } },
    { id: 'help', title: 'Help: status, next move, what each button runs', run: () => setTab('help') },
    { id: 'help-status', title: 'Status of all models (no agent)', disabled: !scan?.tools.helpStatus ? 'ai3d-help not installed' : false, run: () => { setTab('help'); void runStatus(); } },
    { id: 'help-next', title: 'Ask Compass: what next? (agent)', run: () => askCompass('*next', model?.slug) },
    ...(model && model.branches.length > 1 ? model.branches.map((b) => ({ id: `b-${b.id}`, title: `Switch to branch: ${b.name}`, hint: b.primary ? 'primary' : b.status, run: () => { setBranch(b.id); setTab('flow'); } })) : []),
    { id: 'add-image', title: 'Add image to the selected model…', hint: model?.slug, disabled: !model ? 'select a model' : false, run: () => { setTab('files'); void pickFiles('image'); } },
    { id: 'add-mesh', title: 'Add 3D model to the selected model…', hint: model?.slug, disabled: !model ? 'select a model' : false, run: () => { setTab('files'); void pickFiles('mesh'); } },
    { id: 'reveal', title: 'Show the model folder in Finder', hint: model?.slug, disabled: !model ? 'select a model' : false, run: () => model && void reveal(model, '') },
    { id: 'bl-status', title: 'Blender: status and setup', hint: blender?.version ?? undefined, run: () => { setBlenderOpen(true); void recheckBlender(); } },
    { id: 'bl-analyze', title: 'Blender: analyze the mesh (no agent)', hint: model?.slug, disabled: !model ? 'select a model' : !blender?.bin ? 'Blender not found' : false, run: () => { setTab('flow'); setStepId('blender'); void runQuick('analyze'); } },
    { id: 'bl-prep', title: 'Blender: quick prep… (no agent)', hint: model?.slug, disabled: !model ? 'select a model' : !blender?.bin ? 'Blender not found' : false, run: () => { setTab('flow'); setStepId('blender'); setKilnDialog('prep'); } },
    { id: 'bl-render', title: 'Blender: render previews (no agent)', hint: model?.slug, disabled: !model ? 'select a model' : !blender?.bin ? 'Blender not found' : false, run: () => { setTab('flow'); setStepId('blender'); void runQuick('render'); } },
    { id: 'bl-command', title: 'Blender command… (Kiln agent)', hint: model?.slug, disabled: !model ? 'select a model' : false, run: () => { setDialog('blender'); setDialogText(''); } },
    { id: 'bl-open', title: 'Open the model in Blender', hint: model?.slug, disabled: !model ? 'select a model' : !blender?.bin ? 'Blender not found' : false, run: () => { const f = model?.files.mesh.find((x) => x.name === 'work.blend') ?? model?.files.mesh.find((x) => x.name === 'print.stl') ?? model?.files.mesh.find((x) => /^raw\./.test(x.name)); void openBlender(f ? `mesh/${f.name}` : null); } },
    { id: 'tr-trend', title: 'Analyse a trend…', hint: 'Scout', run: () => { setTab('trends'); setDialog('trend'); setDialogText(''); } },
    { id: 'tr-similar', title: 'Similar model (photo, link or name)…', hint: 'Scout', run: () => { setTab('trends'); setDialog('similar'); setDialogText(''); } },
    { id: 'tr-season', title: 'Season or event…', hint: 'Scout', run: () => { setTab('trends'); setDialog('season'); setDialogText(''); } },
    { id: 'in-new', title: 'New idea… (Insights)', run: () => setTab('insights') },
    { id: 'tab-trends', title: 'Go to Trends', run: () => setTab('trends') },
    { id: 'tab-insights', title: 'Go to Insights', run: () => setTab('insights') },

    { id: 'print-log', title: 'Log a test print…', hint: model?.slug, disabled: !model ? 'select a model' : !scan?.tools.printLog ? 'print_log.py not found' : false, run: () => setPrintForm(true) },
    { id: 'archived', title: showArchived ? 'Hide archived branches' : 'Show archived branches', run: () => setShowArchived((v) => !v) },
    { id: 'notify', title: notify ? 'Turn notifications off' : 'Turn notifications on', run: toggleNotify },
    { id: 'keys', title: 'Keyboard shortcuts', run: () => setNote('Shortcuts: 1–7 tabs · Alt+↑/↓ previous / next model · in Flow: G graph or steps, N new attempt, B new branch, C run command on the step, T tips, A / R accept or reject the selected attempt · Cmd/Ctrl+K commands.') },
    { id: 'tab-models', title: 'Go to Models', run: () => setTab('models') },
    { id: 'tab-files', title: 'Go to Files', run: () => setTab('files') },
    { id: 'tab-flow', title: 'Go to Flow', run: () => setTab('flow') },
    { id: 'tab-settings', title: 'Go to Settings', run: () => setTab('settings') },
    { id: 'folder', title: 'Open the models folder', disabled: !scan ? 'still reading' : false, run: () => scan && void external(scan.root) },
    ...models.map((m) => ({ id: `m-${m.slug}`, title: `Open model: ${m.meta.title || m.slug}`, hint: m.meta.status, run: () => selectModel(m.slug, 'flow') })),
  ];


  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (palette || dialog || attempt || printForm || kilnDialog || blenderOpen || zoom || runDialog || branchDialog || newModel) return;
      const el = e.target as HTMLElement | null;
      if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable)) return;
      if (e.altKey && (e.key === 'ArrowDown' || e.key === 'ArrowUp') && models.length) {
        e.preventDefault();
        const i = Math.max(0, models.findIndex((m) => m.slug === slug));
        const next = models[(i + (e.key === 'ArrowDown' ? 1 : models.length - 1)) % models.length];
        selectModel(next.slug);
        return;
      }
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const k = e.key.toLowerCase();
      const tabs = ['models', 'flow', 'files', 'trends', 'insights', 'help', 'settings'] as const;
      if (/^[1-7]$/.test(k)) { setTab(tabs[Number(k) - 1]); return; }
      if (tab !== 'flow' || !model) return;
      if (k === 'g') setFlowView((v) => (v === 'graph' ? 'steps' : 'graph'));
      else if (k === 'n' && step && scan?.tools.flowLog && ATTEMPT_CHOICES[step.id]?.length) openNew(step.id);
      else if (k === 'b' && scan?.tools.flowLog) setBranchDialog({ from: nodeId ? model.flow.nodes.find((x) => x.id === nodeId) ?? null : null });
      else if (k === 'c' && step && step.state !== 'locked') setRunDialog({ step: step.id, action: null });
      else if (k === 't') setTipsOpen((v) => !v);
      else if ((k === 'a' || k === 'r') && nodeId) {
        const n = model.flow.nodes.find((x) => x.id === nodeId);
        if (n && !n.inferred) void setVerdict(n, k === 'a' ? 'accepted' : 'rejected');
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [palette, dialog, attempt, printForm, kilnDialog, blenderOpen, zoom, runDialog, branchDialog, models, slug, selectModel, tab, model, step, scan, openNew, nodeId, setVerdict]);

  if (off || notProject) {
    return (
      <div className="a3d" data-a3d-theme={/dark/i.test(String(theme)) ? 'dark' : 'light'}>
        <div className="a3d-idle">
          <h1>AI3D Forge</h1>
          {off ? <>
            <p>Turned off in this project. Nothing is scanned or run here.</p>
            <span className="a3d-row"><button type="button" className="a3d-btn a3d-btn-primary" onClick={() => { switchOff(false); void refresh(); }}>Turn on in this project</button></span>
          </> : <>
            <p>This project has no AI3D Forge module, so the panel is idle here: no agents, no Blender check, one look a minute to see if the module appeared.</p>
            <p className="a3d-muted">To use it here, install the module from the project root: <code>bash &lt;ai3d&gt;/scripts/update.sh</code> (a project with BMAD) — see the module README for a new project.</p>
            <span className="a3d-row">
              <button type="button" className="a3d-btn" onClick={() => void refresh()}>Check again</button>
              <button type="button" className="a3d-btn" onClick={() => switchOff(true)} title="Stops even the once-a-minute look in this project">Turn off in this project</button>
            </span>
          </>}
          <p className="a3d-muted a3d-small">The switch is kept per project. To remove the icon from every project, disable the extension in Nimbalyst’s extension settings.</p>
        </div>
      </div>
    );
  }

  return (
    <div className="a3d" data-a3d-theme={/dark/i.test(String(theme)) ? 'dark' : 'light'}>
      <main className="a3d-main">
        <div className="a3d-tabs" role="tablist">
          {([['models', 'Models'], ['flow', 'Flow'], ['files', 'Files'], ['trends', 'Trends'], ['insights', 'Insights'], ['help', 'Help'], ['settings', 'Settings']] as const).map(([id, label]) => (
            <button key={id} type="button" role="tab" aria-selected={tab === id} className="a3d-tab" onClick={() => setTab(id)}>{label}</button>
          ))}
          <span className="a3d-tabs-spacer" />
          {models.length > 0 && (
            <label className="a3d-switch">
              <span className="a3d-muted">Model</span>
              <select aria-label="Selected model" value={slug ?? ''} onChange={(e) => selectModel(e.target.value)}>
                {models.map((m) => <option key={m.slug} value={m.slug}>{m.meta.title || m.slug}</option>)}
              </select>
            </label>
          )}
          {model && model.branches.length > 1 && (
            <label className="a3d-switch">
              <span className="a3d-muted">Branch</span>
              <select aria-label="Selected branch" value={model.branch} onChange={(e) => setBranch(e.target.value)}>
                {model.branches.map((b) => <option key={b.id} value={b.id}>{branchLabel(b)}</option>)}
              </select>
            </label>
          )}
          {activeRuns.length > 0 && (
            <details className="a3d-running">
              <summary><span className="a3d-tag a3d-tag-run">{activeRuns.length} running</span></summary>
              <ul>{activeRuns.map(({ key, run }) => (
                <li key={run.at}>
                  <span>{run.label}{key !== GLOBAL ? ` · ${key}` : ''} <span className="a3d-muted">since {when(run.at)}{run.model ? ` · ${modelLabel(run.model)}` : ''}</span></span>
                  <span className="a3d-row">
                    <button type="button" className="a3d-link" onClick={() => { setViewKey(key); setViewRun(run.at); }}>show session</button>
                    <button type="button" className="a3d-link" title="Stop waiting for this run in the panel. The session itself keeps going in Nimbalyst." onClick={() => runStore.release(run.at)}>forget</button>
                  </span>
                </li>
              ))}</ul>
            </details>
          )}
          <BlenderChip status={blender} checking={blenderChecking} onClick={() => { setBlenderOpen(true); void recheckBlender(); }} />
          <button type="button" className="a3d-btn a3d-btn-small" onClick={() => setPalette(true)} title="Run a command">Commands <kbd>{/Mac/i.test(navigator.platform) ? '⌘' : 'Ctrl'}K</kbd></button>
        </div>
        {error && <div className="a3d-banner a3d-banner-error">{error}</div>}
        {scan && !scan.installed && !scan.tools.kilnLib && (
          <div className="a3d-banner">The AI3D Forge module was not found in this workspace. Install it so the agents exist: see the module README.
            <button type="button" className="a3d-link" onClick={() => switchOff(true)}>Turn off in this project</button></div>
        )}
        {scan && outdated(scan) && (() => {
          const cmd = updateCommand(scan);
          const lacks = missingFeatures(scan);
          return (
            <div className="a3d-banner a3d-banner-warn">
              <span>The AI3D skills in this project are {scan.module?.version ?? 'older'}; this panel is built for {EXPECTED_MODULE}.
                {lacks.length ? ` Not available until you update: ${lacks.join(', ')}.` : ''}
                {cmd ? <> Run in a terminal: <code>{cmd}</code></> : <> Unpack the new module and run <code>bash &lt;ai3d&gt;/scripts/update.sh</code> in the project root.</>}</span>
              <span className="a3d-row">
                {cmd && <button type="button" className="a3d-btn a3d-btn-small" onClick={async () => { await navigator.clipboard.writeText(cmd); setNote('Update command copied. Paste it into a terminal, then start a new session.'); }}>Copy command</button>}
                <button type="button" className="a3d-link" onClick={() => setTab('help')}>Setup check</button>
              </span>
            </div>
          );
        })()}
        {note && <div className="a3d-banner" role="status">{note}<button type="button" className="a3d-link" onClick={() => setNote(null)}>Dismiss</button></div>}

        {tab === 'models' && (scan ? (
          <ModelsTab host={host} scan={scan} stepsBySlug={stepsBySlug} selected={slug}
            onSelect={(s) => selectModel(s, 'flow')}
            onNew={() => setNewModel({ pictures: [] })}
            onScout={() => setTab('trends')}
            onSelectTrend={(s) => { setTrendSel(s); setTab('trends'); }}
            onPortfolio={() => void doAction({ kind: 'script', label: 'Portfolio', script: 'portfolio' }, null)} />
        ) : <div className="a3d-placeholder">{error ? '' : 'Reading models…'}</div>)}
        {tab === 'files' && scan && (
          <FilesTab host={host} scan={scan} model={model} nodeFilter={fileNode} importing={importing}
            onClearFilter={() => setFileNode(null)} onSelectModel={(s) => selectModel(s)}
            onZoom={setZoom} onOpen={openFileOf} onReveal={reveal}
            onView={() => void doAction({ kind: 'script', label: '3D view', script: 'view' }, null)}
            onPick={pickFiles} onFiles={addFiles} onConcept={(p) => setNewModel({ pictures: [p] })} />
        )}
        {tab === 'trends' && scan && (
          <TrendsTab host={host} scan={scan} busy={busy} selected={trendSel} onSelectTrend={setTrendSel}
            apify={blender ? (blender.servers ?? []).find((s) => s.forSessions && s.name.toLowerCase().includes((scan.config.scrape_mcp || 'apify').toLowerCase()))?.where ?? null : undefined}
            onAgent={onTrendAgent}
            onSet={(t, pairs) => void trendLibRun(`set ${sh(t._dir)} ${pairs.map(sh).join(' ')}`)}
            onPrepare={(t, i) => void prepareFromTrend(t, i)} onCreateModel={modelFromTrend}
            onSelectModel={(s) => selectModel(s, 'flow')} onSelectIdea={(s) => { setIdeaSel(s); setTab('insights'); }}
            onReveal={(d) => void host.exec(revealCmd(d), { timeout: 15000 })} onOpen={(f) => void host.openFile(f)} />
        )}
        {tab === 'insights' && scan && (
          <IdeasTab host={host} scan={scan} busy={busy} selected={ideaSel} onSelect={setIdeaSel}
            running={activeRuns.map((x) => x.run.label)} onZoom={setZoom} onPickImage={() => pickWithSystemDialog(host, 'image')}
            onRef={(i, r) => void trendLibRun([`ref ${sh(i._dir)}`, r.url ? `--url ${sh(r.url)}` : '', r.file ? `--file ${sh(r.file)}` : '', r.note ? `--note ${sh(r.note)}` : ''].filter(Boolean).join(' '))
              .then((o) => { if (o) setNote(o.added === false ? 'That link is already in the references.' : o.reference?.file ? 'Reference added; the picture is saved in refs/.' : 'Link added to the references.'); })}
            onRemoveRef={(i, n) => void trendLibRun(`ref ${sh(i._dir)} --remove ${n}`)}
            onCreate={(...a) => void createIdea(...a)} onAgent={onIdeaAgent}
            onDecide={(i, v) => void trendLibRun(`decide ${sh(i._dir)} ${v}`)}
            onSelectTrend={(s) => { setTrendSel(s); setTab('trends'); }} onSelectModel={(s) => selectModel(s, 'flow')}
            onReveal={(d) => void host.exec(revealCmd(d), { timeout: 15000 })} onOpen={(f) => void host.openFile(f)} />
        )}
        {tab === 'help' && scan && (
          <HelpTab scan={scan} model={model} blender={blender} steps={steps} stepsBySlug={stepsBySlug} tips={tips} busy={busy}
            statusText={statusText} statusBusy={statusBusy} onStatus={() => void runStatus()} onAsk={askCompass}
            onGo={(id) => { setTab('flow'); setFlowView('steps'); setStepId(id); }} onSelectModel={(s) => selectModel(s, 'flow')} />
        )}
        {tab === 'settings' && (
          <section className="a3d-settings-wrap">
            <h1>Settings</h1>
            <p className="a3d-muted">Module settings live in <code>_bmad/ai3d/config.yaml</code>, so agents, scripts and this panel always agree. The folder override is in Nimbalyst’s extension settings.</p>
            <SettingsForm workspace={host.workspacePath} io={execIo(host)} onSaved={() => void refresh()} />
            <section className="a3d-block">
              <h4>This project</h4>
              <p className="a3d-muted">Turn the panel off here: it stops scanning, checking Blender and notifying in this project. Other projects are not affected.</p>
              <button type="button" className="a3d-btn" onClick={() => switchOff(true)}>Turn off in this project</button>
            </section>
          </section>
        )}
        {tab === 'flow' && (!model ? (
          <div className="a3d-placeholder">{scan ? <>No model selected. <button type="button" className="a3d-link" onClick={() => setTab('models')}>Open Models</button></> : error ? '' : 'Reading models…'}</div>
        ) : (
          <>
            <header className="a3d-head">
              <div>
                <h1>{model.meta.title || model.slug}{model.branches.length > 1 && <span className="a3d-muted" style={{ fontWeight: 400 }}> · {currentBranch(model)?.name ?? model.branch}{model.branch === model.primary ? ' ★' : ''}</span>}</h1>
                <p className="a3d-muted">
                  {[model.meta.model_type, model.meta.status, model.meta.summary || model.meta.subject].filter(Boolean).join(' · ')}
                </p>
              </div>
              <span className="a3d-row">
                <button type="button" className="a3d-btn" onClick={() => { setFileNode(null); setTab('files'); }}>Files</button>
                <button type="button" className="a3d-btn" onClick={() => reveal(model, '')}>Show in Finder</button>
                {model.hasReadme && <button type="button" className="a3d-btn" onClick={() => host.openFile(`${model.dir}/README.md`)}>README</button>}
                {printFile && (
                  <button type="button" className="a3d-btn a3d-btn-primary" disabled={!scan?.tools.buildViewer} onClick={() => doAction({ kind: 'script', label: '3D view', script: 'view' }, null)}
                    title={scan?.tools.buildViewer ? 'Build the interactive view and open it in your browser' : 'Prism scripts not found in this workspace'}>
                    3D view{model.view?.stale ? ' (outdated)' : ''}
                  </button>
                )}
                {printFile && <button type="button" className="a3d-btn" onClick={() => external(`${model.dir}/mesh/${printFile.name}`)}>Open STL in slicer</button>}
              </span>
            </header>

            <div className="a3d-flowbar">
              <p className="a3d-now">
                {current ? <>Now: <strong>step {current.n} of {steps.length}, {current.title}</strong> · {current.state === 'waiting' ? 'your turn' : current.state === 'done' ? 'everything is done' : 'next up'}</> : null}
              </p>
              {(() => {
                const costs = model.flow.nodes.filter((n) => n.cost).reduce<Record<string, number>>((acc, n) => { acc[n.cost!.service] = (acc[n.cost!.service] ?? 0) + n.cost!.credits; return acc; }, {});
                const archivedCount = model.flow.nodes.length - visibleNodes(model.flow.nodes, false).length;
                return <span className="a3d-row a3d-flowmeta">
                  {Object.keys(costs).length > 0 && <span className="a3d-muted" title="Sum of the costs recorded on attempts">Cost: {Object.entries(costs).map(([s, c]) => `${Math.round(c * 100) / 100} ${s}`).join(' · ')}</span>}
                  {compare.length > 0 && <span className="a3d-pill">{compare.length === 1 ? 'pick one more to compare' : 'comparing 2'} <button type="button" className="a3d-link" onClick={() => setCompare([])}>clear</button></span>}
                  {archivedCount > 0 && <label className="a3d-check"><input type="checkbox" checked={showArchived} onChange={(e) => setShowArchived(e.target.checked)} /> show archived ({archivedCount})</label>}
                </span>;
              })()}
              <span className="a3d-seg" role="group" aria-label="Flow view">
                <button type="button" aria-pressed={flowView === 'graph'} onClick={() => setFlowView('graph')}>Graph</button>
                <button type="button" aria-pressed={flowView === 'steps'} onClick={() => setFlowView('steps')}>Steps</button>
              </span>
            </div>

            {(() => {
              const cb = currentBranch(model);
              return (
                <div className="a3d-branchbar" aria-label="Branches">
                  {model.branches.length > 1 && model.branches.filter((b) => b.status !== 'archived' || b.id === model.branch || showArchived).map((b) => (
                    <button key={b.id} type="button" className={`a3d-branchchip a3d-lane-c${laneIndex(model, b.id) % 8}`} aria-pressed={b.id === model.branch} onClick={() => setBranch(b.id)}
                      title={[b.source ? `from ${b.source.kind}: ${b.source.ref}` : null, `starts at ${b.from_step}`, b.description].filter(Boolean).join(' · ')}>
                      <span className="a3d-dot" />{b.name}{b.primary ? ' ★' : ''}{b.status !== 'open' ? ` · ${b.status}` : ''}
                    </button>
                  ))}
                  <button type="button" className="a3d-btn a3d-btn-small" disabled={!scan?.tools.flowLog || scan?.features?.branches === false} onClick={() => setBranchDialog({ from: null })}
                    title={`A separate line with its own files: another image, link, mesh or settings, carried to the end. Runs: ${shell.branchAdd('flow_log.py', '<model>', { name: '<name>', source: '<kind>:<ref>' })}`}>+ New branch…</button>
                  {cb && model.branches.length > 1 && <>
                    <span className="a3d-tabs-spacer" />
                    {!cb.primary && <button type="button" className="a3d-btn a3d-btn-small" onClick={() => void branchAction('promote', cb.id)} title={`This branch becomes the model's main result. Runs: ${shell.branchPromote('flow_log.py', '<model>', cb.id)}`}>Make primary ★</button>}
                    {!cb.primary && cb.status !== 'variant' && <button type="button" className="a3d-btn a3d-btn-small" onClick={() => void branchAction('variant', cb.id)} title="Publish this branch as its own variant, next to the primary">Mark as variant</button>}
                    {cb.status !== 'open' && <button type="button" className="a3d-btn a3d-btn-small" onClick={() => void branchAction('open', cb.id)}>Reopen</button>}
                    {!cb.primary && cb.status !== 'archived' && <button type="button" className="a3d-btn a3d-btn-small" onClick={() => void branchAction('archived', cb.id)} title="Hide the branch; nothing is deleted">Archive branch</button>}
                    <button type="button" className="a3d-btn a3d-btn-small" onClick={() => reveal(model, '')}>Branch folder</button>
                  </>}
                </div>
              );
            })()}
            {!model.migrated && scan?.tools.flowLog && (
              <p className="a3d-muted a3d-small">This model keeps its work files in the model folder. The first new branch moves them into <code>branches/main/</code>
                {' '}(or <button type="button" className="a3d-link" onClick={() => void branchAction('migrate', 'main')} title={`Runs: ${shell.migrate('flow_log.py', '<model>')}`}>move them now</button>).</p>
            )}
            {(() => {
              const cb = currentBranch(model);
              return cb && cb.id !== 'main' && (cb.source || cb.description) ? (
                <p className={`a3d-source a3d-lane-c${laneIndex(model, cb.id) % 8}`}>
                  Branch <strong>{cb.name}</strong>{cb.source ? <> started from a {cb.source.kind}: {cb.source.kind === 'link' ? <a href={cb.source.ref} target="_blank" rel="noreferrer">{cb.source.ref}</a> : cb.source.kind === 'text' ? <em>{cb.source.ref}</em> : <code>{cb.source.ref.split('/').pop()}</code>}</> : null}
                  {cb.from_step !== 'concept' ? `, at the ${cb.from_step} step` : ''}{cb.description ? ` — ${cb.description}` : ''}.
                </p>
              ) : null;
            })()}

            {flowView === 'graph' && (
              <>
                {compare.length === 2 && (() => {
                  const a = model.flow.nodes.find((x) => x.id === compare[0]);
                  const b = model.flow.nodes.find((x) => x.id === compare[1]);
                  return a && b ? <CompareView host={host} model={model} a={a} b={b} onClose={() => setCompare([])} onSwap={() => setCompare(([x, y]) => [y, x])}
                    onView3d={(n, f) => void view3d(n, f)} onOpen={(f, n) => openRel(f, n)} /> : null;
                })()}
                <FlowGraph model={model} steps={steps} selectedNode={nodeId} selectedStep={step?.id ?? null} compare={compare} showArchived={showArchived}
                  onSelectNode={(id) => {
                    const n = model.flow.nodes.find((x) => x.id === id);
                    if (n && nodeBranch(n) !== model.branch) setBranch(nodeBranch(n));
                    setNodeId(id); if (n) setStepId(n.step); setMoreOpen(false);
                  }}
                  onSelectStep={(id) => { setNodeId(null); setStepId(id); setMoreOpen(false); }}
                  onSelectBranch={(id) => setBranch(id)}
                  onNew={(id) => openNew(id)} />
                {(() => {
                  const n = nodeId ? model.flow.nodes.find((x) => x.id === nodeId) : null;
                  return n ? (
                    <NodeDetail key={n.id} model={model} node={n} busy={busy || !scan?.tools.flowLog} canEdit={!!scan?.tools.flowLog} inCompare={compare.includes(n.id)}
                      onCompare={toggleCompare}
                      onArchive={(x, v) => void flowCmd(`update ${sh(model.dir)} ${sh(x.id)} --archived ${v ? 'yes' : 'no'}`).then(() => { if (v && !showArchived) setNodeId(null); })}
                      onNote={(x, text) => void flowCmd(`note ${sh(model.dir)} ${sh(x.id)} ${sh(text)}`)}
                      onCost={(x, svc, cr) => void flowCmd(`update ${sh(model.dir)} ${sh(x.id)} --cost ${sh(`${svc}:${cr}`)}`)}
                      onSelectNode={(id) => { setNodeId(id); const t = model.flow.nodes.find((x) => x.id === id); if (t) setStepId(t.step); }}
                      onRerun={(x) => openNew(x.step, { parent: rerunParent(x), settings: x.settings, description: '' })}
                      onNext={(x) => openNew(steps[stepIndex(x.step) + 1]?.id ?? x.step, { parent: x.id })}
                      onBranch={(x) => setBranchDialog({ from: x })}
                      onVerdict={setVerdict} onOpen={(f) => openRel(f, n)} onFiles={(x) => { setFileNode(x.id); setTab('files'); }} />
                  ) : null;
                })()}
              </>
            )}

            {flowView === 'steps' && (
              <ol className="a3d-flow">
              {steps.map((s) => (
                <li key={s.id} className={`a3d-step a3d-${s.state}${step?.id === s.id ? ' a3d-step-selected' : ''}`}>
                  <button type="button" onClick={() => { setStepId(s.id); setMoreOpen(false); }}>
                    <span className="a3d-step-top">
                      <span className="a3d-step-n">{s.state === 'done' ? '✓' : s.n}</span>
                      <span className="a3d-step-title">{s.title}</span>
                    </span>
                    <span className="a3d-step-thumb">
                      {s.thumb ? <Img host={host} path={`${model.dir}/${s.thumb}`} mtime={model.stamp} alt="" /> : <span className="a3d-step-agent">{s.agent}</span>}
                    </span>
                    <span className="a3d-step-result">{s.result}</span>
                    <span className="a3d-step-state">
                      {s.state === 'done' ? 'Done' : s.state === 'active' ? 'Next' : s.state === 'waiting' ? 'Your turn' : 'Locked'}
                    </span>
                  </button>
                </li>
              ))}
              </ol>
            )}

            {step && (
              <section className="a3d-detail">
                <div className="a3d-detail-head">
                  <div>
                    <h3>Step {step.n} · {step.title} <span className="a3d-muted">— {step.agent}</span></h3>
                    <p>{step.hint}</p>
                  </div>
                  <div className="a3d-detail-actions">
                    {renderPrimary(step)}
                    {step.state !== 'locked' && step.id !== 'print' && (
                      <button type="button" className="a3d-btn" disabled={busy} onClick={() => setRunDialog({ step: step.id, action: step.primary?.kind === 'agent' ? step.primary : null })}
                        title="Pick any command of this step, add your own instruction and see the prompt before it runs">Run command…</button>
                    )}
                    <button type="button" className="a3d-btn" aria-pressed={tipsOpen} onClick={() => setTipsOpen((v) => !v)} title="How this step runs and how to get better results">Tips</button>
                    {step.state !== 'locked' && scan?.tools.flowLog && (ATTEMPT_CHOICES[step.id]?.length ?? 0) > 0 && (
                      <button type="button" className="a3d-btn" disabled={busy} onClick={() => openNew(step.id)}
                        title="Run this step again with its own settings and description">New attempt…</button>
                    )}
                    {step.state !== 'locked' && step.more.length > 0 && (
                      <div className="a3d-more">
                        <button type="button" className="a3d-btn" aria-expanded={moreOpen} onClick={() => setMoreOpen((v) => !v)}>Other actions</button>
                        {moreOpen && (
                          <div className="a3d-menu">
                            {step.more.map((a) => (
                              <button type="button" key={a.label} disabled={busy && a.kind === 'agent'} title={describe(a, scan, model)} onClick={() => doAction(a, step)}>{a.label}</button>
                            ))}
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                </div>
                {step.state !== 'locked' && scan && (() => {
                  const r = defaultRun(scan.config, step.id, step.primary?.kind === 'agent' ? step.primary.skill : '', step.primary?.kind === 'agent' ? step.primary.trigger : undefined);
                  return <p className="a3d-muted a3d-runline">Agent runs here use <strong>{modelLabel(r.model)}</strong>, reasoning <strong>{r.effort}</strong>{effortKeyword(r.effort) ? ` (“${effortKeyword(r.effort)}”)` : ''}. One run: Run command… · for good: <button type="button" className="a3d-link" onClick={() => setTab('settings')}>Settings → Agent runs</button>.</p>;
                })()}
                {tipsOpen && <StepTips tips={tips} step={step.id} onClose={() => setTipsOpen(false)} />}
                <div className="a3d-results">{renderResults(model, step)}</div>
              </section>
            )}
          </>
        ))}
      </main>

      <aside className="a3d-session">
        <header>
          <h2>Agent session</h2>
          {runList.length > 0 && (
            <select aria-label="Run" value={shownRun?.at ?? ''} onChange={(e) => setViewRun(Number(e.target.value))}>
              {runList.map((r) => (
                <option key={r.at} value={r.at}>{when(r.at)} · {r.label}{r.model ? ` · ${modelLabel(r.model)}` : ''}{r.status === 'running' ? ' (running)' : r.status === 'error' ? ' (failed)' : ''}</option>
              ))}
            </select>
          )}
        </header>
        <div className="a3d-session-body">
          {!shownRun && <p className="a3d-empty">Run a step and its agent session appears here. Answer verdict questions in this pane.</p>}
          {shownRun?.status === 'error' && <p className="a3d-banner a3d-banner-error">{shownRun.error}</p>}
          {shownRun && !shownRun.sessionId && shownRun.status === 'running' && <p className="a3d-empty">Starting the session…</p>}
          {shownRun?.sessionId && Transcript && <Transcript key={shownRun.sessionId} sessionId={shownRun.sessionId} />}
          {shownRun?.sessionId && !Transcript && (
            <p className="a3d-empty">This Nimbalyst version cannot embed transcripts in a panel. Open the session “AI3D · {viewKey === GLOBAL ? '' : `${viewKey} · `}{shownRun.label}” from the session list.</p>
          )}
        </div>
      </aside>

      {dialog && (
        <div className="a3d-overlay" onClick={() => setDialog(null)}>
          <form className="a3d-dialog" onClick={(e) => e.stopPropagation()} onSubmit={(e) => { e.preventDefault(); submitDialog(); }}>
            <h3>{dialog === 'new' ? 'New model' : dialog === 'score' ? 'Score ideas' : dialog === 'blender' ? `Blender command · ${model?.meta.title || model?.slug || ''}` : dialog === 'trend' ? 'Analyse a trend' : dialog === 'similar' ? 'Similar model' : dialog === 'season' ? 'Season or event' : 'Scout a category'}</h3>
            <label htmlFor="a3d-dialog-input">
              {dialog === 'trend' ? 'Topic or category, for example “flexi dragons” or “desk organisers”. Scout collects dated signals (Apify when connected) and curates ideas.'
                : dialog === 'similar' ? 'A link to the model (MakerWorld, Printables, Etsy…), its name, or a photo. Scout explains why it works, the licence and IP split, and proposes original models in the same niche.'
                : dialog === 'season' ? 'Event, for example “St Nicholas Day”, “Christmas”, “New Year”. Scout checks the publish-by date and what sold last year.'
                : dialog === 'blender' ? 'One instruction for Kiln to do in your open Blender, for example “show the underside and measure the thinnest leg”.'
                : dialog === 'new' ? 'Describe the model: subject, style, size, static or flexi.'
                : dialog === 'score' ? 'Category with a Scout shortlist to score, for example “lizards”.'
                : 'Category to research, for example “lizards” or “owls”.'}
            </label>
            {dialog === 'new' || dialog === 'blender' || dialog === 'similar' || dialog === 'trend'
              ? <textarea id="a3d-dialog-input" autoFocus rows={5} value={dialogText} onChange={(e) => setDialogText(e.target.value)} />
              : <input id="a3d-dialog-input" autoFocus list={dialog === 'score' ? 'a3d-shortlist-names' : dialog === 'season' ? 'a3d-events' : undefined} value={dialogText} onChange={(e) => setDialogText(e.target.value)} />}
            {dialog === 'similar' && (
              <p className="a3d-row"><button type="button" className="a3d-btn a3d-btn-small" onClick={() => void choosePhoto()}>Choose photo…</button><span className="a3d-muted a3d-small">adds the file path; Scout copies it into the trend’s refs/</span></p>
            )}
            {dialog === 'season' && (
              <datalist id="a3d-events">{(scan?.calendar ?? []).map((e) => <option key={e.id} value={e.name} />)}</datalist>
            )}
            {dialog === 'score' && (
              <datalist id="a3d-shortlist-names">
                {(scan?.shortlists ?? []).map((f) => <option key={f.name} value={f.name.replace(/\.md$/, '')} />)}
              </datalist>
            )}
            <span className="a3d-row a3d-row-end">
              <button type="button" className="a3d-btn" onClick={() => setDialog(null)}>Cancel</button>
              <button type="submit" className="a3d-btn a3d-btn-primary" disabled={!dialogText.trim() || busy}>
                {dialog === 'new' ? 'Run: write concept' : dialog === 'score' ? 'Run: score' : dialog === 'blender' ? 'Run in Blender (Kiln)' : dialog === 'trend' || dialog === 'similar' || dialog === 'season' ? 'Run: Scout' : 'Run: scout'}
              </button>
            </span>
          </form>
        </div>
      )}

      {attempt && model && scan && (
        <AttemptDialog key={`${attempt.step}-${attempt.parent}`} model={model} scan={scan!} initial={attempt} busy={busy}
          onBranch={() => { const from = attempt.parent ? model.flow.nodes.find((x) => x.id === attempt.parent) ?? null : null; setAttempt(null); setBranchDialog({ from }); }}
          defaultRun={defaultRun(scan?.config ?? {}, attempt.step, ATTEMPT_CHOICES[attempt.step]?.[0]?.skill ?? '', ATTEMPT_CHOICES[attempt.step]?.[0]?.trigger)}
          stepTitle={(id) => steps.find((x) => x.id === id)?.title ?? id}
          onCancel={() => setAttempt(null)}
          onRun={(action: AgentAction, req) => {
            setAttempt(null);
            const st = steps.find((x) => x.id === req.step) ?? null;
            void doAction(action, st, undefined, req);
          }} />
      )}

      {newModel && scan && (
        <NewModelDialog host={host} model={model} pictures={newModel.pictures} busy={busy} defaultRun={defaultRun(scan.config, 'concept', 'ai3d-muse', '*concept')}
          onPick={() => pickWithSystemDialog(host, 'image')} onCancel={() => setNewModel(null)} onRun={(r) => void startConcept(r)} />
      )}
      {runDialog && model && scan && steps.find((x) => x.id === runDialog.step) && (
        <RunCommandDialog model={model} scan={scan} step={steps.find((x) => x.id === runDialog.step)!} initial={runDialog.action} tips={tips} busy={busy}
          onCancel={() => setRunDialog(null)} onRun={runCommand} />
      )}
      {branchDialog && model && (
        <NewBranchDialog model={model} from={branchDialog.from} busy={busy} stepTitle={(id) => steps.find((x) => x.id === id)?.title ?? id}
          onPick={(k) => pickWithSystemDialog(host, k)} onCancel={() => setBranchDialog(null)} onCreate={(r) => void createBranch(r)} />
      )}

      {blenderOpen && (
        <BlenderDialog status={blender} checking={blenderChecking} kilnInstalled={!!scan?.tools.kilnRun} guide={!!scan?.tools.blenderGuide}
          onCheck={() => void recheckBlender()} onGuide={openGuide} onLaunch={() => void openBlender(null)} onClose={() => setBlenderOpen(false)} />
      )}
      {kilnDialog && model && (
        <KilnDialog cmd={kilnDialog} model={model} onCancel={() => setKilnDialog(null)}
          onRun={(r: QuickRequest) => { setKilnDialog(null); setStepId('blender'); void runQuick(r.cmd, r.opts, r.description); }} />
      )}

      {printForm && model && (
        <PrintLogDialog model={model} last={[...model.printLog].reverse().find((e) => !e.skipped) ?? null}
          onPickPhotos={() => pickWithSystemDialog(host, 'image')} onCancel={() => setPrintForm(false)} onSave={(r) => void savePrintLog(r)} />
      )}

      {palette && <Palette commands={commands} onClose={() => setPalette(false)} />}

      {zoom && (
        <div className="a3d-overlay" onClick={() => setZoom(null)}>
          <figure className="a3d-zoom">
            <Img host={host} path={zoom.path} mtime={zoom.mtime} alt={zoom.name} />
            <figcaption>{zoom.name}</figcaption>
          </figure>
        </div>
      )}
    </div>
  );
}
