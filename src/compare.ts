import type { NodeId } from "./types";

export interface Candidate {
  path: NodeId[];
  maxEdgeCost: number;
  totalCost: number;
}

const CHUNK = /\d+|\D+/g;

function compareNumericChunks(x: string, y: string): number {
  const nx = x.replace(/^0+/, "") || "0";
  const ny = y.replace(/^0+/, "") || "0";
  if (nx.length !== ny.length) return nx.length < ny.length ? -1 : 1;
  if (nx !== ny) return nx < ny ? -1 : 1;
  if (x.length !== y.length) return x.length < y.length ? -1 : 1;
  return 0;
}

export function compareIds(a: NodeId, b: NodeId): number {
  if (a === b) return 0;
  const ca = a.match(CHUNK) ?? [];
  const cb = b.match(CHUNK) ?? [];
  const n = Math.min(ca.length, cb.length);
  for (let i = 0; i < n; i++) {
    const x = ca[i];
    const y = cb[i];
    if (x === y) continue;
    const xDigit = x.charCodeAt(0) >= 48 && x.charCodeAt(0) <= 57;
    const yDigit = y.charCodeAt(0) >= 48 && y.charCodeAt(0) <= 57;
    if (xDigit && yDigit) {
      const c = compareNumericChunks(x, y);
      if (c !== 0) return c;
    } else {
      return x < y ? -1 : 1;
    }
  }
  if (ca.length !== cb.length) return ca.length < cb.length ? -1 : 1;
  return 0;
}

export function compareSequences(a: NodeId[], b: NodeId[]): number {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    const c = compareIds(a[i], b[i]);
    if (c !== 0) return c;
  }
  if (a.length !== b.length) return a.length < b.length ? -1 : 1;
  return 0;
}

export function compareCandidates(a: Candidate, b: Candidate): number {
  if (a.maxEdgeCost !== b.maxEdgeCost) return a.maxEdgeCost < b.maxEdgeCost ? -1 : 1;
  if (a.totalCost !== b.totalCost) return a.totalCost < b.totalCost ? -1 : 1;
  return compareSequences(a.path, b.path);
}
