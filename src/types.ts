export interface FileEntry {
  name: string;
  size: number;
  mtime: number;
}

export type Folder = 'inbox' | 'images' | 'renders' | 'refs' | 'mesh' | 'print' | 'prompts' | 'publish';

export type NodeStatus = 'running' | 'open' | 'done' | 'error';

/** One attempt at one step (see skills/ai3d-forge/references/flow-graph.md). */
export interface FlowNode {
  id: string;
  step: string;
  agent: string;
  label: string;
  parent: string | null;
  status: NodeStatus;
  verdict: 'accepted' | 'rejected' | null;
  created_at: string;
  finished_at: string | null;
  settings: Record<string, string>;
  description: string;
  outcome: string;
  files: string[];
  /** Rebuilt from files for models that have no flow.json entry for it; cannot be edited. */
  inferred?: boolean;
  cost?: { service: string; credits: number };
  notes?: { at: string; text: string }[];
  archived?: boolean;
  /** Branch the attempt belongs to (missing in older flow.json files: main). */
  branch?: string;
}

export interface Flow {
  nodes: FlowNode[];
  /** Nodes really recorded in flow.json (the rest is inferred). */
  real: number;
}

/** One work folder: a branch folder, or the model folder of a model that has no branches/ yet. */
export interface WorkFolder {
  dir: string;
  meta: Record<string, any>;
  concept: string | null;
  files: Record<Folder, FileEntry[]>;
  attempts: FileEntry[];
  imagePrompt: { name: string; text: string | null } | null;
  prompt3d: string | null;
  analysis: Record<string, any> | null;
  hasReadme: boolean;
  view: { mtime: number; stale: boolean } | null;
  printLog: PrintEntry[];
  printPhotos: FileEntry[];
  /** refs/source.md: the link or brief the branch started from. */
  source: string | null;
  /** Accepted multi-view images for 3D (images/views/front.png, left, back, right…). */
  views?: FileEntry[];
  /** View images waiting for review (inbox/views/). */
  viewsInbox?: FileEntry[];
  /** Latest prompts/views-vN.md. */
  viewsPrompt?: { name: string; text: string | null } | null;
  stamp: number;
}

/** A separate line of the model with its own files, from one step to the end. */
export interface Branch {
  id: string;
  name: string;
  parent_branch: string | null;
  from_node: string | null;
  from_step: string;
  source: { kind: 'image' | 'mesh' | 'link' | 'text'; ref: string } | null;
  description: string;
  status: 'open' | 'variant' | 'archived';
  created_at: string | null;
  primary: boolean;
  exists: boolean;
  work: WorkFolder;
}

export interface Model {
  slug: string;
  /** Work folder of the branch this view shows (the primary branch in the scan). */
  dir: string;
  /** The model folder: metadata.json, flow.json, branches/. */
  rootDir: string;
  /** Branch this view shows. */
  branch: string;
  primary: string;
  /** The work folders are in branches/ (false: main is the model folder itself). */
  migrated: boolean;
  branches: Branch[];
  source?: string | null;
  views?: FileEntry[];
  viewsInbox?: FileEntry[];
  viewsPrompt?: { name: string; text: string | null } | null;
  meta: Record<string, any>;
  concept: string | null;
  files: Record<Folder, FileEntry[]>;
  /** Earlier mesh / STL attempts kept in mesh/attempts/. */
  attempts: FileEntry[];
  imagePrompt: { name: string; text: string | null } | null;
  prompt3d: string | null;
  analysis: Record<string, any> | null;
  hasReadme: boolean;
  view: { mtime: number; stale: boolean } | null;
  flow: Flow;
  printLog: PrintEntry[];
  printPhotos: FileEntry[];
  stamp: number;
}

export interface Scan {
  workspace: string;
  root: string;
  rootExists: boolean;
  installed: boolean;
  tools: { stepTips: string | null; helpStatus: string | null; buildReadme: string | null; kilnLib: string | null; buildViewer: string | null; buildInsights: string | null; flowLog: string | null;
    kilnRun: string | null; blenderGuide: string | null; trendLib: string | null; printLog: string | null };
  config: Record<string, string>;
  /** python3 that ran the scan. */
  python?: string;
  /** Installed module (BMAD manifest) and a newer copy found next to its source. */
  module?: { version: string | null; source: string | null; newer: { version: string; path: string } | null };
  /** What the installed skills can do (older skills lack some scripts). */
  features?: { branches: boolean; webRefs: boolean; help: boolean; views: boolean };
  configPath: string;
  /** Generated dashboards in <models>/_insights (portfolio). */
  dashboards: FileEntry[];
  trendsRoot: string;
  ideasRoot: string;
  trends: Trend[];
  /** insight.json documents (the Insights tab). */
  ideas: Insight[];
  calendar: CalEvent[];
  shortlists: FileEntry[];
  models: Model[];
}

export interface Run {
  sessionId: string | null;
  step: string;
  label: string;
  at: number;
  status: 'running' | 'done' | 'error';
  error?: string;
  /** Model id the run was started with (missing: Nimbalyst's default). */
  model?: string;
}

export interface Evidence { label: string; url?: string }

/** Fields every scored idea shares (trend ideas and insights). */
export interface Scored {
  scores?: Record<string, number>;
  estimated?: string[];
  evidence?: Evidence[];
}

export interface TrendIdea extends Scored {
  id: string;
  name: string;
  pitch?: string;
  model_type?: string;
  descriptor?: string;
  status?: 'candidate' | 'picked' | 'modeled';
  insight?: string | null;
  model?: string | null;
  notes?: string;
}

export interface Signal { source?: string; url?: string; metric?: string; value?: string | number; at?: string; note?: string }

interface DocMeta { _dir: string; _files: string[]; _refs: string[]; _mtime: number; created_at?: string; updated_at?: string }

export interface Trend extends DocMeta {
  slug: string;
  title: string;
  kind: 'trend' | 'similar' | 'season';
  status: 'new' | 'watching' | 'used' | 'dropped';
  query?: string;
  summary?: string;
  saturation?: 'low' | 'medium' | 'high' | null;
  signals: Signal[];
  ideas: TrendIdea[];
  source?: { input?: string; url?: string | null; title?: string | null; license?: string | null; price?: string | number | null; downloads?: string | number | null };
  ip?: { can_take?: string[]; must_avoid?: string[]; risk?: string | null };
  event?: { name?: string; date?: string | null; publish_by?: string | null };
  recheck_at?: string | null;
  notes?: string;
}

export interface Insight extends DocMeta, Scored {
  slug: string;
  title: string;
  subject_kind?: string;
  status: 'draft' | 'prepared' | 'go' | 'later' | 'no' | 'modeled';
  trend?: string | null;
  idea?: string | null;
  description?: string;
  traits?: string[];
  references?: { title?: string; url?: string; file?: string; note?: string }[];
  variants?: { id: string; model_type?: string; style?: string; size_mm?: number; printability?: number; notes?: string }[];
  chosen_variant?: string | null;
  similar?: { title?: string; url?: string; downloads?: string | number; price?: string | number | null; note?: string }[];
  ip?: { risk?: string | null; notes?: string };
  decision?: { verdict: string; reason?: string; at?: string } | null;
  model?: string | null;
}

export interface CalEvent { id: string; name: string; date: string; publish_by: string; days_left: number; days_to_publish: number; lead_days: number }

export interface PrintEntry {
  at: string;
  skipped?: boolean;
  reason?: string;
  result?: 'ok' | 'issues' | 'fail';
  printer?: string;
  filament?: string;
  settings?: string;
  change?: string;
  notes?: string;
  photos?: string[];
  stl?: string;
}
