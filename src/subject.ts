import type { Scheduler } from "./scheduler";

export type JobStatus = "queued" | "running" | "done" | "cancelled";

export interface JobResult {
  id: string;
  status: "done" | "cancelled";
}

export interface JobEvent {
  type: "submitted" | "started" | "finished" | "cancelled";
  id: string;
}

// The contract both implementations must satisfy.
export interface JobQueue {
  submit(id: string): Promise<JobResult>;
  cancel(id: string): boolean;
  // Canonical state: sorted, stable serialization safe for cross-impl comparison.
  snapshot(): string;
  onEvent(listener: (event: JobEvent) => void): void;
}

export type JobQueueFactory = (scheduler: Scheduler) => JobQueue;

class ReferenceQueue implements JobQueue {
  private readonly jobs = new Map<string, JobStatus>();
  private readonly settlers = new Map<string, (result: JobResult) => void>();
  private readonly listeners: Array<(event: JobEvent) => void> = [];

  constructor(private readonly scheduler: Scheduler) {}

  onEvent(listener: (event: JobEvent) => void): void {
    this.listeners.push(listener);
  }

  protected emit(event: JobEvent): void {
    for (const listener of this.listeners) listener(event);
  }

  protected getStatus(id: string): JobStatus | undefined {
    return this.jobs.get(id);
  }

  protected settle(id: string, result: JobResult): void {
    const resolve = this.settlers.get(id);
    if (resolve !== undefined) {
      this.settlers.delete(id);
      resolve(result);
    }
  }

  submit(id: string): Promise<JobResult> {
    this.jobs.set(id, "queued");
    this.emit({ type: "submitted", id });
    return new Promise<JobResult>((resolve) => {
      this.settlers.set(id, resolve);
      this.scheduler.defer(() => {
        if (this.jobs.get(id) !== "queued") return;
        this.jobs.set(id, "running");
        this.emit({ type: "started", id });
        this.scheduler.defer(() => {
          if (this.jobs.get(id) !== "running") return;
          this.jobs.set(id, "done");
          this.emit({ type: "finished", id });
          this.settle(id, { id, status: "done" });
        });
      });
    });
  }

  cancel(id: string): boolean {
    const status = this.jobs.get(id);
    if (status !== "queued" && status !== "running") return false;
    this.jobs.set(id, "cancelled");
    this.emit({ type: "cancelled", id });
    this.settle(id, { id, status: "cancelled" });
    return true;
  }

  snapshot(): string {
    return [...this.jobs.entries()]
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([id, status]) => `${id}:${status}`)
      .join(",");
  }
}

export function createReferenceQueue(scheduler: Scheduler): JobQueue {
  return new ReferenceQueue(scheduler);
}

// Deliberately wrong implementation used for acceptance testing: cancel()
// reports success and emits the event, but never updates the job table, so
// the job later runs to completion and its promise resolves "done".
class BrokenCancelQueue extends ReferenceQueue {
  override cancel(id: string): boolean {
    const status = this.getStatus(id);
    if (status !== "queued" && status !== "running") return false;
    // BUG: emits "cancelled" but forgets to mark the job cancelled or settle
    // its promise, so the deferred completion still fires.
    this.emit({ type: "cancelled", id });
    return true;
  }
}

export function createBrokenCancelQueue(scheduler: Scheduler): JobQueue {
  return new BrokenCancelQueue(scheduler);
}
