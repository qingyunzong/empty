// Differential-test harness: generates seeded random operation scripts and
// executes them against the real EventBus (sync and async) and against the
// snapshot interpreter, so their call traces and aggregated errors can be
// compared.
//
// Structural invariants that keep scripts bounded and comparable:
//  - A `publish` action is always the LAST action of a template and targets
//    the dedicated topic `nest<level>` of its own template level.
//  - Only templates of a strictly lower level may subscribe to `nest<level>`.
//  - Root publishes only target the plain topics t0..t2.
// Therefore nested publishes form a strictly descending level chain (depth
// limit 3). The async executor awaits every nested publish, so both
// executors produce the interpreter's strict depth-first pre-order trace.
// (Fire-and-forget derived publishes intentionally interleave with the
// parent's dispatch loop; that path is covered by dedicated async tests.)

import { EventBus, type Subscription } from '../../src/event-bus.js';
import { SnapshotInterpreter } from './interpreter.js';

export type Action =
  | { readonly type: 'log'; readonly message: string }
  | { readonly type: 'throw'; readonly message: string }
  | { readonly type: 'publish'; readonly topic: string; readonly payload: string }
  | { readonly type: 'subscribe'; readonly topic: string; readonly template: number; readonly slot: number }
  | { readonly type: 'unsubscribe'; readonly slot: number };

export interface Template {
  readonly level: number;
  readonly actions: readonly Action[];
}

export interface Script {
  readonly templates: readonly Template[];
  readonly initial: ReadonlyArray<{ readonly topic: string; readonly template: number }>;
  readonly rootPublishes: ReadonlyArray<{ readonly topic: string; readonly payload: string }>;
}

export interface RunResult {
  readonly trace: readonly string[];
  readonly outcomes: readonly string[];
}

const LEVELS = 4; // template levels 0..3
const SLOTS = 8;
const ROOT_TOPICS = ['t0', 't1', 't2'];
// Work caps applied identically by every executor: without them the
// reentrant subscribe actions would grow topic fan-out exponentially.
const MAX_PER_TOPIC = 8;
const MAX_DYNAMIC_SUBSCRIPTIONS = 24;

/** Deterministic subscription ledger shared by all executors. */
class Ledger {
  private readonly counts = new Map<string, number>();
  private readonly topics = new Map<number, string>();
  private dynamic = 0;

  canSubscribe(topic: string): boolean {
    if (this.dynamic >= MAX_DYNAMIC_SUBSCRIPTIONS) return false;
    return (this.counts.get(topic) ?? 0) < MAX_PER_TOPIC;
  }

  record(id: number, topic: string): void {
    const count = this.counts.get(topic) ?? 0;
    this.counts.set(topic, count + 1);
    this.topics.set(id, topic);
    this.dynamic += 1;
  }

  unsubscribe(id: number): string | undefined {
    const topic = this.topics.get(id);
    if (topic === undefined) return undefined;
    this.topics.delete(id);
    this.counts.set(topic, (this.counts.get(topic) ?? 1) - 1);
    this.dynamic -= 1;
    return topic;
  }
}

