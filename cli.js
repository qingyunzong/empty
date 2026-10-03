#!/usr/bin/env node
import fs from "node:fs";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import {
  ReplicaError,
  deleteRecord,
  diffSnapshot,
  emptyState,
  mergeSnapshot,
  resolveRecord,
  snapshot,
  upsert,
  verifySnapshot,
} from "./src/replica.js";

function loadState(path, replicaName) {
  if (fs.existsSync(path)) {
    return JSON.parse(fs.readFileSync(path, "utf8"));
  }
  return emptyState(replicaName ?? "default");
}

function saveState(path, state) {
  fs.writeFileSync(path, JSON.stringify(state, null, 2) + "\n");
}

function readSnapshotFile(path) {
  if (!path) {
    throw new ReplicaError("invalid-input");
  }
  let raw;
  try {
    raw = fs.readFileSync(path, "utf8");
  } catch {
    throw new ReplicaError("io-error");
  }
  try {
    return JSON.parse(raw);
  } catch {
    throw new ReplicaError("invalid-snapshot");
  }
}

export function run(argv, write = (s) => process.stdout.write(s)) {
  const out = (value) => write(JSON.stringify(value) + "\n");
  const fail = (code) => {
    out({ error: code });
    return 1;
  };

  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      options: {
        state: { type: "string", default: "replica-state.json" },
        replica: { type: "string" },
      },
      allowPositionals: true,
    });
  } catch {
    return fail("invalid-input");
  }
  const { values, positionals } = parsed;
  const [command, ...args] = positionals;

  let state;
  try {
    state = loadState(values.state, values.replica);
  } catch {
    return fail("io-error");
  }

  try {
    switch (command) {
      case "upsert": {
        let input;
        try {
          input = JSON.parse(args[0] ?? "");
        } catch {
          return fail("invalid-input");
        }
        const record = upsert(state, input);
        saveState(values.state, state);
        out(record);
        return 0;
      }
      case "resolve": {
        if (!args[0]) return fail("invalid-input");
        const record = resolveRecord(state, args[0]);
        saveState(values.state, state);
        out(record);
        return 0;
      }
      case "delete": {
        if (!args[0]) return fail("invalid-input");
        const tombstone = deleteRecord(state, args[0]);
        saveState(values.state, state);
        out(tombstone);
        return 0;
      }
      case "diff": {
        const snap = readSnapshotFile(args[0]);
        out(diffSnapshot(state, snap));
        return 0;
      }
      case "merge": {
        const snap = readSnapshotFile(args[0]);
        const result = mergeSnapshot(state, snap);
        saveState(values.state, state);
        out(result);
        return 0;
      }
      case "snapshot": {
        const snap = snapshot(state);
        if (args[0]) {
          fs.writeFileSync(args[0], JSON.stringify(snap, null, 2) + "\n");
          out({ file: args[0], epoch: snap.epoch, digest: snap.digest, valid: snap.certificate.valid });
        } else {
          out(snap);
        }
        return 0;
      }
      case "verify": {
        const snap = readSnapshotFile(args[0]);
        out(verifySnapshot(snap));
        return 0;
      }
      default:
        return fail("unknown-command");
    }
  } catch (err) {
    if (err instanceof ReplicaError) {
      return fail(err.code);
    }
    throw err;
  }
}

function isEntrypoint() {
  try {
    return process.argv[1] && import.meta.url === pathToFileURL(fs.realpathSync(process.argv[1])).href;
  } catch {
    return false;
  }
}

if (isEntrypoint()) {
  const code = run(process.argv.slice(2));
  if (code !== 0) {
    process.exit(code);
  }
}
