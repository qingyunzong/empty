import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { CacheStore, PowerFailure, atomicWriteFileSync } from "./cache.js";
import { canonicalize, sha256 } from "./digest.js";
import { Executor, ImmediateExecutor } from "./executor.js";

export interface StageContext {
  id: string;
  /** Outputs of direct dependencies, keyed by stage id. */
  inputs: Record<string, unknown>;
  workdir: string;
}

export interface Stage {
  id: string;
  /** Ids of stages that must complete (or be cache-reused) before this one. */
  deps?: string[];
  /** Input files (relative to workdir) whose contents feed the cache digest. */
  files?: string[];
  /** Bump to invalidate this stage's cache without touching inputs. */
  version?: string;
  run: (ctx: StageContext) => unknown | Promise<unknown>;
}

export type StageStatus = "cached" | "ran" | "failed" | "skipped";

export interface StageResult {
  id: string;
  status: StageStatus;
  digest: string | null;
  outputHash: string | null;
  output?: unknown;
  error?: string;
}

export interface RunReport {
  ok: boolean;
  results: Record<string, StageResult>;
  /** Stage completion order (cache hits included). */
  order: string[];
}

export interface OrchestrateOptions {
  workdir: string;
  cacheDir: string;
  executor?: Executor;
  store?: CacheStore;
  /** If set, the run report is published atomically to this path. */
  reportPath?: string;
}

interface Outcome {
  ok: boolean;
  outputHash: string | null;
  output: unknown;
}

function hashFile(path: string): string {
  if (!existsSync(path)) return sha256(`MISSING:${path}`);
  return sha256(readFileSync(path));
}

function validate(stages: Stage[]): Map<string, Stage> {
  const nodes = new Map<string, Stage>();
  for (const stage of stages) {
    if (nodes.has(stage.id)) throw new Error(`duplicate stage id: ${stage.id}`);
    nodes.set(stage.id, stage);
  }
  for (const stage of stages) {
    for (const dep of stage.deps ?? []) {
      if (!nodes.has(dep)) throw new Error(`stage ${stage.id} depends on unknown stage ${dep}`);
    }
  }
  const state = new Map<string, "visiting" | "done">();
  const visit = (id: string, trail: string[]): void => {
    const mark = state.get(id);
    if (mark === "done") return;
    if (mark === "visiting") throw new Error(`dependency cycle: ${[...trail, id].join(" -> ")}`);
    state.set(id, "visiting");
    for (const dep of nodes.get(id)?.deps ?? []) visit(dep, [...trail, id]);
    state.set(id, "done");
  };
  for (const stage of stages) visit(stage.id, []);
  return nodes;
}

/**
 * Run a stage DAG with digest-keyed caching.
 *
 * A stage's digest covers its id, version, declared input-file contents and
 * the *output hashes* of its dependencies. Therefore:
 *  - an unchanged successful stage is reused from cache;
 *  - a changed input file invalidates exactly that stage and, transitively
 *    (via changed dependency outputs), its successors;
 *  - a failed stage is never cached; on the next run only it and its
 *    successors re-execute, while unaffected branches stay cached.
 */
export async function orchestrate(stages: Stage[], opts: OrchestrateOptions): Promise<RunReport> {
  const executor = opts.executor ?? new ImmediateExecutor();
  const store = opts.store ?? new CacheStore(opts.cacheDir);
  store.cleanOrphans();
  validate(stages);

  const results = new Map<string, StageResult>();
  const order: string[] = [];
  const outcomes = new Map<string, Promise<Outcome>>();

  const runNode = (stage: Stage): Promise<Outcome> => {
    return (async (): Promise<Outcome> => {
      const deps = stage.deps ?? [];
      const depOutcomes = await Promise.all(deps.map((dep) => outcomes.get(dep) as Promise<Outcome>));
      if (depOutcomes.some((outcome) => !outcome.ok)) {
        results.set(stage.id, { id: stage.id, status: "skipped", digest: null, outputHash: null });
        return { ok: false, outputHash: null, output: undefined };
      }

      const files = (stage.files ?? []).map((path) => ({ path, hash: hashFile(join(opts.workdir, path)) }));
      const depInputs = deps.map((dep, index) => ({ id: dep, outputHash: depOutcomes[index]?.outputHash ?? null }));
      const digest = sha256(
        canonicalize({ stage: stage.id, version: stage.version ?? "", files, deps: depInputs }),
      );

      const cached = store.read(stage.id);
      if (cached && cached.digest === digest) {
        results.set(stage.id, {
          id: stage.id,
          status: "cached",
          digest,
          outputHash: cached.outputHash,
          output: cached.output,
        });
        order.push(stage.id);
        return { ok: true, outputHash: cached.outputHash, output: cached.output };
      }

      const inputs: Record<string, unknown> = {};
      deps.forEach((dep, index) => {
        inputs[dep] = depOutcomes[index]?.output;
      });
      try {
        const raw = await executor.submit(stage.id, () =>
          stage.run({ id: stage.id, inputs, workdir: opts.workdir }),
        );
        const output = raw === undefined ? null : raw;
        const outputHash = sha256(canonicalize(output));
        store.write({ stage: stage.id, digest, outputHash, output });
        results.set(stage.id, { id: stage.id, status: "ran", digest, outputHash, output });
        order.push(stage.id);
        return { ok: true, outputHash, output };
      } catch (err) {
        if (err instanceof PowerFailure) throw err; // simulated crash: nothing was committed
        results.set(stage.id, {
          id: stage.id,
          status: "failed",
          digest,
          outputHash: null,
          error: err instanceof Error ? err.message : String(err),
        });
        return { ok: false, outputHash: null, output: undefined };
      }
    })();
  };

  for (const stage of stages) outcomes.set(stage.id, runNode(stage));
  await Promise.all(outcomes.values());

  const report: RunReport = {
    ok: [...results.values()].every((r) => r.status === "cached" || r.status === "ran"),
    results: Object.fromEntries(results),
    order,
  };
  if (opts.reportPath) {
    atomicWriteFileSync(opts.reportPath, JSON.stringify(report, null, 2));
  }
  return report;
}
