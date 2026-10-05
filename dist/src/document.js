import { BlockedReferenceError, UnknownObjectError } from "./errors.js";
/**
 * 文档：活版本持有一组对象引用；快照是历史根，GC 必须尊重。
 * 活文档引用墓碑对象时立即抛 BlockedReferenceError（报阻塞）。
 */
export class Document {
    id;
    store;
    refs = new Set();
    snapshots = new Map();
    constructor(id, store) {
        this.id = id;
        this.store = store;
    }
    attach(objectId) {
        if (this.store.isTombstoned(objectId)) {
            throw new BlockedReferenceError(this.id, objectId);
        }
        if (!this.store.isKnown(objectId)) {
            throw new UnknownObjectError(objectId);
        }
        this.refs.add(objectId);
    }
    detach(objectId) {
        this.refs.delete(objectId);
    }
    references() {
        return this.refs;
    }
    snapshot(name) {
        this.snapshots.set(name, new Set(this.refs));
    }
    releaseSnapshot(name) {
        return this.snapshots.delete(name);
    }
    snapshotNames() {
        return [...this.snapshots.keys()];
    }
    snapshotReferences() {
        return this.snapshots.values();
    }
}
