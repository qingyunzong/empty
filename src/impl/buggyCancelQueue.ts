import { PlanScheduler } from '../scheduler';
import {
  JobQueue,
  JobStatus,
  JobView,
  QueueSnapshot,
  compareJobIds,
} from '../sut';

interface Job {
  id: string;
  name: string;
  status: JobStatus;
}

/**
 * DELIBERATELY WRONG cancellation — acceptance-test fixture only.
 *
 * cancel() flips the status and reports success, but the scheduled
 * settlement is not detached: a later tick flips the job to `done` and
 * emits `resolve:<id>` after `cancel:<id>`. Any correct differential
 * harness must flag this as a state/event-order divergence.
 */
export class BuggyCancelQueue implements JobQueue {
  private readonly jobs = new Map<string, Job>();
  private events: string[] = [];
  private counter = 0;

  constructor(private readonly scheduler: PlanScheduler) {}

  submit(name: string): string {
    const id = `j${++this.counter}`;
    this.jobs.set(id, { id, name, status: 'pending' });
    this.events.push(`submit:${id}`);
    void this.scheduler.schedule(id).then(() => this.complete(id));
    return id;
  }

  private complete(id: string): void {
    const job = this.jobs.get(id);
    if (!job) return;
    // BUG: ignores `cancelled` — resurrects cancelled jobs as done.
    if (job.status === 'done') return;
    job.status = 'done';
    this.events.push(`resolve:${id}`);
  }

  cancel(id: string): boolean {
    const job = this.jobs.get(id);
    if (!job || job.status !== 'pending') {
      this.events.push(`cancel-miss:${id}`);
      return false;
    }
    job.status = 'cancelled';
    this.events.push(`cancel:${id}`);
    return true;
  }

  status(id: string): JobStatus | 'missing' {
    return this.jobs.get(id)?.status ?? 'missing';
  }

  snapshot(): QueueSnapshot {
    const jobs: JobView[] = [...this.jobs.values()]
      .map((j) => ({ id: j.id, name: j.name, status: j.status }))
      .sort((a, b) => compareJobIds(a.id, b.id));
    return { jobs, pending: jobs.filter((j) => j.status === 'pending').length };
  }

  drainEvents(): string[] {
    const out = this.events;
    this.events = [];
    return out;
  }
}
