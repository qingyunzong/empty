"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.hashSourceFiles = hashSourceFiles;
exports.listFilesRecursive = listFilesRecursive;
exports.readSourceTree = readSourceTree;
exports.hashSourceTree = hashSourceTree;
exports.verifySourceTree = verifySourceTree;
const node_crypto_1 = require("node:crypto");
const node_fs_1 = require("node:fs");
const node_path_1 = require("node:path");
/**
 * Compute a deterministic content hash over a set of named files.
 * The hash binds BOTH the file paths and the exact file contents:
 * any change to any file (or the file set) yields a different hash.
 */
function hashSourceFiles(files) {
    const entries = files instanceof Map ? [...files.entries()] : Object.entries(files);
    entries.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    const h = (0, node_crypto_1.createHash)("sha256");
    for (const [path, content] of entries) {
        h.update(path, "utf8");
        h.update("\0");
        h.update(content, "utf8");
        h.update("\0");
    }
    return h.digest("hex");
}
/** Recursively list files under dir (relative posix-style paths, sorted). */
function listFilesRecursive(dir) {
    const out = [];
    const walk = (cur) => {
        for (const name of (0, node_fs_1.readdirSync)(cur)) {
            const full = (0, node_path_1.join)(cur, name);
            const st = (0, node_fs_1.statSync)(full);
            if (st.isDirectory())
                walk(full);
            else if (st.isFile())
                out.push((0, node_path_1.relative)(dir, full).split(node_path_1.sep).join("/"));
        }
    };
    walk(dir);
    out.sort();
    return out;
}
/** Read a directory tree into a path->content map. */
function readSourceTree(dir) {
    const map = new Map();
    for (const rel of listFilesRecursive(dir)) {
        map.set(rel, (0, node_fs_1.readFileSync)((0, node_path_1.join)(dir, rel), "utf8"));
    }
    return map;
}
/** Hash the current on-disk source tree. */
function hashSourceTree(dir) {
    return hashSourceFiles(readSourceTree(dir));
}
/**
 * Verify that the on-disk tree still matches an expected hash.
 * Returns the actual hash and, on mismatch, the list of changed paths
 * (added / removed / modified) relative to the recorded snapshot, when
 * the snapshot contents are provided.
 */
function verifySourceTree(dir, expectedHash, snapshot) {
    const current = readSourceTree(dir);
    const actualHash = hashSourceFiles(current);
    const changedPaths = [];
    if (snapshot) {
        const paths = new Set([...current.keys(), ...snapshot.keys()]);
        for (const p of [...paths].sort()) {
            if (!current.has(p) || !snapshot.has(p) || current.get(p) !== snapshot.get(p)) {
                changedPaths.push(p);
            }
        }
    }
    return { ok: actualHash === expectedHash, actualHash, changedPaths };
}
