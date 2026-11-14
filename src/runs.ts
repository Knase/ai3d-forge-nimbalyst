import type { ExtensionStorage } from '@nimbalyst/extension-sdk';
import type { Run } from './types';

/**
 * Agent runs, kept at module level: a fullscreen panel unmounts when the user
 * leaves it, but a run started from it keeps going and must still be recorded.
 */
type Listener = () => void;
type AiService = {
  sendPrompt(options: { prompt: string; sessionName?: string }): Promise<{ sessionId: string; response: string }>;
};

const KEY = 'runs';
const KEEP = 15;
let runs: Record<string, Run[]> = {};
let storage: ExtensionStorage | null = null;
let ai: AiService | null = null;
let pending: Run | null = null;
const listeners = new Set<Listener>();
const finishListeners = new Set<(key: string, run: Run) => void>();

/** Called once for every run when its agent turn ends (done or failed). */
export function onRunFinished(cb: (key: string, run: Run) => void) {
  finishListeners.add(cb);
  return () => { finishListeners.delete(cb); };
}

function emit() {
  runs = { ...runs };
  listeners.forEach((l) => l());
  void storage?.set(KEY, runs);
}

export function setAi(service: AiService | null) {
  ai = service;
}

export function hasAi() {
  return !!ai;
}

export function attachStorage(s: ExtensionStorage) {
  if (storage) return;
  storage = s;
  const saved = s.get<Record<string, Run[]>>(KEY) ?? {};
  // Runs still marked running were cut off by a restart; their sessions remain in history.
  for (const list of Object.values(saved)) {
    for (const r of list) if (r.status === 'running') r.status = 'done';
  }
  runs = { ...saved, ...runs };
  listeners.forEach((l) => l());
}

export function subscribe(l: Listener) {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
}

export function snapshot() {
  return runs;
}

export function isBusy() {
  return pending !== null;
}

/** The host announces a new session as soon as it is created; attach it to the run in flight. */
export function noteSessionCreated(sessionId: string) {
  if (pending && !pending.sessionId) {
    pending.sessionId = sessionId;
    emit();
  }
}

export function startRun(
  key: string, step: string, label: string, prompt: string, sessionName: string,
  onSettled?: (status: 'done' | 'error', error?: string) => void,
): Run | null {
  if (!ai || pending) return null;
  const run: Run = { sessionId: null, step, label, at: Date.now(), status: 'running' };
  runs[key] = [run, ...(runs[key] ?? [])].slice(0, KEEP);
  pending = run;
  emit();
  ai.sendPrompt({ prompt, sessionName }).then(
    (res) => {
      run.sessionId = res.sessionId;
      run.status = 'done';
    },
    (err) => {
      run.status = 'error';
      run.error = err instanceof Error ? err.message : String(err);
    },
  ).finally(() => {
    if (pending === run) pending = null;
    emit();
    try { onSettled?.(run.status === 'error' ? 'error' : 'done', run.error); } catch { /* the record is best-effort */ }
    finishListeners.forEach((cb) => { try { cb(key, run); } catch { /* a listener must not break the run */ } });
  });
  return run;
}
