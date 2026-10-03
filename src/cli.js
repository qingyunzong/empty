"use strict";

const fs = require("node:fs");
const { SnapError, CrashError, EXIT_CODES } = require("./errors");
const { writeJsonAtomic } = require("./fsutil");
const { buildSnapshot, loadSnapshot, snapshotPath } = require("./snapshot");
const { diffSnapshots } = require("./diff");
const { minExplain } = require("./minexplain");
const {
  readJournal,
  lastCommittedSeq,
  writeIndex,
  assertConsistent,
  patchRun,
  recheck,
  recheckPair,
} = require("./journal");

const USAGE = [
  "snapdiff - normalized snapshots and minimal difference explanations",
  "",
  "usage:",
  "  snapdiff snap <runDir>                 build/refresh the normalized snapshot",
  "  snapdiff diff <a> <b>                  symmetric diff of two runs (params + relations)",
  "  snapdiff minexplain <a> <b>            minimal param-change sets explaining the diff",
  "  snapdiff patch <runDir> <change.json>  apply a param change (journaled, crash-safe)",
  "  snapdiff recheck <runDir> [other]      replay journal, repair snapshot, recompute diff",
  "",
  "exit codes: 0 ok/equal, 1 differences, 10 E_NO_KEY, 11 E_TOL, 12 E_AMBIG_MIN, 13 E_SNAP",
  "",
].join("\n");

// Load a run's snapshot, building it on first use; refuse inconsistent state.
function ensureSnapshot(runDir) {
  if (!fs.existsSync(snapshotPath(runDir))) {
    const snap = buildSnapshot(runDir);
    writeJsonAtomic(snapshotPath(runDir), snap);
    writeIndex(runDir, snap, lastCommittedSeq(readJournal(runDir)));
    return snap;
  }
  const snap = loadSnapshot(runDir);
  assertConsistent(runDir, snap);
  return snap;
}

function cmdSnap([runDir]) {
  if (!runDir) throw new SnapError("E_SNAP", "usage: snapdiff snap <runDir>");
  const snap = buildSnapshot(runDir);
  writeJsonAtomic(snapshotPath(runDir), snap);
  writeIndex(runDir, snap, lastCommittedSeq(readJournal(runDir)));
  const tables = {};
  for (const [name, t] of Object.entries(snap.tables)) {
    tables[name] = { rows: Object.keys(t.rows).length, hash: t.hash };
  }
  return { out: { runDir, paramsHash: snap.paramsHash, tables }, code: 0 };
}

function cmdDiff([a, b]) {
  if (!a || !b) throw new SnapError("E_SNAP", "usage: snapdiff diff <a> <b>");
  const diff = diffSnapshots(ensureSnapshot(a), ensureSnapshot(b));
  return { out: { a, b, ...diff }, code: diff.status === "different" ? 1 : 0 };
}

function cmdMinexplain([a, b]) {
  if (!a || !b) throw new SnapError("E_SNAP", "usage: snapdiff minexplain <a> <b>");
  const snapA = ensureSnapshot(a);
  const snapB = ensureSnapshot(b);
  const diff = diffSnapshots(snapA, snapB);
  const result = minExplain(diff, snapA, snapB);
  const ambiguous = result.explanations.length > 1;
  return {
    out: { a, b, ...result },
    code: ambiguous ? EXIT_CODES.E_AMBIG_MIN : 0,
    warn: ambiguous ? "E_AMBIG_MIN: multiple minimal explanation sets; all are listed" : null,
  };
}

function cmdPatch([runDir, changeFile]) {
  if (!runDir || !changeFile) throw new SnapError("E_SNAP", "usage: snapdiff patch <runDir> <change.json>");
  let change;
  try {
    change = JSON.parse(fs.readFileSync(changeFile, "utf8"));
  } catch (err) {
    throw new SnapError("E_SNAP", `cannot read change file ${changeFile}: ${err.message}`);
  }
  const crashBeforeIndex =
    process.env.SNAPDIFF_CRASH === "before-index"
      ? () => {
          throw new CrashError("simulated crash before index update");
        }
      : null;
  const result = patchRun(runDir, change, { crashBeforeIndex });
  return { out: { runDir, ...result }, code: 0 };
}

function cmdRecheck([a, b]) {
  if (!a) throw new SnapError("E_SNAP", "usage: snapdiff recheck <runDir> [other]");
  if (b) return { out: { a, b, ...recheckPair(a, b) }, code: 0 };
  return { out: { runDir: a, ...recheck(a) }, code: 0 };
}

function main(argv) {
  const [cmd, ...rest] = argv;
  const commands = {
    snap: cmdSnap,
    diff: cmdDiff,
    minexplain: cmdMinexplain,
    patch: cmdPatch,
    recheck: cmdRecheck,
  };
  const fn = commands[cmd];
  if (!fn) {
    process.stderr.write(USAGE);
    process.exitCode = cmd === undefined || cmd === "help" || cmd === "--help" || cmd === "-h" ? 0 : 2;
    return;
  }
  try {
    const { out, code, warn } = fn(rest);
    process.stdout.write(JSON.stringify(out, null, 2) + "\n");
    if (warn) process.stderr.write(JSON.stringify({ warning: warn }) + "\n");
    process.exitCode = code;
  } catch (err) {
    if (err instanceof SnapError) {
      process.stderr.write(
        JSON.stringify({ error: { code: err.code, message: err.message, details: err.details || null } }) + "\n"
      );
      process.exitCode = err.exitCode;
    } else if (typeof err.exitCode === "number") {
      process.stderr.write(String(err.message || err) + "\n");
      process.exitCode = err.exitCode;
    } else {
      process.stderr.write(String((err && err.stack) || err) + "\n");
      process.exitCode = 1;
    }
  }
}

module.exports = { main };
