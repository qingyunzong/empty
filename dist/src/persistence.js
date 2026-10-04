"use strict";
/**
 * Crash-safe snapshot persistence for the ranked library.
 *
 * save() writes the snapshot to a temporary file, fsyncs it, then atomically
 * renames it over snapshot.json. A crash can therefore leave either the old
 * or the new snapshot, never a torn one; a leftover .tmp file from a crashed
 * write is simply ignored by load(). The payload carries a SHA-256 checksum
 * so corruption of the committed file is detected instead of silently
 * restoring a different snapshot.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.SnapshotStore = exports.CorruptSnapshotError = void 0;
const node_fs_1 = require("node:fs");
const node_path_1 = require("node:path");
const node_crypto_1 = require("node:crypto");
class CorruptSnapshotError extends Error {
}
exports.CorruptSnapshotError = CorruptSnapshotError;
class SnapshotStore {
    file;
    tmpFile;
    constructor(dir) {
        (0, node_fs_1.mkdirSync)(dir, { recursive: true });
        this.file = (0, node_path_1.join)(dir, "snapshot.json");
        this.tmpFile = (0, node_path_1.join)(dir, "snapshot.json.tmp");
    }
    save(data) {
        const payload = JSON.stringify(data);
        const envelope = JSON.stringify({ payload, checksum: sha256(payload) });
        (0, node_fs_1.writeFileSync)(this.tmpFile, envelope);
        const fd = (0, node_fs_1.openSync)(this.tmpFile, "r");
        try {
            (0, node_fs_1.fsyncSync)(fd);
        }
        finally {
            (0, node_fs_1.closeSync)(fd);
        }
        (0, node_fs_1.renameSync)(this.tmpFile, this.file);
    }
    /** Returns the last committed snapshot, or null when none exists. */
    load() {
        if (!(0, node_fs_1.existsSync)(this.file))
            return null;
        const envelope = JSON.parse((0, node_fs_1.readFileSync)(this.file, "utf8"));
        if (sha256(envelope.payload) !== envelope.checksum) {
            throw new CorruptSnapshotError(`checksum mismatch in ${this.file}`);
        }
        return JSON.parse(envelope.payload);
    }
}
exports.SnapshotStore = SnapshotStore;
function sha256(data) {
    return (0, node_crypto_1.createHash)("sha256").update(data).digest("hex");
}
