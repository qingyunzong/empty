"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const node_test_1 = __importDefault(require("node:test"));
const assert = __importStar(require("node:assert/strict"));
const fs = __importStar(require("node:fs"));
const os = __importStar(require("node:os"));
const path = __importStar(require("node:path"));
const property_1 = require("../src/property");
const replay_1 = require("../src/replay");
const gen_1 = require("../src/gen");
function tmpDir() {
    const dir = path.join(os.tmpdir(), `pbt-test-${process.pid}-${Math.floor(Math.random() * 1e9)}`);
    fs.mkdirSync(dir, { recursive: true });
    return dir;
}
(0, node_test_1.default)("failure persists generation parameters and shrink trace to disk", () => {
    const dir = tmpDir();
    try {
        const check = (n) => n < 10;
        const result = (0, property_1.runProperty)("persist/int", (0, gen_1.integer)(0, 100), check, {
            seed: 777,
            runs: 100,
            failureDir: dir,
        });
        assert.equal(result.ok, false);
        const file = (0, property_1.failureFilePath)(dir, "persist/int");
        assert.ok(fs.existsSync(file), "failure record file must exist");
        const record = (0, property_1.loadFailureRecord)(file);
        assert.equal(record.property, "persist/int");
        assert.equal(record.masterSeed, 777);
        assert.ok(Number.isInteger(record.runSeed), "integer rng state saved");
        assert.ok(Number.isInteger(record.runIndex));
        assert.ok(Array.isArray(record.shrinkTrace));
        assert.ok(record.shrinkTrace.length > 0, "shrink trace saved");
        assert.equal(record.counterexample, 10);
    }
    finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});
(0, node_test_1.default)("replay regenerates the final counterexample and confirms it still fails", () => {
    const dir = tmpDir();
    try {
        const check = (xs) => !xs.some((x) => x >= 8);
        const gen = (0, gen_1.arrayOf)((0, gen_1.integer)(0, 50), { maxLength: 6 });
        const result = (0, property_1.runProperty)("replay/array", gen, check, {
            seed: 31337,
            runs: 300,
            failureDir: dir,
        });
        assert.equal(result.ok, false);
        const record = result.record;
        const replayed = (0, replay_1.replayFailure)(record, gen, check);
        assert.ok(replayed.reproduced, "final counterexample must still fail");
        assert.ok(replayed.matchesRecord, "regenerated value must match the record");
        assert.deepEqual(replayed.counterexample, [8]);
    }
    finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});
(0, node_test_1.default)("replay against a fixed (correct) implementation does not reproduce", () => {
    const dir = tmpDir();
    try {
        const buggy = (n) => n < 20;
        const gen = (0, gen_1.integer)(0, 100);
        const result = (0, property_1.runProperty)("replay/fixed", gen, buggy, {
            seed: 55,
            runs: 100,
            failureDir: dir,
        });
        assert.equal(result.ok, false);
        const correct = (n) => n <= 100; // every generated value passes
        const replayed = (0, replay_1.replayFailure)(result.record, gen, correct);
        assert.equal(replayed.reproduced, false);
        assert.ok(replayed.matchesRecord);
    }
    finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});
(0, node_test_1.default)("replaying a record loaded from disk equals replaying the in-memory record", () => {
    const dir = tmpDir();
    try {
        const check = (n) => n % 2 === 1 || n < 4;
        const gen = (0, gen_1.integer)(0, 30);
        const result = (0, property_1.runProperty)("replay/disk", gen, check, {
            seed: 8,
            runs: 100,
            failureDir: dir,
        });
        const fromDisk = (0, property_1.loadFailureRecord)((0, property_1.failureFilePath)(dir, "replay/disk"));
        const a = (0, replay_1.replayFailure)(result.record, gen, check);
        const b = (0, replay_1.replayFailure)(fromDisk, gen, check);
        assert.deepEqual(a, b);
        assert.ok(a.reproduced);
    }
    finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});
