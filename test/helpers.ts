import { Broker } from "../src/broker.js";
import { ManualClock } from "../src/clock.js";
import { Consumer, type ConsumerHooks } from "../src/consumer.js";
import { DedupStore } from "../src/store.js";
import { TraceLog } from "../src/trace.js";

export const SUB = "sub-1";
export const LEASE_MS = 100;

export interface World {
  clock: ManualClock;
  trace: TraceLog;
  broker: Broker;
  store: DedupStore;
  consumer: Consumer;
}

export function makeWorld(hooks: ConsumerHooks = {}): World {
  const clock = new ManualClock();
  const trace = new TraceLog(clock.now);
  const broker = new Broker(trace, clock.now, LEASE_MS);
  const store = new DedupStore(trace);
  const consumer = new Consumer(broker, store, trace, SUB, hooks);
  broker.subscribe(SUB);
  return { clock, trace, broker, store, consumer };
}

/**
 * 驱动消费循环直到代理侧全部确认：
 * 空轮或提交失败时推进时钟越过租约，触发重投。
 */
export function drain(world: World, maxRounds = 100): void {
  for (let round = 0; round < maxRounds; round += 1) {
    const outcome = world.consumer.pollOnce();
    if (outcome === "empty") {
      if (world.broker.pendingCount() === 0) return;
      world.clock.advance(LEASE_MS + 1);
    } else if (outcome === "commit-failed" || outcome === "broker-down") {
      world.clock.advance(LEASE_MS + 1);
    }
  }
  throw new Error(`not drained after ${maxRounds} rounds\n${world.trace.format()}`);
}
