import type { ExtensionStorage } from '@nimbalyst/extension-sdk';
import type { Run } from './types';

/**
 * Agent runs, kept at module level: a fullscreen panel unmounts when the user
 * leaves it, but a run started from it keeps going and must still be recorded.
 */
type Listener = () => void;
type AiService = {
  sendPrompt(options: { prompt: string; sessionName?: string; model?: string }): Promise<{ sessionId: string; response: string }>;
};

const KEY = 'runs';
const KEEP = 15;
let runs: Record<string, Run[]> = {};
let storage: ExtensionStorage | null = null;
let ai: AiService | null = null;
/** Runs whose first agent turn has not ended yet (sendPrompt resolves only then). Several may run at once. */
let pending: Run[] = [];
const STALE_MS = 45 * 60 * 1000;
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

const live = () => pending.filter((r) => Date.now() - r.at < STALE_MS);

/** Runs that are still in their first turn, newest first. */
export function active(): { key: string; run: Run }[] {
  const out: { key: string; run: Run }[] = [];
  for (const r of live()) {
    const key = Object.keys(runs).find((k) => runs[k].includes(r));
    if (key) out.push({ key, run: r });
  }
  return out.reverse();
}

/** True only when the very same action is already running for the same model (a double click). */
export function isBusy(key?: string, label?: string) {
  if (key === undefined) return false;
  return live().some((r) => r.label === label && (runs[key] ?? []).includes(r));
}

/** Forget a run that never came back (the session may still be going in Nimbalyst). */
export function release(at: number) {
  const r = pending.find((x) => x.at === at);
  if (!r) return;
  pending = pending.filter((x) => x !== r);
  r.status = 'done';
  emit();
}

/** The host announces a new session as soon as it is created; attach it to the run in flight. */
export function noteSessionCreated(sessionId: string) {
  // sessions are announced in the order they were started: the oldest run still waiting for its id gets this one
  const r = pending.find((x) => !x.sessionId);
  if (r) {
    r.sessionId = sessionId;
    emit();
  }
}

export function startRun(
  key: string, step: string, label: string, prompt: string, sessionName: string,
  onSettled?: (status: 'done' | 'error', error?: string) => void,
  model?: string,
): Run | null {
  if (!ai || isBusy(key, label)) return null;
  const run: Run = { sessionId: null, step, label, at: Date.now(), status: 'running', model: model || undefined };
  runs[key] = [run, ...(runs[key] ?? [])].slice(0, KEEP);
  pending = [...live(), run];
  emit();
  ai.sendPrompt(model ? { prompt, sessionName, model } : { prompt, sessionName }).then(
    (res) => {
      run.sessionId = res.sessionId;
      run.status = 'done';
    },
    (err) => {
      run.status = 'error';
      run.error = err instanceof Error ? err.message : String(err);
    },
  ).finally(() => {
    pending = pending.filter((x) => x !== run);
    emit();
    try { onSettled?.(run.status === 'error' ? 'error' : 'done', run.error); } catch { /* the record is best-effort */ }
    finishListeners.forEach((cb) => { try { cb(key, run); } catch { /* a listener must not break the run */ } });
  });
  return run;
}
