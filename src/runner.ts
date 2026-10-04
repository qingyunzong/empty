import {
  EventBus,
  PublishAggregateError,
  type HandlerContext,
  type Subscription,
} from "./event-bus";
import type { Action, Scenario } from "./scenario";

export interface RunResult {
  readonly trace: string[];
  readonly errors: string[];
  /** In-flight invocations after the root publish settled; must be 0. */
  readonly inFlightAfter: number;
}

const tick = (): Promise<void> => Promise.resolve();

/**
 * Executes a scenario against the real bus. In "sync" mode every publish is
 * `publishSync` and handlers are synchronous; in "async" mode every publish
 * is awaited `publish` and handlers yield to the microtask queue before
 * acting (await-then-reenter). Both modes must match the interpreter.
 */
export async function runScenario(
  scenario: Scenario,
  mode: "sync" | "async",
): Promise<RunResult> {
  const bus = new EventBus();
  const trace: string[] = [];
  const handles = new Map<string, Subscription>();

  const runPlan = async (
    name: string,
    plan: readonly Action[],
    ctx: HandlerContext,
  ): Promise<void> => {
    for (const action of plan) {
      switch (action.do) {
        case "fail":
          throw new Error(`${name}:${action.message}`);
        case "yield":
          if (mode === "async") {
            for (let i = 0; i < action.ticks; i++) await tick();
          }
          break;
        case "subscribe":
          handles.set(
            action.as,
            bus.subscribe(action.topic, makeHandler(action.as, action.plan)),
          );
          break;
        case "unsubscribe": {
          const handle = handles.get(action.name);
          if (handle !== undefined) handle.unsubscribe();
          break;
        }
        case "publish":
          await publish(action.topic);
          break;
        case "republish":
          if (ctx.depth + 1 <= action.maxDepth) await publish(ctx.topic);
          break;
      }
    }
  };

  const publish = async (topic: string): Promise<void> => {
    if (mode === "sync") bus.publishSync(topic, undefined);
    else await bus.publish(topic, undefined);
  };

  const makeHandler = (name: string, plan: readonly Action[]) => {
    if (mode === "sync") {
      return (_payload: unknown, ctx: HandlerContext): void => {
        trace.push(`call:${name}`);
        runPlanSync(name, plan, ctx);
      };
    }
    return async (_payload: unknown, ctx: HandlerContext): Promise<void> => {
      trace.push(`call:${name}`);
      await runPlan(name, plan, ctx);
    };
  };

  const runPlanSync = (
    name: string,
    plan: readonly Action[],
    ctx: HandlerContext,
  ): void => {
    for (const action of plan) {
      switch (action.do) {
        case "fail":
          throw new Error(`${name}:${action.message}`);
        case "yield":
          break;
        case "subscribe":
          handles.set(
            action.as,
            bus.subscribe(action.topic, makeHandler(action.as, action.plan)),
          );
          break;
        case "unsubscribe": {
          const handle = handles.get(action.name);
          if (handle !== undefined) handle.unsubscribe();
          break;
        }
        case "publish":
          bus.publishSync(action.topic, undefined);
          break;
        case "republish":
          if (ctx.depth + 1 <= action.maxDepth) {
            bus.publishSync(ctx.topic, undefined);
          }
          break;
      }
    }
  };

  for (const sub of scenario.subscriptions) {
    handles.set(sub.name, bus.subscribe(sub.topic, makeHandler(sub.name, sub.plan)));
  }

  const errors: string[] = [];
  try {
    if (mode === "sync") bus.publishSync(scenario.rootTopic, undefined);
    else await bus.publish(scenario.rootTopic, undefined);
  } catch (error) {
    if (error instanceof PublishAggregateError) {
      errors.push(...(error.errors as Error[]).map((e) => e.message));
    } else {
      throw error;
    }
  }
  return { trace, errors, inFlightAfter: bus.inFlightCount };
}
