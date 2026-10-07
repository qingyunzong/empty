export interface Diff {
  pull: string[];
  remove: string[];
}

/** Reference: full-map comparison between local state and a remote snapshot. */
export function referenceDiff(local: Map<string, string>, remote: Map<string, string>): Diff {
  const pull: string[] = [];
  const remove: string[] = [];
  for (const [key, value] of remote) {
    if (local.get(key) !== value) pull.push(key);
  }
  for (const key of local.keys()) {
    if (!remote.has(key)) remove.push(key);
  }
  pull.sort();
  remove.sort();
  return { pull, remove };
}
