import { LamportClock, compareVersion } from "./version.js";
/**
 * 单副本对象库。删除只留墓碑，不物理移除；
 * 合并按 (lamport, origin) 全序做 last-writer-wins，
 * 过期的 put 无法覆盖较新的墓碑（不复活），
 * 已被 GC 清除的 id 保留高水位，迟到的旧操作同样无法复活对象。
 */
export class ReplicaStore {
    replicaId;
    clock;
    objects = new Map();
    tombstones = new Map();
    deleteHighWater = new Map();
    purgedHighWater = new Map();
    constructor(replicaId) {
        this.replicaId = replicaId;
        this.clock = new LamportClock(replicaId);
    }
    put(id, value) {
        const op = { kind: "put", id, value, version: this.clock.tick() };
        this.apply(op);
        return this.objects.get(id);
    }
    delete(id) {
        const op = { kind: "delete", id, version: this.clock.tick() };
        this.apply(op);
        return this.tombstones.get(id);
    }
    get(id) {
        return this.objects.get(id);
    }
    tombstoneOf(id) {
        return this.tombstones.get(id);
    }
    isTombstoned(id) {
        return this.tombstones.has(id);
    }
    isKnown(id) {
        return this.objects.has(id) || this.tombstones.has(id);
    }
    listTombstones() {
        return [...this.tombstones.values()];
    }
    exportOps() {
        const ops = [];
        for (const record of this.objects.values()) {
            ops.push({ kind: "put", id: record.id, value: record.value, version: record.version });
        }
        for (const tombstone of this.tombstones.values()) {
            ops.push({ kind: "delete", id: tombstone.id, version: tombstone.version });
        }
        return ops;
    }
    apply(op) {
        this.clock.witness(op.version);
        if (op.kind === "delete")
            this.raiseHighWater(this.deleteHighWater, op.id, op.version);
        const purged = this.purgedHighWater.get(op.id);
        if (purged && compareVersion(op.version, purged) <= 0)
            return false;
        const current = this.currentVersion(op.id);
        if (current && compareVersion(op.version, current) <= 0)
            return false;
        if (op.kind === "put") {
            this.tombstones.delete(op.id);
            this.objects.set(op.id, { id: op.id, value: op.value, version: op.version });
        }
        else {
            this.objects.delete(op.id);
            this.tombstones.set(op.id, { id: op.id, version: op.version });
        }
        return true;
    }
    merge(ops) {
        for (const op of ops)
            this.apply(op);
    }
    /** 该副本是否已确认（见到）某个墓碑版本 —— 用于 GC 的全副本确认。 */
    hasConfirmed(tombstone) {
        const seen = this.deleteHighWater.get(tombstone.id);
        return seen !== undefined && compareVersion(seen, tombstone.version) >= 0;
    }
    /** 物理移除墓碑，并记录高水位以拒绝任何迟到的旧版本操作。 */
    purgeTombstone(id) {
        const tombstone = this.tombstones.get(id);
        if (!tombstone)
            return false;
        this.tombstones.delete(id);
        this.raiseHighWater(this.purgedHighWater, id, tombstone.version);
        return true;
    }
    currentVersion(id) {
        const object = this.objects.get(id);
        const tombstone = this.tombstones.get(id);
        if (object && tombstone) {
            return compareVersion(object.version, tombstone.version) >= 0
                ? object.version
                : tombstone.version;
        }
        return object?.version ?? tombstone?.version;
    }
    raiseHighWater(map, id, version) {
        const existing = map.get(id);
        if (!existing || compareVersion(version, existing) > 0)
            map.set(id, version);
    }
}
