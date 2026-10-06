#!/usr/bin/env node
// mvx - crash-safe batch rename CLI.
//
// Supports swaps (a=b b=a) and cycles (a=b b=c c=a) by staging every
// source to a unique temporary name before moving anything to its final
// destination. The whole batch is validated (targets, identities, external
// conflicts) before any mutation, the intent is persisted to a journal
// (staging phase), and an interrupted batch is finished by `mvx --recover`.
// Symlinks are never followed: all inspection uses lstat and rename(2)
// operates on the link itself.

import * as fs from "node:fs";
import * as path from "node:path";
import { randomBytes } from "node:crypto";

const JOURNAL_NAME = ".mvx-journal.json";
const TMP_PREFIX = ".mvx-tmp-";

const EXIT_OK = 0;
const EXIT_USAGE = 1; // validation / usage errors, nothing was modified
const EXIT_CONFLICT = 2; // stopped mid-batch: external interference
const EXIT_CRASH = 75; // simulated power loss (fault injection)

interface FileId {
  dev: number;
  ino: number;
}

interface Pair {
  src: string;
  dst: string;
  srcId: FileId; // identity captured during validation
}

interface Journal {
  version: 1;
  batchId: string;
  pairs: Pair[];
  tmps: string[]; // staging name per pair, same directory as the source
  done: boolean[]; // 2 * pairs.length steps: n x toTmp, then n x toFinal
}

// --- fault injection -------------------------------------------------------
// MVX_FAIL_AT=k  : crash (exit 75) right after the k-th data rename, before
//                  the journal update, simulating power loss.
// MVX_FAIL_STAGING=1 : crash right after the journal is staged, before any
//                  rename.
let renameCount = 0;
const failAt = process.env.MVX_FAIL_AT ? parseInt(process.env.MVX_FAIL_AT, 10) : -1;

function dataRename(oldPath: string, newPath: string): void {
  fs.renameSync(oldPath, newPath);
  renameCount += 1;
  if (renameCount === failAt) {
    fs.writeSync(2, `mvx: simulated crash after rename #${renameCount}\n`);
    process.exit(EXIT_CRASH);
  }
}

// --- helpers ---------------------------------------------------------------

function fail(code: number, msg: string): never {
  // Synchronous write: process.exit must not drop the message.
  fs.writeSync(2, `mvx: ${msg}\n`);
  process.exit(code);
}

function info(msg: string): void {
  fs.writeSync(1, `mvx: ${msg}\n`);
}

function lstatOrNull(p: string): fs.Stats | null {
  try {
    return fs.lstatSync(p);
  } catch {
    return null;
  }
}

function idOf(st: fs.Stats): FileId {
  return { dev: st.dev, ino: st.ino };
}

function sameId(a: FileId, b: FileId): boolean {
  return a.dev === b.dev && a.ino === b.ino;
}

