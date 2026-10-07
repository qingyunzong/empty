import { PlanScheduler } from '../scheduler';
import {
  JobQueue,
  JobStatus,
  JobView,
  QueueSnapshot,
  compareJobIds,
} from '../sut';

interface Entry {
  id: string;
  name: string;
  cancelled: boolean;
  settled: boolean;
}

/**
 * Alternative implementation: array-backed with flag-based cancellation and
 * lazy sweeping. Structurally different from the reference, but required to
 * be observationally identical (results, canonical state, event order).
 */
export class AltQueue implements JobQueue {
  private entries: Entry[] = [];
  private events: string[] = [];
  private counter = 0;

  constructor(private readonly scheduler: PlanScheduler) {}

  submit(name: string): string {
    const id = `j${++this.counter}`;
    this.entries.push({ id, name, cancelled: false, settled: false });
    this.events.push(`submit:${id}`);
    void this.scheduler.schedule(id).then(() => this.sweep(id));
    return id;
  }

  private sweep(id: string): void {
    const entry = this.entries.find((e) => e.id === id);
    if (!entry || entry.settled || entry.cancelled) return;
    entry.settled = true;
    this.events.push(`resolve:${id}`);
  }

  cancel(id: string): boolean {
    const entry = this.entries.find((e) => e.id === id);
    if (!entry || entry.settled || entry.cancelled) {
      this.events.push(`cancel-miss:${id}`);
      return false;
    }
    entry.cancelled = true;
    this.events.push(`cancel:${id}`);
    return true;
  }

  private statusOf(entry: Entry): JobStatus {
    if (entry.cancelled) return 'cancelled';
    return entry.settled ? 'done' : 'pending';
  }

  status(id: string): JobStatus | 'missing' {
    const entry = this.entries.find((e) => e.id === id);
    return entry ? this.statusOf(entry) : 'missing';
  }

  snapshot(): QueueSnapshot {
    const jobs: JobView[] = this.entries
      .map((e) => ({ id: e.id, name: e.name, status: this.statusOf(e) }))
      .sort((a, b) => compareJobIds(a.id, b.id));
    return { jobs, pending: jobs.filter((j) => j.status === 'pending').length };
  }

  drainEvents(): string[] {
    const out = this.events;
    this.events = [];
    return out;
  }
}
