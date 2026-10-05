import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { ReplicaStore } from "../src/store.js";
describe("ReplicaStore 墓碑删除", () => {
    it("删除对象留下墓碑，对象值被移除", () => {
        const store = new ReplicaStore("r1");
        store.put("obj-1", { text: "hello" });
        const tombstone = store.delete("obj-1");
        assert.equal(store.get("obj-1"), undefined);
        assert.equal(store.isTombstoned("obj-1"), true);
        assert.deepEqual(store.tombstoneOf("obj-1"), tombstone);
    });
    it("删除不存在的对象同样留下墓碑（防乱序迟到 put）", () => {
        const store = new ReplicaStore("r1");
        store.delete("ghost");
        assert.equal(store.isTombstoned("ghost"), true);
    });
    it("重复删除幂等，保留较新版本", () => {
        const store = new ReplicaStore("r1");
        store.put("obj-1", 1);
        const first = store.delete("obj-1");
        const second = store.delete("obj-1");
        assert.ok(second.version.time > first.version.time);
        assert.deepEqual(store.tombstoneOf("obj-1"), second);
    });
});