export function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function generateScript(seed: number): Script {
  const rand = mulberry32(seed);
  const pick = (n: number): number => Math.floor(rand() * n);

  const templates: Template[] = [];
  for (let level = 0; level < LEVELS; level++) {
    const actions: Action[] = [];
    const count = 1 + pick(3);
    for (let j = 0; j < count; j++) {
      const r = rand();
      if (r < 0.4) {
        actions.push({ type: 'log', message: `m${level}_${j}` });
      } else if (r < 0.55) {
        actions.push({ type: 'throw', message: `b${level}_${j}` });
      } else if (level > 0 && r < 0.8) {
        if (rand() < 0.5) {
          actions.push({
            type: 'subscribe',
            topic: ROOT_TOPICS[pick(ROOT_TOPICS.length)]!,
            template: pick(LEVELS),
            slot: 4 + pick(SLOTS - 4),
          });
        } else {
          const nestLevel = 1 + pick(LEVELS - 1);
          actions.push({
            type: 'subscribe',
            topic: `nest${nestLevel}`,
            template: pick(nestLevel), // strictly lower level only
            slot: 4 + pick(SLOTS - 4),
          });
        }
      } else {
        actions.push({ type: 'unsubscribe', slot: pick(SLOTS) });
      }
    }
    // A publish action, if present, is always the last action.
    if (level > 0 && rand() < 0.6) {
      actions.push({ type: 'publish', topic: `nest${level}`, payload: `p${level}` });
    }
    templates.push({ level, actions });
  }

  // One initial subscription per root topic, plus one per nest topic with
  // 2/3 probability, so every root publish and most nested publishes hit at
  // least one callback.
  const initial: Script['initial'][number][] = [];
  for (const topic of ROOT_TOPICS) {
    initial.push({ topic, template: pick(LEVELS) });
  }
  for (let nestLevel = 1; nestLevel < LEVELS; nestLevel++) {
    if (rand() < 0.67) {
      initial.push({ topic: `nest${nestLevel}`, template: pick(nestLevel) });
    }
  }

  const rootPublishes: Script['rootPublishes'][number][] = [];
  const rootCount = 4 + pick(3);
  for (let i = 0; i < rootCount; i++) {
    rootPublishes.push({
      topic: ROOT_TOPICS[pick(ROOT_TOPICS.length)]!,
      payload: `r${i}`,
    });
  }

  return { templates, initial, rootPublishes };
}

function describeOutcome(error: unknown): string {
  if (error instanceof AggregateError) {
    return `errors:${error.errors.map(String).join('|')}`;
  }
  return `error:${String(error)}`;
}

/** Executes a script against the interpreter (the expected result). */
export function runOnInterpreter(script: Script): RunResult {
  const interpreter = new SnapshotInterpreter();
  const ledger = new Ledger();
  const slots: (number | undefined)[] = new Array(SLOTS).fill(undefined);
  let dynamic = 0;

  const runTemplate = (index: number, payload: string): void => {
    const template = script.templates[index]!;
    for (const action of template.actions) {
      switch (action.type) {
        case 'log':
          interpreter.trace.push(`log:${action.message}`);
          break;
        case 'throw':
          throw new Error(`boom:${action.message}`);
        case 'publish':
          try {
            interpreter.publish(action.topic, action.payload);
          } catch {
            // Derived errors stay merged in the enclosing publish tree.
          }
          break;
        case 'subscribe': {
          if (!ledger.canSubscribe(action.topic)) break;
          const target = action.template;
          const name = `dyn${dynamic++}:t${target}`;
          const id = interpreter.subscribe(action.topic, name, (p) =>
            runTemplate(target, p),
          );
          ledger.record(id, action.topic);
          slots[action.slot] = id;
          break;
        }
        case 'unsubscribe': {
          const id = slots[action.slot];
          if (id !== undefined) {
            interpreter.unsubscribe(id);
            ledger.unsubscribe(id);
          }
          break;
        }
      }
    }
  };

  script.initial.forEach((init, slot) => {
    const id = interpreter.subscribe(init.topic, `init${slot}:t${init.template}`, (p) =>
      runTemplate(init.template, p),
    );
    ledger.record(id, init.topic);
    slots[slot] = id;
  });

  const outcomes: string[] = [];
  for (const publish of script.rootPublishes) {
    try {
      interpreter.publish(publish.topic, publish.payload);
      outcomes.push('ok');
    } catch (error) {
      outcomes.push(describeOutcome(error));
    }
  }
  return { trace: interpreter.trace, outcomes };
}

