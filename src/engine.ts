/**
 * RankedLibrary ties the pieces together:
 *   sources --(DAG)--> observation weights --(WeightedRankIndex)--> scores
 *
 * A single commit() applies one batch of source changes, derives all
 * weights, rebuilds every percentile score, and publishes the result as one
 * immutable snapshot with a fresh generation number. Readers only ever see
 * a fully built snapshot via getSnapshot(), so a mixed-generation read
 * (weights from generation N with scores from generation N+1) is impossible.
 */

import { DagEngine, NodeSpec, evaluateDagModel } from "./dag";
import { WeightedRankIndex } from "./rankIndex";

export interface ObservationDef {
  value: number;
  weightNode: string;
}

export interface Snapshot {
  readonly generation: number;
  readonly sources: ReadonlyMap<string, number>;
  readonly observations: ReadonlyMap<string, ObservationDef>;
  readonly weights: ReadonlyMap<string, number>;
  readonly scores: ReadonlyMap<string, number>;
}

export interface PersistedState {
  generation: number;
  sources: Array<[string, number]>;
  observations: Array<[string, ObservationDef]>;
  weights: Array<[string, number]>;
}

export class RankedLibrary {
  private readonly dag = new DagEngine();
  private readonly observations = new Map<string, ObservationDef>();
  private generation = 0;
  private current: Snapshot = RankedLibrary.freeze(0, new Map(), new Map(), new Map());

  addSource(name: string, initial: number): void {
    this.dag.addSource(name, initial);
  }

  addNode(name: string, spec: Exclude<NodeSpec, { kind: "source" }>): void {
    this.dag.addNode(name, spec);
  }

  addObservation(id: string, value: number, weightNode: string): void {
    if (!this.dag.hasNode(weightNode)) throw new Error(`unknown weight node: ${weightNode}`);
    if (this.observations.has(id)) throw new Error(`duplicate observation: ${id}`);
    this.observations.set(id, { value, weightNode });
  }

  removeObservation(id: string): boolean {
    return this.observations.delete(id);
  }

  /** The current immutable snapshot; never a partially committed state. */
  getSnapshot(): Snapshot {
    return this.current;
  }

  /**
   * Apply one batch of source changes and atomically publish a new
   * generation with updated weights and all percentile scores.
   */
  commit(changes: Iterable<readonly [string, number]>): Snapshot {
    this.dag.applySourceChanges(changes);
    const weights = this.dag.evaluateOutputs(this.weightNodes());
    this.generation += 1;
    this.current = RankedLibrary.freeze(
      this.generation,
      this.dag.getSources(),
      new Map(this.observations),
      weights
    );
    return this.current;
  }

  /**
   * Reference cross-check: full DAG evaluation from scratch over the current
   * sources, bypassing the incremental engine's caches entirely.
   */
  evaluateWeightsWithModel(): Map<string, number> {
    return evaluateDagModel(this.dag.getSpecs(), this.dag.getSources(), this.weightNodes());
  }

  /** Serializable state for SnapshotStore. */
  exportState(): PersistedState {
    const snap = this.current;
    return {
      generation: snap.generation,
      sources: [...snap.sources.entries()],
      observations: [...snap.observations.entries()].map(([id, o]) => [id, { ...o }]),
      weights: [...snap.weights.entries()],
    };
  }

  /**
   * Restore a previously exported state into this library. The DAG topology
   * (nodes and their compute functions) must already be registered; restore
   * replays sources and observations and republishes the exact persisted
   * snapshot: same generation, same weights, same scores.
   */
  restoreState(state: PersistedState): Snapshot {
    for (const [name, value] of state.sources) {
      if (this.dag.hasNode(name)) this.dag.applySourceChanges([[name, value]]);
      else this.dag.addSource(name, value);
    }
    this.observations.clear();
    for (const [id, obs] of state.observations) this.observations.set(id, { ...obs });
    this.generation = state.generation;
    this.current = RankedLibrary.freeze(
      state.generation,
      new Map(state.sources),
      new Map(state.observations),
      new Map(state.weights)
    );
    return this.current;
  }

  private weightNodes(): string[] {
    return [...this.observations.values()].map((o) => o.weightNode);
  }

  private static freeze(
    generation: number,
    sources: ReadonlyMap<string, number>,
    observations: ReadonlyMap<string, ObservationDef>,
    weights: ReadonlyMap<string, number>
  ): Snapshot {
    const index = new WeightedRankIndex();
    for (const [id, obs] of observations) {
      const weight = weights.get(obs.weightNode);
      if (weight === undefined) throw new Error(`missing weight for node: ${obs.weightNode}`);
      index.set(id, obs.value, weight);
    }
    return Object.freeze({
      generation,
      sources,
      observations,
      weights,
      scores: index.scores(),
    });
  }
}
