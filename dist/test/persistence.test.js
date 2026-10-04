"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const node_test_1 = __importDefault(require("node:test"));
const strict_1 = __importDefault(require("node:assert/strict"));
const node_fs_1 = require("node:fs");
const node_os_1 = require("node:os");
const node_path_1 = require("node:path");
const persistence_1 = require("../src/persistence");
const model_1 = require("../src/model");
const helpers_1 = require("./helpers");
function freshDir() {
    return (0, node_fs_1.mkdtempSync)((0, node_path_1.join)((0, node_os_1.tmpdir)(), "ranklib-"));
}
function itemsOf(state) {
    const weights = new Map(state.weights);
    return state.observations.map(([id, o]) => ({
        id,
        value: o.value,
        weight: weights.get(o.weightNode),
    }));
}
(0, node_test_1.default)("recovery after failure restores the same snapshot", () => {
    const dir = freshDir();
    const store = new persistence_1.SnapshotStore(dir);
    const original = (0, helpers_1.buildLibrary)();
    original.commit([]);
    original.commit([["base", 9], ["bonus", 3], ["mode", 0]]);
    const before = original.getSnapshot();
    store.save(original.exportState());
    // simulate failure: the original instance is abandoned entirely
    const loaded = store.load();
    strict_1.default.ok(loaded !== null);
    const recovered = (0, helpers_1.buildLibrary)();
    const restored = recovered.restoreState(loaded);
    strict_1.default.equal(restored.generation, before.generation);
    strict_1.default.deepEqual(restored.sources, before.sources);
    strict_1.default.deepEqual(restored.weights, before.weights);
    strict_1.default.deepEqual(restored.scores, before.scores);
    // full DAG evaluation cross-check on the recovered sources
    strict_1.default.deepEqual(recovered.evaluateWeightsWithModel(), restored.weights);
    // sorting model cross-check on the recovered observations
    (0, helpers_1.assertScoresClose)(restored.scores, (0, model_1.sortingPercentiles)(itemsOf(loaded)));
    (0, helpers_1.assertScoresClose)(restored.scores, (0, model_1.naivePercentiles)(itemsOf(loaded)));
    // the recovered library keeps accepting commits from the same generation
    const next = recovered.commit([["base", 1]]);
    strict_1.default.equal(next.generation, before.generation + 1);
});
(0, node_test_1.default)("a torn temporary file from a crashed write is ignored", () => {
    const dir = freshDir();
    const store = new persistence_1.SnapshotStore(dir);
    const lib = (0, helpers_1.buildLibrary)();
    lib.commit([]);
    store.save(lib.exportState());
    // simulate a crash in the middle of the next save
    (0, node_fs_1.writeFileSync)((0, node_path_1.join)(dir, "snapshot.json.tmp"), '{"payload":"{ truncated');
    const loaded = store.load();
    strict_1.default.ok(loaded !== null);
    strict_1.default.equal(loaded.generation, 1);
});
(0, node_test_1.default)("corrupted committed snapshot is detected via checksum", () => {
    const dir = freshDir();
    const store = new persistence_1.SnapshotStore(dir);
    const lib = (0, helpers_1.buildLibrary)();
    lib.commit([]);
    store.save(lib.exportState());
    const file = (0, node_path_1.join)(dir, "snapshot.json");
    const envelope = JSON.parse((0, node_fs_1.readFileSync)(file, "utf8"));
    envelope.payload = envelope.payload.replace(/"generation":\d+/, '"generation":999');
    (0, node_fs_1.writeFileSync)(file, JSON.stringify(envelope));
    strict_1.default.throws(() => store.load(), persistence_1.CorruptSnapshotError);
});
(0, node_test_1.default)("loading from an empty directory returns null", () => {
    const store = new persistence_1.SnapshotStore(freshDir());
    strict_1.default.equal(store.load(), null);
});
