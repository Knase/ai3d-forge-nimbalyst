import { STEP_IDS } from './flow';
import type { FlowNode } from './types';

export const stepIndex = (id: string) => (STEP_IDS as readonly string[]).indexOf(id);

const byTime = (a: FlowNode, b: FlowNode) => (a.created_at < b.created_at ? -1 : a.created_at > b.created_at ? 1 : 0);

/** Nodes of one step, oldest first. */
export function nodesOfStep(nodes: FlowNode[], step: string) {
  return nodes.filter((n) => n.step === step).sort(byTime);
}

/** The node the model currently stands on: the furthest step that has a usable attempt, newest first. */
export function headNode(nodes: FlowNode[]): FlowNode | null {
  const usable = nodes.filter((n) => n.verdict !== 'rejected' && n.status !== 'error');
  if (!usable.length) return null;
  return usable.sort((a, b) => stepIndex(b.step) - stepIndex(a.step) || Number(b.verdict === 'accepted') - Number(a.verdict === 'accepted') || byTime(b, a))[0];
}

/** Ids of the node and all its ancestors. */
export function lineage(nodes: FlowNode[], id: string | null): Set<string> {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const out = new Set<string>();
  let cur = id ? byId.get(id) : undefined;
  while (cur && !out.has(cur.id)) {
    out.add(cur.id);
    cur = cur.parent ? byId.get(cur.parent) : undefined;
  }
  return out;
}

/**
 * Where a new attempt on `step` grows from by default.
 * Image prompts are edited in place, so a new one grows from the latest version that is not accepted yet.
 * Every other step grows from the best node of the nearest earlier step.
 */
export function defaultParent(nodes: FlowNode[], step: string): string | null {
  if (step === 'image') {
    const open = nodesOfStep(nodes, 'image').filter((n) => n.verdict !== 'accepted');
    if (open.length) return open[open.length - 1].id;
  }
  for (let k = stepIndex(step) - 1; k >= 0; k--) {
    const list = nodesOfStep(nodes, STEP_IDS[k]).filter((n) => n.verdict !== 'rejected' && n.status !== 'error');
    if (!list.length) continue;
    const accepted = list.filter((n) => n.verdict === 'accepted');
    return (accepted.length ? accepted : list).slice(-1)[0].id;
  }
  return null;
}

/** Parent for "run again" on an existing node: images chain, every other step branches. */
export function rerunParent(n: FlowNode): string | null {
  return n.step === 'image' ? n.id : n.parent;
}

export interface Placed {
  node: FlowNode;
  row: number;
  slot: number;
}

export function place(nodes: FlowNode[]): { placed: Placed[]; slots: number[] } {
  const slots = STEP_IDS.map(() => 0);
  const placed: Placed[] = [];
  for (let row = 0; row < STEP_IDS.length; row++) {
    nodesOfStep(nodes, STEP_IDS[row]).forEach((node, slot) => {
      placed.push({ node, row, slot });
      slots[row] = slot + 1;
    });
  }
  return { placed, slots };
}

export function settingsLine(n: FlowNode, max = 2) {
  const kv = Object.entries(n.settings);
  if (!kv.length) return '';
  return kv.slice(0, max).map(([k, v]) => `${k}=${v}`).join(' ') + (kv.length > max ? ` +${kv.length - max}` : '');
}
