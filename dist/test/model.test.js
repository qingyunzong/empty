import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Cluster } from '../src/cluster.js';
import { VersionVector } from '../src/version-vector.js';
import { mergeSiblings } from '../src/siblings.js';
/** Deterministic PRNG (mulberry32) so failures are reproducible. */
function rng(seed) {
    let s = seed >>> 0;
    return () => {
        s = (s + 0x6d2b79f5) >>> 0;
        let t = s;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}
function randomPartition(rand, ids) {
    const groups = new Map();
    for (const id of ids) {
        const g = Math.floor(rand() * 3); // up to 3 partition groups
        if (!groups.has(g))
            groups.set(g, []);
        groups.get(g).push(id);
    }
    return [...groups.values()];
}
test('random partitions + set-merge model: retracted versions never resurrect', () => {
    const IDS = ['A', 'B', 'C', 'D', 'E'];
    const KEY = 'stock';
    const SEEDS = [1, 7, 42, 1337, 20261006];
    for (const seed of SEEDS) {
        const rand = rng(seed);
        const cluster = new Cluster(IDS);
        const allWrites = [];
        // Per-replica history of every version vector it has ever held.
        // No-resurrection is a per-replica monotonicity property: once a
        // replica has held a dominator of v, v must never reappear there.
        const everHeld = new Map(IDS.map((id) => [id, []]));
        let writeCount = 0;
        for (let step = 0; step < 120; step++) {
            // Randomly re-partition the network.
            cluster.partition(randomPartition(rand, IDS));
            // Random write: context comes from a real read when possible,
            // sometimes a stale/empty context to force concurrency.
            const writer = IDS[Math.floor(rand() * IDS.length)];
            let context = VersionVector.zero();
            if (rand() < 0.7) {
                try {
                    context = cluster.read(writer, KEY).context;
                }
                catch {
                    // quorum unavailable under this partition; write with stale context
                }
            }
            writeCount++;
            allWrites.push(cluster.write(writer, KEY, `w${writeCount}`, context));
            // Random anti-entropy within current partition groups.
            if (rand() < 0.6)
                cluster.syncRound();
            // Random coordinated read (triggers read repair) when quorum exists.
            if (rand() < 0.5) {
                const coordinator = IDS[Math.floor(rand() * IDS.length)];
                try {
                    cluster.read(coordinator, KEY);
                }
                catch {
                    // no quorum reachable: allowed, reads require >= 2 replicas
                }
            }
            // Invariants after every step.
            for (const replica of cluster.replicas) {
                const local = replica.readLocal(KEY);
                const history = everHeld.get(replica.id);
                for (const sibling of local) {
                    // No-resurrection: nothing the replica once saw may dominate a
                    // version it holds now.
                    for (const past of history) {
                        assert.notEqual(past.compare(sibling.vv), 'dominates', `seed ${seed} step ${step}: retracted version ${sibling.vv} resurrected on ${replica.id} (dominated by previously held ${past})`);
                    }
                }
                // Conflict sets must stay minimal: pairwise concurrent.
                for (let i = 0; i < local.length; i++) {
                    for (let j = i + 1; j < local.length; j++) {
                        assert.equal(local[i].vv.compare(local[j].vv), 'concurrent', `seed ${seed} step ${step}: non-minimal conflict set on ${replica.id}`);
                    }
                }
                for (const sibling of local)
                    history.push(sibling.vv);
            }
        }
        // After healing, every replica must converge to exactly the model set:
        // the union of all writes with dominated versions retracted.
        cluster.heal();
        cluster.syncToFixpoint();
        const model = mergeSiblings(allWrites);
        const expected = model.map((s) => s.vv.toString()).sort();
        for (const replica of cluster.replicas) {
            assert.deepEqual(replica.readLocal(KEY).map((s) => s.vv.toString()).sort(), expected, `seed ${seed}: replica ${replica.id} did not converge to model`);
        }
        assert.ok(model.length >= 1, `seed ${seed}: model should retain live versions`);
    }
});
test('retraction is stable under arbitrary merge order (permutation check)', () => {
    // Build a causal chain w1 -> w2 -> w3 plus one concurrent branch w2'.
    const w1 = { value: 'w1', vv: VersionVector.zero().increment('A') };
    const w2 = { value: 'w2', vv: w1.vv.increment('B') };
    const w3 = { value: 'w3', vv: w2.vv.increment('C') };
    const w2p = { value: "w2'", vv: w1.vv.increment('D') };
    const all = [w1, w2, w3, w2p];
    // Expected: w1, w2 retracted (dominated by w3); w3 and w2' concurrent.
    const expected = mergeSiblings(all).map((s) => s.value).sort();
    assert.deepEqual(expected, ['w2\'', 'w3']);
    // Every permutation of delivery order yields the same final set.
    const permute = (arr) => arr.length <= 1
        ? [arr]
        : arr.flatMap((x, i) => permute([...arr.slice(0, i), ...arr.slice(i + 1)]).map((rest) => [x, ...rest]));
    for (const order of permute(all)) {
        // Simulate incremental merges in this delivery order.
        let current = [];
        for (const item of order)
            current = mergeSiblings([...current, item]);
        assert.deepEqual(current.map((s) => s.value).sort(), expected, `order ${order.map((s) => s.value).join(',')} diverged`);
    }
});
