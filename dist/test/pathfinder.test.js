import { test, describe } from "node:test";
import { deepEqual, equal, match, ok } from "node:assert/strict";
import { findPath } from "../src/pathfinder.js";
import { parseGraph } from "../src/model.js";
import { makeGraph } from "./helpers.js";
const U = ["serverAuth", "clientAuth"];
describe("findPath", () => {
    test("finds a simple valid chain", () => {
        const g = makeGraph([
            ["leaf", ["ca"], ["serverAuth"]],
            ["ca", ["root"], ["serverAuth"]],
            ["root", [], ["serverAuth"]],
        ], { leaf: true, ca: true, root: true }, ["root"]);
        deepEqual(findPath(g, { leafId: "leaf", usage: "serverAuth" }), {
            ok: true,
            path: ["leaf", "ca", "root"],
        });
    });
    test("accepts a self-contained trusted leaf as a 1-certificate path", () => {
        const g = makeGraph([["leaf", [], ["serverAuth"]]], { leaf: true }, ["leaf"]);
        deepEqual(findPath(g, { leafId: "leaf", usage: "serverAuth" }), {
            ok: true,
            path: ["leaf"],
        });
    });
    test("prefers the shortest chain among several trusted roots", () => {
        const g = makeGraph([
            ["leaf", ["ca-short", "ca-long"], U],
            ["ca-short", ["root-near"], U],
            ["ca-long", ["mid"], U],
            ["mid", ["root-far"], U],
            ["root-near", [], U],
            ["root-far", [], U],
        ], { leaf: true, "ca-short": true, "ca-long": true, mid: true, "root-near": true, "root-far": true }, ["root-near", "root-far"]);
        deepEqual(findPath(g, { leafId: "leaf", usage: "serverAuth" }), {
            ok: true,
            path: ["leaf", "ca-short", "root-near"],
        });
    });
    test("breaks length ties by certificate id order", () => {
        const g = makeGraph([
            ["leaf", ["ca-b", "ca-a"], U],
            ["ca-a", ["root-z"], U],
            ["ca-b", ["root-a"], U],
            ["root-a", [], U],
            ["root-z", [], U],
        ], { leaf: true, "ca-a": true, "ca-b": true, "root-a": true, "root-z": true }, ["root-a", "root-z"]);
        // Both chains have length 3; ["leaf","ca-a","root-z"] wins on id order.
        deepEqual(findPath(g, { leafId: "leaf", usage: "serverAuth" }), {
            ok: true,
            path: ["leaf", "ca-a", "root-z"],
        });
    });
    test("skips a shorter invalid chain in favour of a longer valid one", () => {
        const g = makeGraph([
            ["leaf", ["ca-bad", "ca-good"], U],
            ["ca-bad", ["root"], U],
            ["ca-good", ["mid"], U],
            ["mid", ["root"], U],
            ["root", [], U],
        ], { leaf: true, "ca-bad": false, "ca-good": true, mid: true, root: true }, ["root"]);
        deepEqual(findPath(g, { leafId: "leaf", usage: "serverAuth" }), {
            ok: true,
            path: ["leaf", "ca-good", "mid", "root"],
        });
    });
    test("accepts a chain of exactly 12 certificates", () => {
        const ids = Array.from({ length: 12 }, (_, i) => `c${String(i).padStart(2, "0")}`);
        const certs = ids.map((id, i) => [
            id,
            i + 1 < ids.length ? [ids[i + 1]] : [],
            U,
        ]);
        const validity = Object.fromEntries(ids.map((id) => [id, true]));
        const g = makeGraph(certs, validity, [ids[11]]);
        deepEqual(findPath(g, { leafId: "c00", usage: "serverAuth" }), { ok: true, path: ids });
    });
    test("rejects a chain of 13 certificates with PATH_TOO_LONG", () => {
        const ids = Array.from({ length: 13 }, (_, i) => `c${String(i).padStart(2, "0")}`);
        const certs = ids.map((id, i) => [
            id,
            i + 1 < ids.length ? [ids[i + 1]] : [],
            U,
        ]);
        const validity = Object.fromEntries(ids.map((id) => [id, true]));
        const g = makeGraph(certs, validity, [ids[12]]);
        const r = findPath(g, { leafId: "c00", usage: "serverAuth" });
        ok(!r.ok);
        equal(r.failure.code, "PATH_TOO_LONG");
        match(r.failure.message, /13 certificates/);
    });
    test("honours a custom max length below 12", () => {
        const g = makeGraph([
            ["leaf", ["ca"], U],
            ["ca", ["root"], U],
            ["root", [], U],
        ], { leaf: true, ca: true, root: true }, ["root"]);
        const r = findPath(g, { leafId: "leaf", usage: "serverAuth", maxLength: 2 });
        ok(!r.ok);
        equal(r.failure.code, "PATH_TOO_LONG");
    });
    test("reports LEAF_NOT_FOUND for an unknown leaf", () => {
        const g = makeGraph([["root", [], U]], { root: true }, ["root"]);
        const r = findPath(g, { leafId: "ghost", usage: "serverAuth" });
        ok(!r.ok);
        equal(r.failure.code, "LEAF_NOT_FOUND");
    });
    test("reports LEAF_INVALID when the leaf fails explicit verification", () => {
        const g = makeGraph([
            ["leaf", ["root"], U],
            ["root", [], U],
        ], { leaf: false, root: true }, ["root"]);
        const r = findPath(g, { leafId: "leaf", usage: "serverAuth" });
        ok(!r.ok);
        equal(r.failure.code, "LEAF_INVALID");
    });
    test("reports LEAF_USAGE_MISMATCH when the leaf lacks the usage", () => {
        const g = makeGraph([
            ["leaf", ["root"], ["clientAuth"]],
            ["root", [], U],
        ], { leaf: true, root: true }, ["root"]);
        const r = findPath(g, { leafId: "leaf", usage: "serverAuth" });
        ok(!r.ok);
        equal(r.failure.code, "LEAF_USAGE_MISMATCH");
    });
    test("reports CERT_INVALID naming the broken intermediate certificate", () => {
        const g = makeGraph([
            ["leaf", ["ca"], U],
            ["ca", ["root"], U],
            ["root", [], U],
        ], { leaf: true, ca: false, root: true }, ["root"]);
        const r = findPath(g, { leafId: "leaf", usage: "serverAuth" });
        ok(!r.ok);
        equal(r.failure.code, "CERT_INVALID");
        equal(r.failure.certId, "ca");
    });
    test("reports USAGE_MISMATCH naming the certificate missing the usage", () => {
        const g = makeGraph([
            ["leaf", ["ca"], U],
            ["ca", ["root"], ["codeSigning"]],
            ["root", [], U],
        ], { leaf: true, ca: true, root: true }, ["root"]);
        const r = findPath(g, { leafId: "leaf", usage: "serverAuth" });
        ok(!r.ok);
        equal(r.failure.code, "USAGE_MISMATCH");
        equal(r.failure.certId, "ca");
    });
    test("reports NO_TRUSTED_ROOT_REACHABLE when the chain ends untrusted", () => {
        const g = makeGraph([
            ["leaf", ["ca"], U],
            ["ca", [], U],
            ["other-root", [], U],
        ], { leaf: true, ca: true, "other-root": true }, ["other-root"]);
        const r = findPath(g, { leafId: "leaf", usage: "serverAuth" });
        ok(!r.ok);
        equal(r.failure.code, "NO_TRUSTED_ROOT_REACHABLE");
    });
    test("issuer cycles do not hang and yield NO_TRUSTED_ROOT_REACHABLE", () => {
        const g = makeGraph([
            ["leaf", ["a"], U],
            ["a", ["b"], U],
            ["b", ["a"], U],
            ["root", [], U],
        ], { leaf: true, a: true, b: true, root: true }, ["root"]);
        const r = findPath(g, { leafId: "leaf", usage: "serverAuth" });
        ok(!r.ok);
        equal(r.failure.code, "NO_TRUSTED_ROOT_REACHABLE");
    });
});
describe("parseGraph input validation", () => {
    const base = {
        certificates: [
            { id: "leaf", issuers: ["root"], usages: ["serverAuth"] },
            { id: "root", issuers: [], usages: ["serverAuth"] },
        ],
        validity: { leaf: true, root: true },
        trustedRoots: ["root"],
    };
    function expectError(doc, pattern) {
        let message = "";
        try {
            parseGraph(doc);
        }
        catch (e) {
            message = e.message;
        }
        match(message, pattern);
    }
    test("accepts a well-formed document", () => {
        const g = parseGraph(base);
        equal(g.nodes.size, 2);
        ok(g.trustedRoots.has("root"));
    });
    test("rejects duplicate certificate ids", () => {
        expectError({ ...base, certificates: [...base.certificates, { id: "leaf", issuers: [], usages: [] }] }, /duplicate certificate id/);
    });
    test("rejects an unknown issuer reference", () => {
        expectError({
            ...base,
            certificates: [{ id: "leaf", issuers: ["nope"], usages: [] }],
            validity: { leaf: true },
            trustedRoots: [],
        }, /unknown issuer "nope"/);
    });
    test("rejects a missing explicit verification result", () => {
        expectError({ ...base, validity: { leaf: true } }, /missing explicit verification result for certificate "root"/);
    });
    test("rejects a trusted root that is not a known certificate", () => {
        expectError({ ...base, trustedRoots: ["elsewhere"] }, /trusted root "elsewhere" is not a known certificate/);
    });
});
