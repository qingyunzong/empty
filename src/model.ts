/** A single artifact entry in a manifest. Identity is `id`; `path` may move. */
export interface Artifact {
  readonly id: string;
  readonly path: string;
  readonly digest: string;
}

/** A manifest is a set of artifacts with unique ids. */
export type Manifest = ReadonlyArray<Artifact>;

export function sameArtifact(a: Artifact, b: Artifact): boolean {
  return a.path === b.path && a.digest === b.digest;
}

/** Index a manifest by object id, rejecting duplicate ids. */
export function indexById(manifest: Manifest): Map<string, Artifact> {
  const byId = new Map<string, Artifact>();
  for (const artifact of manifest) {
    if (byId.has(artifact.id)) {
      throw new Error(`duplicate artifact id in manifest: ${artifact.id}`);
    }
    byId.set(artifact.id, artifact);
  }
  return byId;
}

/** Sort artifacts by id for deterministic output. */
export function sortById(artifacts: ReadonlyArray<Artifact>): Artifact[] {
  return [...artifacts].sort((x, y) => (x.id < y.id ? -1 : x.id > y.id ? 1 : 0));
}
