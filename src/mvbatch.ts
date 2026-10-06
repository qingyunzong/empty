import {
  closeSync,
  fsyncSync,
  lstatSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { randomBytes } from 'node:crypto';

export interface RenamePair {
  src: string;
  dst: string;
}

export class BatchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}
/** The batch plan itself is invalid; raised before anything is touched. */
export class PlanError extends BatchError {}
/** A path is occupied by a file that is not part of this batch. */
export class ConflictError extends BatchError {}
/** A tracked file no longer has the identity (dev+ino) recorded in the journal. */
export class IdentityError extends BatchError {}

export interface JournalEntry extends RenamePair {
  tmp: string;
  dev: number;
  ino: number;
}

export interface Journal {
  version: 1;
  batchId: string;
  entries: JournalEntry[];
}

export interface EngineHooks {
  /** Called before each individual rename; step numbers are 1-based. */
  beforeRename?: (step: number, from: string, to: string) => void;
}

const JOURNAL_PREFIX = '.mvbatch-journal-';
const JOURNAL_SUFFIX = '.json';
const TMP_PREFIX = '.mvbatch-tmp-';

interface StatsLike {
  dev: number;
  ino: number;
}

function lstatOrNull(path: string): StatsLike | null {
  try {
    return lstatSync(path);
  } catch (err) {
    const code = (err as { code?: string }).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') return null;
    throw err;
  }
}

function matches(stat: StatsLike, entry: JournalEntry): boolean {
  return stat.dev === entry.dev && stat.ino === entry.ino;
}

