import { defaultParent } from './flowGraph';
import type { Branch, FlowNode, Model } from './types';

export const nodeBranch = (n: FlowNode) => n.branch ?? 'main';

/** The validated default categorical palette, in fixed order: lane i always gets slot i (main is slot 1). */
export const LANE_COLORS = ['#2a78d6', '#eb6834', '#1baf7a', '#e87ba4', '#6250d6', '#e34948', '#eda100', '#008300'];
export const LANE_COLORS_DARK = ['#3987e5', '#d95926', '#199e70', '#d55181', '#9085e9', '#e66767', '#c98500', '#0ca30c'];

/** The model as seen from one branch: that branch's files and folder, every branch's nodes. */
export function withBranch(m: Model, id: string | null | undefined): Model {
  const b = m.branches.find((x) => x.id === id);
  if (!b || b.id === m.branch) return m;
  return { ...m, ...b.work, meta: { ...b.work.meta, title: m.meta.title ?? b.work.meta.title }, branch: b.id };
}

export function currentBranch(m: Model): Branch | null {
  return m.branches.find((b) => b.id === m.branch) ?? null;
}

/** Nodes of the branch the view shows. */
export function branchNodes(m: Model, nodes: FlowNode[] = m.flow.nodes): FlowNode[] {
  return nodes.filter((n) => nodeBranch(n) === m.branch);
}

/** Where a new attempt in this branch grows from: the branch's own nodes first, else the node it branched off. */
export function parentFor(m: Model, nodes: FlowNode[], step: string): string | null {
  return defaultParent(branchNodes(m, nodes), step) ?? currentBranch(m)?.from_node ?? null;
}

export function branchLabel(b: Branch) {
  const tags = [b.primary ? 'primary' : null, b.status !== 'open' ? b.status : null].filter(Boolean);
  return `${b.name}${tags.length ? ` (${tags.join(', ')})` : ''}`;
}

/** Index of a branch in the model's fixed order, for its lane colour. */
export const laneIndex = (m: Model, id: string) => Math.max(0, m.branches.findIndex((b) => b.id === id));

/** Work folder an attempt's files are relative to. */
export function dirOf(m: Model, n: FlowNode): string {
  return m.branches.find((b) => b.id === nodeBranch(n))?.work.dir ?? m.dir;
}
