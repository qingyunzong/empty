import type { Action, Scenario } from "./scenario";

export interface Interpretation {
  /** One `call:<subscription>` entry per handler invocation, in order. */
  readonly trace: readonly string[];
  /** Flattened error messages in publish-tree order. */
  readonly errors: readonly string[];
}

interface InterpretedSubscription {
  readonly id: number;
  readonly name: string;
  readonly topic: string;
  readonly plan: readonly Action[];
}

/**
 * Snapshot-semantics interpreter: the executable specification of the bus.
 *
 * - A publish iterates a fixed snapshot taken at publish time; subscriptions
 *   added or removed while it runs only affect later publishes.
 * - `fail` models a throwing handler: it records an error and aborts the
 *   rest of the plan, but never the rest of the publish.
 * - A nested publish whose subtree produced errors aborts the rest of the
 *   plan (the aggregate propagates like a thrown exception).
 * - `yield` only exists for the async runner and is a no-op here.
 *
 * Subscriptions are modeled with unique ids (names are only aliases for the
 * latest id), mirroring the bus so that re-subscribing a previously removed
 * name behaves identically.
 */
export function interpret(scenario: Scenario): Interpretation {
  const trace: string[] = [];
  const errors: string[] = [];
  let nextId = 1;
  const subs = new Map<number, InterpretedSubscription>();
  const handles = new Map<string, number>();
  const topics = new Map<string, number[]>();

  const addSub = (name: string, topic: string, plan: readonly Action[]): void => {
    const id = nextId++;
    subs.set(id, { id, name, topic, plan });
    handles.set(name, id);
    const list = topics.get(topic) ?? [];
    list.push(id);
    topics.set(topic, list);
  };

  const removeSub = (name: string): void => {
    const id = handles.get(name);
    if (id === undefined) return;
    handles.delete(name);
    const spec = subs.get(id);
    if (spec === undefined) return;
    subs.delete(id);
    const list = topics.get(spec.topic) ?? [];
    const index = list.indexOf(id);
    if (index >= 0) list.splice(index, 1);
  };

  for (const sub of scenario.subscriptions) addSub(sub.name, sub.topic, sub.plan);

  const runPlan = (
    sub: InterpretedSubscription,
    plan: readonly Action[],
    depth: number,
  ): void => {
    for (const action of plan) {
      switch (action.do) {
        case "fail":
          errors.push(`${sub.name}:${action.message}`);
          return;
        case "yield":
          break;
        case "subscribe":
          addSub(action.as, action.topic, action.plan);
          break;
        case "unsubscribe":
          removeSub(action.name);
          break;
        case "publish": {
          const before = errors.length;
          runPublish(action.topic, depth + 1);
          if (errors.length > before) return;
          break;
        }
        case "republish": {
          if (depth + 1 > action.maxDepth) break;
          const before = errors.length;
          runPublish(sub.topic, depth + 1);
          if (errors.length > before) return;
          break;
        }
      }
    }
  };

  let invocations = 0;
  const runPublish = (topic: string, depth: number): void => {
    if (++invocations > 100000) {
      throw new Error("scenario does not terminate (publish recursion bound exceeded)");
    }
    // Fixed snapshot: capture the subscription objects at publish time so
    // later removals cannot affect this publish.
    const snapshot = (topics.get(topic) ?? [])
      .map((id) => subs.get(id))
      .filter((sub): sub is InterpretedSubscription => sub !== undefined);
    for (const sub of snapshot) {
      trace.push(`call:${sub.name}`);
      runPlan(sub, sub.plan, depth);
    }
  };

  runPublish(scenario.rootTopic, 0);
  return { trace, errors };
}