function fsyncDir(dir: string): void {
  const fd = openSync(dir, 'r');
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

export function journalPathFor(dir: string, batchId: string): string {
  return join(dir, `${JOURNAL_PREFIX}${batchId}${JOURNAL_SUFFIX}`);
}

export function findJournals(dir: string): string[] {
  return readdirSync(dir)
    .filter((name) => name.startsWith(JOURNAL_PREFIX) && name.endsWith(JOURNAL_SUFFIX))
    .sort()
    .map((name) => join(dir, name));
}

function writeJournalAtomic(path: string, journal: Journal): void {
  const tmp = `${path}.tmp-${process.pid}`;
  const fd = openSync(tmp, 'w');
  try {
    writeFileSync(fd, JSON.stringify(journal, null, 2));
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(tmp, path);
  fsyncDir(dirname(path));
}

/**
 * Validate the whole batch before anything is renamed:
 * every source must exist (identity captured via lstat, symlinks not
 * followed), every target must be free or be another source in the batch,
 * and every rename must stay on one filesystem.
 */
function validateAndPlan(pairs: RenamePair[], batchId: string): JournalEntry[] {
  if (pairs.length === 0) throw new PlanError('empty batch: nothing to rename');
  const srcs = new Set<string>();
  const dsts = new Set<string>();
  for (const { src, dst } of pairs) {
    if (src === dst) throw new PlanError(`source and target are identical: ${src}`);
    if (srcs.has(src)) throw new PlanError(`duplicate source: ${src}`);
    if (dsts.has(dst)) throw new PlanError(`duplicate target: ${dst}`);
    srcs.add(src);
    dsts.add(dst);
  }
  const entries: JournalEntry[] = [];
  for (const [index, { src, dst }] of pairs.entries()) {
    const srcStat = lstatOrNull(src);
    if (!srcStat) throw new PlanError(`source does not exist: ${src}`);
    const srcDirStat = lstatSync(dirname(src));
    const dstDirStat = lstatOrNull(dirname(dst));
    if (!dstDirStat) throw new PlanError(`target directory does not exist: ${dirname(dst)}`);
    if (srcDirStat.dev !== dstDirStat.dev) {
      throw new PlanError(`cross-device rename is not supported: ${src} -> ${dst}`);
    }
    if (!srcs.has(dst) && lstatOrNull(dst)) {
      throw new ConflictError(`target already exists: ${dst}`);
    }
    entries.push({
      src,
      dst,
      tmp: join(dirname(src), `${TMP_PREFIX}${batchId}-${index}`),
      dev: srcStat.dev,
      ino: srcStat.ino,
    });
  }
  return entries;
}

/**
 * Locate the file belonging to an entry by identity (dev+ino). Any path
 * occupied by a foreign file, or a tracked file that has vanished, means
 * someone renamed things behind our back: stop instead of guessing.
 */
function locate(entry: JournalEntry): 'src' | 'tmp' | 'dst' {
  const tmpStat = lstatOrNull(entry.tmp);
  if (tmpStat) {
    if (matches(tmpStat, entry)) return 'tmp';
    throw new ConflictError(`staging path occupied by a foreign file: ${entry.tmp}`);
  }
  const dstStat = lstatOrNull(entry.dst);
  if (dstStat && matches(dstStat, entry)) return 'dst';
  const srcStat = lstatOrNull(entry.src);
  if (srcStat) {
    if (matches(srcStat, entry)) return 'src';
    throw new IdentityError(`source identity changed on disk: ${entry.src}`);
  }
  if (dstStat) {
    throw new ConflictError(`target occupied by a foreign file: ${entry.dst}`);
  }
  throw new IdentityError(`tracked file lost (external rename or delete): ${entry.src}`);
}

/**
 * Drive a journal to completion: stage every source to its unique temp
 * name, then commit each temp to its final target. State is re-derived
 * from the filesystem before every step, so this is safe to re-enter
 * after a crash at any point.
 */
export function runSteps(journal: Journal, hooks: EngineHooks): void {
  let step = 0;
  const doRename = (from: string, to: string): void => {
    step += 1;
    hooks.beforeRename?.(step, from, to);
    renameSync(from, to);
    fsyncDir(dirname(from));
    const toDir = dirname(to);
    if (toDir !== dirname(from)) fsyncDir(toDir);
  };

  // Staging phase: src -> tmp. Handles swaps and cycles uniformly because
  // every source is moved out of the way before any target is written.
  for (const entry of journal.entries) {
    if (locate(entry) === 'src') doRename(entry.src, entry.tmp);
  }

  // Commit phase: tmp -> dst.
  for (const entry of journal.entries) {
    const tmpStat = lstatOrNull(entry.tmp);
    if (!tmpStat) {
      const dstStat = lstatOrNull(entry.dst);
      if (dstStat && matches(dstStat, entry)) continue; // already committed
      throw new IdentityError(`staged file vanished: ${entry.tmp} (external rename detected; batch halted)`);
    }
    if (!matches(tmpStat, entry)) {
      throw new IdentityError(`staged file identity mismatch: ${entry.tmp}`);
    }
    if (lstatOrNull(entry.dst)) {
      throw new ConflictError(`target occupied by a foreign file: ${entry.dst} (external rename conflict; batch halted)`);
    }
    doRename(entry.tmp, entry.dst);
  }
}

/**
 * Validate, journal and execute a batch of renames. On any failure the
 * journal is left behind so the batch can be finished with resumeJournal.
 */
export function executeBatch(pairs: RenamePair[], dir: string, hooks: EngineHooks = {}): Journal {
  const absolute = pairs.map((p) => ({ src: resolve(dir, p.src), dst: resolve(dir, p.dst) }));
  const batchId = randomBytes(6).toString('hex');
  const entries = validateAndPlan(absolute, batchId);
  const journal: Journal = { version: 1, batchId, entries };
  const jpath = journalPathFor(dir, batchId);
  writeJournalAtomic(jpath, journal);
  runSteps(journal, hooks);
  unlinkSync(jpath);
  fsyncDir(dir);
  return journal;
}

/**
 * Finish an interrupted batch exactly as recorded in its journal, after
 * re-verifying every tracked file's identity. External renames or foreign
 * files at target paths halt the batch instead of overwriting anything.
 */
export function resumeJournal(jpath: string, hooks: EngineHooks = {}): void {
  const journal = JSON.parse(readFileSync(jpath, 'utf8')) as Journal;
  if (journal.version !== 1) throw new BatchError(`unsupported journal version: ${jpath}`);
  runSteps(journal, hooks);
  unlinkSync(jpath);
  fsyncDir(dirname(jpath));
}
