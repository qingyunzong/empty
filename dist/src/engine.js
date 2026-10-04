"use strict";
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
Object.defineProperty(exports, "__esModule", { value: true });
exports.RankedLibrary = void 0;
const dag_1 = require("./dag");
const rankIndex_1 = require("./rankIndex");
class RankedLibrary {
    dag = new dag_1.DagEngine();
    observations = new Map();
    generation = 0;
    current = RankedLibrary.freeze(0, new Map(), new Map(), new Map());
    addSource(name, initial) {
        this.dag.addSource(name, initial);
    }
    addNode(name, spec) {
        this.dag.addNode(name, spec);
    }
    addObservation(id, value, weightNode) {
        if (!this.dag.hasNode(weightNode))
            throw new Error(`unknown weight node: ${weightNode}`);
        if (this.observations.has(id))
            throw new Error(`duplicate observation: ${id}`);
        this.observations.set(id, { value, weightNode });
    }
    removeObservation(id) {
        return this.observations.delete(id);
    }
    /** The current immutable snapshot; never a partially committed state. */
    getSnapshot() {
        return this.current;
    }
    /**
     * Apply one batch of source changes and atomically publish a new
     * generation with updated weights and all percentile scores.
     */
    commit(changes) {
        this.dag.applySourceChanges(changes);
        const weights = this.dag.evaluateOutputs(this.weightNodes());
        this.generation += 1;
        this.current = RankedLibrary.freeze(this.generation, this.dag.getSources(), new Map(this.observations), weights);
        return this.current;
    }
    /**
     * Reference cross-check: full DAG evaluation from scratch over the current
     * sources, bypassing the incremental engine's caches entirely.
     */
    evaluateWeightsWithModel() {
        return (0, dag_1.evaluateDagModel)(this.dag.getSpecs(), this.dag.getSources(), this.weightNodes());
    }
    /** Serializable state for SnapshotStore. */
    exportState() {
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
    restoreState(state) {
        for (const [name, value] of state.sources) {
            if (this.dag.hasNode(name))
                this.dag.applySourceChanges([[name, value]]);
            else
                this.dag.addSource(name, value);
        }
        this.observations.clear();
        for (const [id, obs] of state.observations)
            this.observations.set(id, { ...obs });
        this.generation = state.generation;
        this.current = RankedLibrary.freeze(state.generation, new Map(state.sources), new Map(state.observations), new Map(state.weights));
        return this.current;
    }
    weightNodes() {
        return [...this.observations.values()].map((o) => o.weightNode);
    }
    static freeze(generation, sources, observations, weights) {
        const index = new rankIndex_1.WeightedRankIndex();
        for (const [id, obs] of observations) {
            const weight = weights.get(obs.weightNode);
            if (weight === undefined)
                throw new Error(`missing weight for node: ${obs.weightNode}`);
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
exports.RankedLibrary = RankedLibrary;