function fsyncDir(dir: string): void {
  const fd = fs.openSync(dir, "r");
  try {
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

// Atomic journal write: tmp file + fsync + rename + dir fsync.
function persistJournal(journalPath: string, j: Journal): void {
  const tmp = journalPath + ".tmp";
  const fd = fs.openSync(tmp, "w");
  try {
    fs.writeSync(fd, JSON.stringify(j, null, 2) + "\n");
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmp, journalPath);
  fsyncDir(path.dirname(journalPath));
}

function removeJournal(journalPath: string): void {
  fs.unlinkSync(journalPath);
  fsyncDir(path.dirname(journalPath));
}

// --- validation phase ------------------------------------------------------
// Pure inspection: any problem here aborts before a single rename happens.
function buildJournal(dir: string, rawPairs: Array<[string, string]>): Journal {
  if (rawPairs.length === 0) {
    fail(EXIT_USAGE, "no rename pairs given (expected OLD=NEW ...)");
  }
  const resolved = rawPairs.map(([s, d]) => ({
    src: path.resolve(dir, s),
    dst: path.resolve(dir, d),
  }));

  const seenSrc = new Set<string>();
  const seenDst = new Set<string>();
  const pairs: Pair[] = [];
  for (const { src, dst } of resolved) {
    if (src === dst) {
      fail(EXIT_USAGE, `source and destination are identical: ${src}`);
    }
    if (seenSrc.has(src)) {
      fail(EXIT_USAGE, `duplicate source: ${src}`);
    }
    if (seenDst.has(dst)) {
      fail(EXIT_USAGE, `duplicate destination: ${dst}`);
    }
    seenSrc.add(src);
    seenDst.add(dst);
    const st = lstatOrNull(src); // lstat: never follow symlinks
    if (!st) {
      fail(EXIT_USAGE, `source does not exist: ${src}`);
    }
    pairs.push({ src, dst, srcId: idOf(st) });
  }

  // A destination may only already exist if it is itself a source of this
  // batch (swap / cycle). Anything else is an external conflict: stop.
  for (const { src, dst } of pairs) {
    const dstSt = lstatOrNull(dst);
    if (dstSt && !seenSrc.has(dst)) {
      fail(EXIT_USAGE, `external conflict: destination already exists: ${dst}`);
    }
    const dstParent = path.dirname(dst);
    const parentSt = lstatOrNull(dstParent);
    if (!parentSt || !parentSt.isDirectory()) {
      fail(EXIT_USAGE, `destination directory does not exist: ${dstParent}`);
    }
    const srcParentDev = fs.statSync(path.dirname(src)).dev;
    if (fs.statSync(dstParent).dev !== srcParentDev) {
      fail(EXIT_USAGE, `source and destination are on different filesystems: ${src} -> ${dst}`);
    }
  }

  const batchId = `${Date.now().toString(36)}-${process.pid}-${randomBytes(4).toString("hex")}`;
  const tmps = pairs.map(
    (p, i) => path.join(path.dirname(p.src), `${TMP_PREFIX}${batchId}-${i}`)
  );
  for (const tmp of tmps) {
    if (lstatOrNull(tmp)) {
      fail(EXIT_USAGE, `staging name unexpectedly exists: ${tmp}`);
    }
  }

  return {
    version: 1,
    batchId,
    pairs,
    tmps,
    done: new Array<boolean>(pairs.length * 2).fill(false),
  };
}

// --- execution / recovery --------------------------------------------------
// Every step is idempotent: before renaming we re-check identities so a
// crash between the rename and the journal update resumes cleanly.
function execute(journalPath: string, j: Journal): void {
  const n = j.pairs.length;
  for (let step = 0; step < 2 * n; step++) {
    if (j.done[step]) continue;
    const i = step < n ? step : step - n;
    const pair = j.pairs[i];
    const tmp = j.tmps[i];
    if (step < n) {
      // Phase 1: source -> staging name.
      const srcSt = lstatOrNull(pair.src);
      const tmpSt = lstatOrNull(tmp);
      if (srcSt && sameId(idOf(srcSt), pair.srcId)) {
        dataRename(pair.src, tmp);
      } else if (tmpSt && sameId(idOf(tmpSt), pair.srcId)) {
        // Crashed after the rename but before the journal write: done.
      } else {
        fail(
          EXIT_CONFLICT,
          `cannot resume batch ${j.batchId}: source '${pair.src}' is missing or was replaced externally`
        );
      }
    } else {
      // Phase 2: staging name -> final destination.
      const tmpSt = lstatOrNull(tmp);
      const dstSt = lstatOrNull(pair.dst);
      if (dstSt && sameId(idOf(dstSt), pair.srcId)) {
        // Crashed after the rename but before the journal write: done.
      } else {
        if (dstSt) {
          fail(
            EXIT_CONFLICT,
            `external conflict: destination '${pair.dst}' was created outside batch ${j.batchId}; stopping`
          );
        }
        if (!tmpSt || !sameId(idOf(tmpSt), pair.srcId)) {
          fail(
            EXIT_CONFLICT,
            `cannot resume batch ${j.batchId}: staging file '${tmp}' is missing or was replaced externally`
          );
        }
        dataRename(tmp, pair.dst);
      }
    }
    j.done[step] = true;
    persistJournal(journalPath, j);
  }
  removeJournal(journalPath);
}

// --- CLI -------------------------------------------------------------------

const USAGE = `usage:
  mvx [--dir DIR] OLD=NEW [OLD2=NEW2 ...]   run a batch rename
  mvx [--dir DIR] --recover                 finish an interrupted batch

Swaps (a=b b=a) and cycles (a=b b=c c=a) are supported. All targets and
file identities are validated before anything is modified; the batch is
then staged to ${JOURNAL_NAME} so a crash can be completed by --recover.
Symlinks are renamed as-is and never followed.`;

function main(argv: string[]): void {
  let dir = process.cwd();
  let recover = false;
  const pairArgs: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--dir") {
      const v = argv[++i];
      if (!v) fail(EXIT_USAGE, "--dir requires a value");
      dir = v;
    } else if (a === "--recover") {
      recover = true;
    } else if (a === "--help" || a === "-h") {
      fs.writeSync(1, USAGE + "\n");
      process.exit(EXIT_OK);
    } else {
      pairArgs.push(a);
    }
  }
  dir = path.resolve(dir);
  const journalPath = path.join(dir, JOURNAL_NAME);

  if (recover) {
    if (pairArgs.length > 0) {
      fail(EXIT_USAGE, "--recover takes no rename pairs");
    }
    if (!lstatOrNull(journalPath)) {
      fail(EXIT_USAGE, "no pending batch to recover");
    }
    let j: Journal;
    try {
      j = JSON.parse(fs.readFileSync(journalPath, "utf8")) as Journal;
    } catch {
      fail(EXIT_CONFLICT, `journal is unreadable: ${journalPath}`);
    }
    execute(journalPath, j!);
    info(`recovered batch ${j!.batchId} (${j!.pairs.length} renames)`);
    return;
  }

  if (lstatOrNull(journalPath)) {
    fail(
      EXIT_USAGE,
      `a previous batch is still pending (${journalPath}); run 'mvx --recover' to finish it`
    );
  }
  const rawPairs: Array<[string, string]> = pairArgs.map((arg) => {
    const eq = arg.indexOf("=");
    if (eq <= 0 || eq === arg.length - 1) {
      fail(EXIT_USAGE, `invalid pair (expected OLD=NEW): ${arg}`);
    }
    return [arg.slice(0, eq), arg.slice(eq + 1)];
  });

  // 1. validate everything, 2. stage the intent, 3. execute.
  const j = buildJournal(dir, rawPairs);
  persistJournal(journalPath, j);
  if (process.env.MVX_FAIL_STAGING === "1") {
    fs.writeSync(2, "mvx: simulated crash after staging\n");
    process.exit(EXIT_CRASH);
  }
  execute(journalPath, j);
  info(`renamed ${j.pairs.length} entries (batch ${j.batchId})`);
}

main(process.argv.slice(2));
