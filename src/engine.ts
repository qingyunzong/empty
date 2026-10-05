import { WeightedDag } from "./dag.js";
import { WeightedRank, type ScoreEntry } from "./rank.js";

export interface EngineSnapshot {
  generation: number;
  sources: Record<string, number>;
  outputs: Record<string, number>;
}

export interface EngineView {
  generation: number;
  weights: Map<string, number>;
  scores: ScoreEntry[];
}

/**
 * Combines a weight-deriving DAG with the ranking index.
 *
 * Every source change is applied as one atomic recompute: the DAG is
 * evaluated once, all derived weights and all percentile scores are swapped
 * in together, and the generation is bumped exactly once. Readers only ever
 * see a complete generation, never a mix of old and new state.
 */
export class RankEngine {
  private readonly dag: WeightedDag;
  private readonly rank = new WeightedRank();
  private sources: Record<string, number>;
  private outputs: Record<string, number>;
  private generation = 0;
  private weights = new Map<string, number>();

  constructor(
    dag: WeightedDag,
    outputs: Record<string, number>,
    sources: Record<string, number>,
  ) {
    this.dag = dag;
    this.outputs = { ...outputs };
    this.sources = { ...sources };
    this.recompute();
  }

  get gen(): number {
    return this.generation;
  }

  private recompute(): void {
    const names = Object.keys(this.outputs);
    const { weights } = this.dag.evaluate(this.sources, names);
    const entries: Array<[string, { value: number; weight: number }]> = [];
    for (const name of names) {
      const weight = weights.get(name);
      if (weight === undefined) {
        throw new Error(`output node was not evaluated: ${name}`);
      }
      entries.push([name, { value: this.outputs[name] as number, weight }]);
    }
    this.weights = weights;
    this.rank.replaceAll(entries);
    this.generation += 1;
  }

  /** Applies a source patch and atomically republishes weights + scores. */
  setSources(patch: Record<string, number>): number {
    for (const [name, value] of Object.entries(patch)) {
      if (!this.dag.has(name)) {
        throw new Error(`unknown source node: ${name}`);
      }
      if (!Number.isFinite(value)) {
        throw new RangeError(`source value must be finite: ${name}`);
      }
    }
    Object.assign(this.sources, patch);
    this.recompute();
    return this.generation;
  }

  /** A consistent single-generation view of weights and scores. */
  read(): EngineView {
    return {
      generation: this.generation,
      weights: new Map(this.weights),
      scores: this.rank.scores(),
    };
  }

  snapshot(): EngineSnapshot {
    return {
      generation: this.generation,
      sources: { ...this.sources },
      outputs: { ...this.outputs },
    };
  }

  /** Restores the exact state captured in a snapshot. */
  restore(snapshot: EngineSnapshot): void {
    this.sources = { ...snapshot.sources };
    this.outputs = { ...snapshot.outputs };
    this.recompute();
    this.generation = snapshot.generation;
  }
}
