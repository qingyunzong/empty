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
Object.defineProperty(exports, "__esModule", { value: true });
exports.runProperty = runProperty;
exports.failureFilePath = failureFilePath;
exports.saveFailureRecord = saveFailureRecord;
exports.loadFailureRecord = loadFailureRecord;
exports.assertProperty = assertProperty;
const fs = __importStar(require("node:fs"));
const rng_1 = require("./rng");
const shrink_1 = require("./shrink");
/** Wrap a check so thrown exceptions also count as failures. */
function toFails(check) {
    return (value) => {
        try {
            return !check(value);
        }
        catch {
            return true;
        }
    };
}
/**
 * Run a property. The random stream for run i is derived solely from
 * hashSeed(seed, name) and i, so the outcome is identical no matter
 * which other properties run before/after or concurrently.
 */
function runProperty(name, gen, check, config) {
    const propertySeed = (0, rng_1.hashSeed)(config.seed, name);
    const fails = toFails(check);
    for (let run = 0; run < config.runs; run++) {
        const runSeed = (0, rng_1.mixSeed)(propertySeed, run);
        const size = config.size ? config.size(run) : run;
        const rng = new rng_1.Rng(runSeed);
        const tree = gen(rng, size);
        if (!fails(tree.value))
            continue;
        const result = (0, shrink_1.shrink)(tree, fails);
        const record = {
            property: name,
            masterSeed: config.seed,
            propertySeed,
            runIndex: run,
            runSeed,
            size,
            counterexample: result.minimal,
            shrinkPath: result.acceptedPath,
            shrinkTrace: result.trace,
        };
        if (config.failureDir !== undefined) {
            saveFailureRecord(config.failureDir, record);
        }
        return { ok: false, runs: run + 1, record };
    }
    return { ok: true, runs: config.runs };
}
function failureFilePath(dir, name) {
    const safe = name.replace(/[^a-zA-Z0-9_.-]+/g, "_");
    return `${dir}/${safe}.json`;
}
function saveFailureRecord(dir, record) {
    fs.mkdirSync(dir, { recursive: true });
    const path = failureFilePath(dir, record.property);
    fs.writeFileSync(path, JSON.stringify(record, null, 2));
    return path;
}
function loadFailureRecord(path) {
    return JSON.parse(fs.readFileSync(path, "utf8"));
}
/**
 * Test-runner friendly wrapper: returns nothing on success, throws an
 * Error with the full failure summary (and persists the record) on
 * failure.
 */
function assertProperty(name, gen, check, config) {
    const result = runProperty(name, gen, check, config);
    if (!result.ok && result.record) {
        const r = result.record;
        throw new Error([
            `Property "${name}" falsified after ${result.runs} run(s).`,
            `  counterexample: ${JSON.stringify(r.counterexample)}`,
            `  seed: ${r.masterSeed}, run: ${r.runIndex}, runSeed: ${r.runSeed}, size: ${r.size}`,
            `  shrink steps: ${r.shrinkTrace.length} (${r.shrinkPath.length} accepted)`,
            config.failureDir !== undefined
                ? `  record: ${failureFilePath(config.failureDir, name)}`
                : "  (persistence disabled)",
        ].join("\n"));
    }
}
