import { makeRecord, type ModuleRecord } from "./compiler.js";
import { analyzeSccs, moduleArtifact, type SccInfo } from "./scc.js";

export interface CompileEvent {
  sccId: string;
  members: string[];
}

/**
 * Incremental compile cache.
 *
 * Each module is summarized twice: an implementation summary (hash of the
 * whole source) and a public interface summary (hash of exported
 * declarations). A batch (SCC) is recompiled only when its own
 * implementation inputs changed or when the *interface* summary of a
 * dependency changed — implementation-only edits never propagate.
 */
export class IncrementalEngine {
  protected records = new Map<string, ModuleRecord>();
  private published = new Map<string, SccInfo>();
  private artifacts = new Map<string, string>();
  readonly compileLog: CompileEvent[] = [];

  setModule(name: string, source: string): void {
    this.records.set(name, makeRecord(name, source));
  }

  removeModule(name: string): void {
    this.records.delete(name);
  }

  /** SCCs whose current input fingerprint differs from the published one. */
  protected planDirty(): SccInfo[] {
    const infos = analyzeSccs(this.records);
    return infos.filter((info) => this.published.get(info.id)?.fingerprint !== info.fingerprint);
  }

  protected commit(info: SccInfo): void {
    this.published.set(info.id, info);
    this.compileLog.push({ sccId: info.id, members: [...info.members] });
  }

  protected refreshArtifacts(): void {
    const infos = analyzeSccs(this.records);
    const liveIds = new Set(infos.map((info) => info.id));
    for (const id of [...this.published.keys()]) {
      if (!liveIds.has(id)) this.published.delete(id);
    }
    this.artifacts.clear();
    for (const info of infos) {
      const published = this.published.get(info.id)!;
      for (const member of info.members) {
        this.artifacts.set(member, moduleArtifact(published.artifactHash, member));
      }
    }
  }

  /** Synchronously recompile everything that is dirty. Returns the batches compiled. */
  update(): CompileEvent[] {
    const before = this.compileLog.length;
    for (const info of this.planDirty()) this.commit(info);
    this.refreshArtifacts();
    return this.compileLog.slice(before);
  }

  artifactOf(name: string): string | undefined {
    return this.artifacts.get(name);
  }

  artifactSnapshot(): Map<string, string> {
    return new Map(this.artifacts);
  }
}

interface CompileTask {
  info: SccInfo;
  /** Input fingerprint captured when the task was scheduled. */
  baseline: string;
}

/**
 * Asynchronous variant: edits may land while compile tasks are still queued.
 * Every task carries the baseline (input fingerprint) it was scheduled
 * against; on completion the baseline is re-checked against the current
 * state. A stale task is discarded and rescheduled — its result is never
 * committed.
 */
export class AsyncEngine extends IncrementalEngine {
  private queue: CompileTask[] = [];
  readonly staleTasks: CompileTask[] = [];

  get pendingCount(): number {
    return this.queue.length;
  }

  /** Enqueue compile tasks for all currently dirty batches. Returns tasks added. */
  schedule(): number {
    const queued = new Set(this.queue.map((task) => task.info.id));
    let added = 0;
    for (const info of this.planDirty()) {
      if (queued.has(info.id)) continue;
      this.queue.push({ info, baseline: info.fingerprint });
      added += 1;
    }
    return added;
  }

  /** Complete the oldest queued task, verifying its baseline first. */
  completeNext(): boolean {
    const task = this.queue.shift();
    if (!task) return false;
    const current = analyzeSccs(this.records).find((info) => info.id === task.info.id);
    if (!current || current.fingerprint !== task.baseline) {
      // Stale task: the world moved on since it was scheduled. Discard and,
      // if the batch still exists and is still dirty, reschedule afresh.
      this.staleTasks.push(task);
      if (current && this.planDirty().some((info) => info.id === current.id)) {
        this.queue.push({ info: current, baseline: current.fingerprint });
      }
      return true;
    }
    if (this.planDirty().some((info) => info.id === current.id)) {
      this.commit(current);
    }
    return true;
  }

  /** Drain the queue until nothing is dirty and nothing is pending. */
  settle(): void {
    for (;;) {
      this.schedule();
      if (this.queue.length === 0) break;
      while (this.completeNext()) {
        // keep draining; stale tasks requeue themselves
      }
    }
    this.refreshArtifacts();
  }
}
