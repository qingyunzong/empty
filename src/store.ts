import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { Hash } from "./hash.js";

/** Content-addressed artifact store: component cache key -> artifact hash. */
export interface ArtifactStore {
  get(key: Hash): Hash | undefined;
  put(key: Hash, artifact: Hash): void;
  delete(key: Hash): void;
  keys(): Hash[];
}

export class InMemoryStore implements ArtifactStore {
  private readonly map = new Map<Hash, Hash>();
  get(key: Hash): Hash | undefined {
    return this.map.get(key);
  }
  put(key: Hash, artifact: Hash): void {
    this.map.set(key, artifact);
  }
  delete(key: Hash): void {
    this.map.delete(key);
  }
  keys(): Hash[] {
    return [...this.map.keys()];
  }
}

/** JSON-file-backed store so old compile tasks can be resumed later. */
export class JsonFileStore implements ArtifactStore {
  private readonly map: Map<Hash, Hash>;

  constructor(private readonly path: string) {
    this.map = new Map();
    if (existsSync(path)) {
      const raw = JSON.parse(readFileSync(path, "utf8")) as Record<string, string>;
      for (const [k, v] of Object.entries(raw)) this.map.set(k, v);
    }
  }
  get(key: Hash): Hash | undefined {
    return this.map.get(key);
  }
  put(key: Hash, artifact: Hash): void {
    this.map.set(key, artifact);
  }
  delete(key: Hash): void {
    this.map.delete(key);
  }
  keys(): Hash[] {
    return [...this.map.keys()];
  }
  save(): void {
    mkdirSync(dirname(this.path), { recursive: true });
    writeFileSync(this.path, JSON.stringify(Object.fromEntries(this.map), null, 2));
  }
}
