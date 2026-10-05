import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { Document } from "../src/document.js";
import { BlockedReferenceError, UnknownObjectError } from "../src/errors.js";
import { ReplicaStore } from "../src/store.js";
describe("活文档引用墓碑对象报阻塞", () => {
    it("引用存活对象正常", () => {
        const store = new ReplicaStore("r1");
        store.put("obj-1", "v");
        const doc = new Document("doc-1", store);
        assert.doesNotThrow(() => doc.attach("obj-1"));
        assert.deepEqual([...doc.references()], ["obj-1"]);
    });
    it("引用墓碑对象抛 BlockedReferenceError", () => {
        const store = new ReplicaStore("r1");
        store.put("obj-1", "v");
        store.delete("obj-1");
        const doc = new Document("doc-1", store);
        assert.throws(() => doc.attach("obj-1"), (err) => err instanceof BlockedReferenceError &&
            err.documentId === "doc-1" &&
            err.objectId === "obj-1");
        assert.equal(doc.references().has("obj-1"), false);
    });
    it("引用未知对象抛 UnknownObjectError", () => {
        const store = new ReplicaStore("r1");
        const doc = new Document("doc-1", store);
        assert.throws(() => doc.attach("nope"), UnknownObjectError);
    });
    it("快照冻结历史引用，释放后不再作为历史根", () => {
        const store = new ReplicaStore("r1");
        store.put("obj-1", "v");
        const doc = new Document("doc-1", store);
        doc.attach("obj-1");
        doc.snapshot("snap-1");
        doc.detach("obj-1");
        const snapshotRefs = [...doc.snapshotReferences()];
        assert.equal(snapshotRefs.length, 1);
        assert.ok(snapshotRefs[0].has("obj-1"));
        assert.equal(doc.releaseSnapshot("snap-1"), true);
        assert.equal([...doc.snapshotReferences()].length, 0);
    });
});
