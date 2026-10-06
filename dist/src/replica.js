import { VersionVector } from './version-vector.js';
import { mergeSiblings, } from './siblings.js';
/**
 * One storage node. Each key maps to a minimal conflict set of sibling
 * versions: every stored version is pairwise concurrent with the others.
 */
export class Replica {
    id;
    data = new Map();
    constructor(id) {
        this.id = id;
    }
    /**
     * Local write. `context` is the causal context the client observed on its
     * last read; the new version supersedes exactly those versions, while
     * versions the client never saw stay concurrent and are preserved.
     */
    write(key, value, context = VersionVector.zero(), evidence) {
        const item = {
            value,
            vv: context.increment(this.id),
        };
        this.data.set(key, mergeSiblings([...this.readLocal(key), item], evidence));
        return item;
    }
    readLocal(key) {
        return [...(this.data.get(key) ?? [])];
    }
    /** Anti-entropy / read-repair entry point: set-merge a remote conflict set in. */
    accept(key, siblings, evidence) {
        const merged = mergeSiblings([...this.readLocal(key), ...siblings], evidence);
        if (merged.length === 0)
            this.data.delete(key);
        else
            this.data.set(key, merged);
    }
    keys() {
        return [...this.data.keys()];
    }
}