/** Executes a script against the real bus using synchronous publish. */
export function runOnBusSync(script: Script): RunResult {
  const bus = new EventBus();
  const trace: string[] = [];
  const subscriptions = new Map<number, Subscription>();
  const ledger = new Ledger();
  const slots: (number | undefined)[] = new Array(SLOTS).fill(undefined);
  let dynamic = 0;

  const runTemplate = (index: number, payload: string): void => {
    const template = script.templates[index]!;
    for (const action of template.actions) {
      switch (action.type) {
        case 'log':
          trace.push(`log:${action.message}`);
          break;
        case 'throw':
          throw new Error(`boom:${action.message}`);
        case 'publish':
          try {
            bus.publish(action.topic, action.payload);
          } catch {
            // Derived errors stay merged in the enclosing publish tree.
          }
          break;
        case 'subscribe': {
          if (!ledger.canSubscribe(action.topic)) break;
          const target = action.template;
          const name = `dyn${dynamic++}:t${target}`;
          const subscription = bus.subscribe<string>(action.topic, (p) => {
            trace.push(`call:${name}:${p}`);
            runTemplate(target, p);
          });
          subscriptions.set(subscription.id, subscription);
          ledger.record(subscription.id, action.topic);
          slots[action.slot] = subscription.id;
          break;
        }
        case 'unsubscribe': {
          const id = slots[action.slot];
          const subscription = id === undefined ? undefined : subscriptions.get(id);
          if (subscription !== undefined) {
            subscription.remove();
            subscriptions.delete(subscription.id);
            ledger.unsubscribe(subscription.id);
          }
          break;
        }
      }
    }
  };

  script.initial.forEach((init, slot) => {
    const name = `init${slot}:t${init.template}`;
    const subscription = bus.subscribe<string>(init.topic, (p) => {
      trace.push(`call:${name}:${p}`);
      runTemplate(init.template, p);
    });
    subscriptions.set(subscription.id, subscription);
    ledger.record(subscription.id, init.topic);
    slots[slot] = subscription.id;
  });

  const outcomes: string[] = [];
  for (const publish of script.rootPublishes) {
    try {
      bus.publish(publish.topic, publish.payload);
      outcomes.push('ok');
    } catch (error) {
      outcomes.push(describeOutcome(error));
    }
  }
  return { trace, outcomes };
}

/**
 * Executes a script against the real bus using publishAsync. Nested publishes
 * are awaited inside their callback, so the callback invocation order is the
 * same strict depth-first pre-order as the synchronous interpreter.
 */
export async function runOnBusAsync(script: Script): Promise<RunResult> {
  const bus = new EventBus();
  const trace: string[] = [];
  const subscriptions = new Map<number, Subscription>();
  const ledger = new Ledger();
  const slots: (number | undefined)[] = new Array(SLOTS).fill(undefined);
  let dynamic = 0;

  const runTemplate = async (index: number, payload: string): Promise<void> => {
    const template = script.templates[index]!;
    for (const action of template.actions) {
      switch (action.type) {
        case 'log':
          trace.push(`log:${action.message}`);
          break;
        case 'throw':
          throw new Error(`boom:${action.message}`);
        case 'publish':
          // Awaited derived publish; its errors stay merged in the enclosing
          // publish tree even though the callback itself swallows them.
          await bus.publishAsync(action.topic, action.payload).catch(() => {});
          break;
        case 'subscribe': {
          if (!ledger.canSubscribe(action.topic)) break;
          const target = action.template;
          const name = `dyn${dynamic++}:t${target}`;
          const subscription = bus.subscribe<string>(action.topic, (p) => {
            trace.push(`call:${name}:${p}`);
            return runTemplate(target, p);
          });
          subscriptions.set(subscription.id, subscription);
          ledger.record(subscription.id, action.topic);
          slots[action.slot] = subscription.id;
          break;
        }
        case 'unsubscribe': {
          const id = slots[action.slot];
          const subscription = id === undefined ? undefined : subscriptions.get(id);
          if (subscription !== undefined) {
            subscription.remove();
            subscriptions.delete(subscription.id);
            ledger.unsubscribe(subscription.id);
          }
          break;
        }
      }
    }
  };

  script.initial.forEach((init, slot) => {
    const name = `init${slot}:t${init.template}`;
    const subscription = bus.subscribe<string>(init.topic, (p) => {
      trace.push(`call:${name}:${p}`);
      return runTemplate(init.template, p);
    });
    subscriptions.set(subscription.id, subscription);
    ledger.record(subscription.id, init.topic);
    slots[slot] = subscription.id;
  });

  const outcomes: string[] = [];
  for (const publish of script.rootPublishes) {
    try {
      await bus.publishAsync(publish.topic, publish.payload);
      outcomes.push('ok');
    } catch (error) {
      outcomes.push(describeOutcome(error));
    }
  }
  return { trace, outcomes };
}
