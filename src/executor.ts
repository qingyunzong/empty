import { existsSync, readFileSync } from 'node:fs';
import { CacheStore, makeRecord } from './cache.js';
import { StageDef, topoSort, validateStages } from './dag.js';
import { hashInputFiles, stageDigest } from './digest.js';

export type StageStatus = 'executed' | 'reused' | 'failed' | 'skipped';

export interface ExecutorEvent {
  type: StageStatus;
  stageId: string;
  digest?: string;
  error?: string;
}

/** Deterministic crash-injection point (power-loss simulation). */
export interface CrashPoint {
  stageId: string;
  phase: 'before-run' | 'tmp-written' | 'after-publish';
}

export interface ExecutorHooks {
  onEvent?: (event: ExecutorEvent) => void;
  crashAt?: CrashPoint;
  /**
   * Invoked when the crash point hits. Defaults to process.exit(1) — a hard,
   * cleanup-free stop. Tests may inject a throwing substitute to simulate
   * power loss in-process; such crashes are never converted into stage
   * failures, they propagate out of run() untouched.
   */
  crash?: () => never;
}

export interface RunReport {
  ok: boolean;
  stages: Record<string, StageStatus>;
  digests: Record<string, string>;
}

export interface ExecutorOptions {
  cacheDir: string;
  hooks?: ExecutorHooks;
}

/**
 * Runs a stage DAG in topological order. Each stage's result is cached under
 * a digest of its full input set (stage id + input-file contents + dependency
 * outputs). On a re-run:
 *  - stages whose digest still has a valid cache record are reused;
 *  - failed stages and their descendants re-execute (they have no record);
 *  - file edits change the digest, invalidating exactly the affected subtree.
 */
export class Executor {
  private readonly byId: Map<string, StageDef>;
  private readonly order: string[];
  private readonly store: CacheStore;
  private readonly hooks: ExecutorHooks;

  constructor(stages: StageDef[], options: ExecutorOptions) {
    this.byId = validateStages(stages);
    this.order = topoSort(stages);
    this.store = new CacheStore(options.cacheDir);
    this.hooks = options.hooks ?? {};
  }

  private emit(event: ExecutorEvent): void {
    this.hooks.onEvent?.(event);
  }

  private maybeCrash(stageId: string, phase: CrashPoint['phase']): void {
    const at = this.hooks.crashAt;
    if (at && at.stageId === stageId && at.phase === phase) {
      (this.hooks.crash ?? (() => process.exit(1)))();
    }
  }

  async run(): Promise<RunReport> {
    this.store.sweep();
    const outputs = new Map<string, unknown>();
    const poisoned = new Set<string>(); // failed or downstream of a failure
    const stages: Record<string, StageStatus> = {};
    const digests: Record<string, string> = {};

    for (const id of this.order) {
      const stage = this.byId.get(id)!;
      const deps = stage.deps ?? [];

      if (deps.some((dep) => poisoned.has(dep))) {
        stages[id] = 'skipped';
        poisoned.add(id);
        this.emit({ type: 'skipped', stageId: id });
        continue;
      }

      const inputPaths = stage.inputs ?? [];
      const fileHash = hashInputFiles(inputPaths);
      const depOutputs: Record<string, unknown> = {};
      for (const dep of deps) depOutputs[dep] = outputs.get(dep);
      const digest = stageDigest(id, fileHash, depOutputs);
      digests[id] = digest;

      const hit = this.store.lookup(id, digest);
      if (hit) {
        outputs.set(id, hit.value);
        stages[id] = 'reused';
        this.emit({ type: 'reused', stageId: id, digest });
        continue;
      }

      this.maybeCrash(id, 'before-run');

      // Only stage.run() itself may turn into a stage failure. Crashes and
      // cache-publish errors propagate: they are infrastructural, and a
      // simulated power loss must bypass all cleanup/failure handling.
      let value: unknown;
      try {
        const inputs: Record<string, string | null> = {};
        for (const path of inputPaths) {
          inputs[path] = existsSync(path) ? readFileSync(path, 'utf8') : null;
        }
        value = (await stage.run({ inputs, deps: depOutputs })) ?? null;
      } catch (err) {
        stages[id] = 'failed';
        poisoned.add(id);
        this.emit({
          type: 'failed',
          stageId: id,
          digest,
          error: err instanceof Error ? err.message : String(err),
        });
        continue;
      }

      const record = makeRecord(id, digest, value);
      this.store.publish(record, {
        afterTmpWrite: () => this.maybeCrash(id, 'tmp-written'),
      });
      this.maybeCrash(id, 'after-publish');
      outputs.set(id, record.value);
      stages[id] = 'executed';
      this.emit({ type: 'executed', stageId: id, digest });
    }

    return { ok: poisoned.size === 0, stages, digests };
  }
}
