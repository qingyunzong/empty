"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const node_test_1 = require("node:test");
const strict_1 = __importDefault(require("node:assert/strict"));
const sequence_library_1 = require("../src/sequence-library");
const brute_force_1 = require("../src/brute-force");
function mulberry32(seed) {
    let a = seed >>> 0;
    return () => {
        a |= 0;
        a = (a + 0x6d2b79f5) | 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}
(0, node_test_1.test)("append and undo maintain sequence state", () => {
    const lib = new sequence_library_1.SequenceLibrary();
    strict_1.default.equal(lib.size, 0);
    strict_1.default.throws(() => lib.undo(), RangeError);
    lib.append(3);
    lib.append(1);
    lib.append(4);
    strict_1.default.deepEqual(lib.snapshot(), [3, 1, 4]);
    strict_1.default.equal(lib.undo(), 4);
    strict_1.default.deepEqual(lib.snapshot(), [3, 1]);
    lib.append(2);
    strict_1.default.deepEqual(lib.snapshot(), [3, 1, 2]);
    strict_1.default.equal(lib.undo(), 2);
    strict_1.default.equal(lib.undo(), 1);
    strict_1.default.equal(lib.undo(), 3);
    strict_1.default.equal(lib.size, 0);
});
(0, node_test_1.test)("tie-breaking uses index order, never value order", () => {
    // LIS length 2: candidates indices [0,2] (values 1,2) and [1,2] (values 0,2).
    // Value-lexicographic would pick (0,2) -> indices [1,2]; index order must pick [0,2].
    strict_1.default.deepEqual((0, sequence_library_1.computeLisCertificate)([1, 0, 2]).indices, [0, 2]);
    strict_1.default.deepEqual((0, sequence_library_1.computeLisCertificate)([2, 1, 3]).indices, [0, 2]);
    // Equal values: strictly increasing forbids taking both; smallest index wins.
    strict_1.default.deepEqual((0, sequence_library_1.computeLisCertificate)([1, 1]).indices, [0]);
    strict_1.default.deepEqual((0, sequence_library_1.computeLisCertificate)([2, 2, 1, 1, 3]).indices, [0, 4]);
    // Longer crafted case: value-min LIS is (0,2,3) at [2,3,4]; index-min is [0,3,4].
    const cert = (0, sequence_library_1.computeLisCertificate)([1, 5, 0, 2, 3]);
    strict_1.default.equal(cert.length, 3);
    strict_1.default.deepEqual(cert.indices, [0, 3, 4]);
    strict_1.default.deepEqual(cert.values, [1, 2, 3]);
});
(0, node_test_1.test)("certificate verification accepts valid and rejects tampered certificates", () => {
    const seq = [5, 1, 3, 2, 4];
    const cert = (0, sequence_library_1.computeLisCertificate)(seq);
    strict_1.default.ok((0, sequence_library_1.verifyCertificate)(seq, cert));
    strict_1.default.ok((0, sequence_library_1.verifyCertificate)(seq, { ...cert })); // structural copy still valid
    strict_1.default.ok(!(0, sequence_library_1.verifyCertificate)(seq, { ...cert, length: cert.length + 1 }));
    strict_1.default.ok(!(0, sequence_library_1.verifyCertificate)(seq, { ...cert, indices: [...cert.indices].reverse() }));
    const badIdx = [...cert.indices];
    badIdx[badIdx.length - 1] = seq.length; // out of range
    strict_1.default.ok(!(0, sequence_library_1.verifyCertificate)(seq, { ...cert, indices: badIdx }));
    const badVals = [...cert.values];
    badVals[badVals.length - 1] = badVals[badVals.length - 2]; // not strictly increasing
    strict_1.default.ok(!(0, sequence_library_1.verifyCertificate)(seq, { ...cert, values: badVals }));
    // Empty sequence certificate.
    strict_1.default.ok((0, sequence_library_1.verifyCertificate)([], { length: 0, indices: [], values: [] }));
    strict_1.default.ok(!(0, sequence_library_1.verifyCertificate)([], { length: 1, indices: [0], values: [0] }));
});
(0, node_test_1.test)("exhaustive small sequences match brute-force enumeration", () => {
    let checked = 0;
    let tieCases = 0;
    for (const alphabet of [2, 3, 4]) {
        const maxLen = alphabet === 4 ? 6 : 8;
        for (let n = 0; n <= maxLen; n++) {
            const total = alphabet ** n;
            for (let code = 0; code < total; code++) {
                const seq = [];
                for (let x = code, i = 0; i < n; i++, x = Math.floor(x / alphabet)) {
                    seq.push(x % alphabet);
                }
                const cert = (0, sequence_library_1.computeLisCertificate)(seq);
                const brute = (0, brute_force_1.bruteForceLis)(seq);
                strict_1.default.equal(cert.length, brute.length, `length mismatch for ${seq}`);
                strict_1.default.deepEqual([...cert.indices], [...brute.indices], `index selection mismatch for ${seq}`);
                strict_1.default.ok((0, sequence_library_1.verifyCertificate)(seq, cert), `certificate invalid for ${seq}`);
                if (brute.optimalCount > 1)
                    tieCases++;
                checked++;
            }
        }
    }
    strict_1.default.ok(checked > 10000, `expected >10000 exhaustive cases, got ${checked}`);
    strict_1.default.ok(tieCases > 1000, `expected many tie cases, got ${tieCases}`);
    console.log(`  exhaustive cross-check: ${checked} sequences, ${tieCases} with multiple optima`);
});
(0, node_test_1.test)("random small sequences match brute force (length and unique selection)", () => {
    const rand = mulberry32(20261005);
    let tieCases = 0;
    for (let t = 0; t < 500; t++) {
        const n = Math.floor(rand() * 13); // 0..12
        const seq = Array.from({ length: n }, () => Math.floor(rand() * 10));
        const cert = (0, sequence_library_1.computeLisCertificate)(seq);
        const brute = (0, brute_force_1.bruteForceLis)(seq);
        strict_1.default.equal(cert.length, brute.length, `length mismatch for ${seq}`);
        strict_1.default.deepEqual([...cert.indices], [...brute.indices], `selection mismatch for ${seq}`);
        strict_1.default.ok((0, sequence_library_1.verifyCertificate)(seq, cert));
        if (brute.optimalCount > 1)
            tieCases++;
    }
    strict_1.default.ok(tieCases > 100, `expected ties to be exercised, got ${tieCases}`);
    console.log(`  random cross-check: 500 sequences, ${tieCases} with multiple optima`);
});
(0, node_test_1.test)("undo restores previous LIS certificates exactly", () => {
    const rand = mulberry32(42);
    const lib = new sequence_library_1.SequenceLibrary();
    const history = [];
    for (let i = 0; i < 60; i++) {
        lib.append(Math.floor(rand() * 20));
        history.push(JSON.stringify(lib.lisCertificate().indices));
    }
    for (let i = history.length - 2; i >= 0; i--) {
        lib.undo();
        strict_1.default.equal(JSON.stringify(lib.lisCertificate().indices), history[i]);
        strict_1.default.ok(lib.verify());
    }
    lib.undo();
    strict_1.default.equal(lib.size, 0);
    strict_1.default.deepEqual(lib.lisCertificate(), { length: 0, indices: [], values: [] });
});
(0, node_test_1.test)("larger sequence: certificate valid and length matches independent oracle", () => {
    const rand = mulberry32(7);
    const seq = Array.from({ length: 2000 }, () => Math.floor(rand() * 1000));
    const cert = (0, sequence_library_1.computeLisCertificate)(seq);
    strict_1.default.ok((0, sequence_library_1.verifyCertificate)(seq, cert));
    strict_1.default.equal(cert.length, (0, sequence_library_1.lisLength)(seq));
    console.log(`  n=2000: LIS length ${cert.length}, certificate verified`);
});
