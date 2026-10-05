import { AlertEvent, ChangeSet, Source } from './model.js';
import { AlertWindowStore } from './store.js';
import { SubscriberMessage } from './subscription.js';

/** 可调度任务：增删事件、删最早、窗移动、发布快照、订阅取消息。 */
export type Task =
  | { type: 'add'; event: AlertEvent }
  | { type: 'delete'; id: number }
  | { type: 'deleteEarliest'; key?: string }
  | { type: 'moveWindow'; start: number; end: number }
  | { type: 'snapshot' }
  | { type: 'poll'; subscriptionId: number };

export interface LogEntry {
  seq: number;
  task: Task['type'];
  version?: number;
  source?: Source;
}

/**
 * 可控执行器：任务入队后逐条执行（FIFO 或种子随机交错），
 * 每次变更的版本与来源记入 log，输出流可供订阅重建核对。
 */
export class Executor {
  private tasks: Task[] = [];
  readonly log: LogEntry[] = [];
  readonly outputs: (ChangeSet | SubscriberMessage[])[] = [];
  private seq = 0;

  constructor(private readonly store: AlertWindowStore) {}

  enqueue(...tasks: Task[]): void {
    this.tasks.push(...tasks);
  }

  get pending(): number {
    return this.tasks.length;
  }

  runNext(): boolean {
    const t = this.tasks.shift();
    if (!t) return false;
    this.execute(t);
    return true;
  }

  runAll(): void {
    while (this.runNext());
  }

  /** 随机交错执行：用种子随机源挑选下一个任务。 */
  runShuffled(rand: () => number): void {
    while (this.tasks.length > 0) {
      const i = Math.floor(rand() * this.tasks.length);
      const [t] = this.tasks.splice(i, 1);
      this.execute(t);
    }
  }

  private execute(t: Task): void {
    this.seq += 1;
    switch (t.type) {
      case 'add':
        this.record(this.store.addEvent(t.event), t.type);
        break;
      case 'delete':
        this.record(this.store.deleteEvent(t.id), t.type);
        break;
      case 'deleteEarliest':
        this.record(this.store.deleteEarliest(t.key), t.type);
        break;
      case 'moveWindow':
        this.record(this.store.moveWindow(t.start, t.end), t.type);
        break;
      case 'snapshot': {
        const msgs = this.store.completeNextSnapshot();
        this.log.push({ seq: this.seq, task: t.type });
        if (msgs) this.outputs.push(msgs);
        break;
      }
      case 'poll': {
        const sub = this.store.subscriptionById(t.subscriptionId);
        this.log.push({ seq: this.seq, task: t.type });
        this.outputs.push(sub ? sub.poll() : []);
        break;
      }
    }
  }

  private record(cs: ChangeSet, task: Task['type']): void {
    this.log.push({ seq: this.seq, task, version: cs.version, source: cs.source });
    this.outputs.push(cs);
  }
}
