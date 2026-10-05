import { append, replay } from "./engine";
import type { SequencedEvent } from "./events";
import { initialWorld, type World } from "./model";

export interface ScenarioResult {
  world: World;
  events: SequencedEvent[];
  replayed: World;
}

/**
 * 演示场景：
 * - 订单 A：cut 失败（钢回收 50%）→ 重试只补差量 → 完工；form 完工；
 *   bake 失败（塑料回收 60%）→ 整单取消 → 保留料逆向补料回库。
 * - 订单 B：单阶段一次完工，作为对照。
 */
export function runScenario(): ScenarioResult {
  const world = initialWorld();
  const events: SequencedEvent[] = [];
  const emit = (event: Parameters<typeof append>[1]): void => {
    events.push(append(world, event));
  };

  emit({ kind: "StockReceived", material: "steel", qty: 100 });
  emit({ kind: "StockReceived", material: "copper", qty: 60 });
  emit({ kind: "StockReceived", material: "plastic", qty: 80 });
  emit({ kind: "EquipmentRegistered", equipment: "press-1" });
  emit({ kind: "EquipmentRegistered", equipment: "oven-1" });
  emit({
    kind: "OrderPlaced",
    order: "A",
    stages: [
      { name: "cut", materials: { steel: 10 }, equipment: "press-1", recovery: { steel: 0.5 } },
      { name: "form", materials: { steel: 6, copper: 4 }, equipment: "press-1", recovery: {} },
      { name: "bake", materials: { plastic: 5 }, equipment: "oven-1", recovery: { plastic: 0.6 } },
    ],
  });
  emit({
    kind: "OrderPlaced",
    order: "B",
    stages: [
      { name: "cut", materials: { steel: 8 }, equipment: "press-1", recovery: { steel: 0.5 } },
    ],
  });

  emit({ kind: "StageStarted", order: "A", stage: "cut" });
  emit({ kind: "StageFailed", order: "A", stage: "cut" });
  emit({ kind: "StageRetried", order: "A", stage: "cut" });
  emit({ kind: "StageCompleted", order: "A", stage: "cut" });
  emit({ kind: "StageStarted", order: "A", stage: "form" });
  emit({ kind: "StageCompleted", order: "A", stage: "form" });
  emit({ kind: "StageStarted", order: "A", stage: "bake" });
  emit({ kind: "StageFailed", order: "A", stage: "bake" });
  emit({ kind: "OrderCancelled", order: "A" });

  emit({ kind: "StageStarted", order: "B", stage: "cut" });
  emit({ kind: "StageCompleted", order: "B", stage: "cut" });

  return { world, events, replayed: replay(events) };
}
