import type { Event, SequencedEvent } from "./events";
import {
  emptyAccount,
  initialWorld,
  type Bucket,
  type MaterialAccount,
  type MaterialId,
  type OrderState,
  type StageState,
  type World,
} from "./model";

export class DomainError extends Error {}

function accountOf(world: World, material: MaterialId): MaterialAccount {
  const existing = world.materials[material];
  if (existing) return existing;
  const created = emptyAccount();
  world.materials[material] = created;
  return created;
}

function move(
  world: World,
  material: MaterialId,
  from: Bucket,
  to: Bucket,
  qty: number,
  reason: string,
  order: string | null,
  stage: string | null,
): void {
  if (qty <= 0) return;
  const account = accountOf(world, material);
  if (account[from] < qty) {
    throw new DomainError(
      `物料 ${material} 桶 ${from} 余额不足：需要 ${qty}，现有 ${account[from]}`,
    );
  }
  account[from] -= qty;
  account[to] += qty;
  world.ledger.push({ seq: world.seq, material, from, to, qty, reason, order, stage });
}

function orderOf(world: World, orderId: string): OrderState {
  const order = world.orders[orderId];
  if (!order) throw new DomainError(`订单不存在：${orderId}`);
  return order;
}

function stageOf(order: OrderState, stageName: string): StageState {
  const stage = order.stages.find((s) => s.name === stageName);
  if (!stage) throw new DomainError(`订单 ${order.id} 无阶段：${stageName}`);
  return stage;
}

function assertOrderOpen(order: OrderState): void {
  if (order.status !== "open") {
    throw new DomainError(`订单 ${order.id} 已${order.status === "completed" ? "完工" : "取消"}，禁止再操作`);
  }
}

function occupyEquipment(world: World, equipmentId: string, order: string, stage: string): void {
  const equipment = world.equipment[equipmentId];
  if (!equipment) throw new DomainError(`设备未注册：${equipmentId}`);
  if (equipment.busyBy) {
    throw new DomainError(
      `设备 ${equipmentId} 被订单 ${equipment.busyBy.order}/${equipment.busyBy.stage} 占用`,
    );
  }
  equipment.busyBy = { order, stage };
}

function releaseEquipment(world: World, equipmentId: string): void {
  const equipment = world.equipment[equipmentId];
  if (equipment) equipment.busyBy = null;
}

/** 投入一个阶段的原料并占用设备。retry 时 retained 部分从保留桶划转，不再消耗库房。 */
function startStage(world: World, orderId: string, stageName: string, isRetry: boolean): void {
  const order = orderOf(world, orderId);
  assertOrderOpen(order);
  const stage = stageOf(order, stageName);
  const plan = (world.plans[orderId] ?? []).find((p) => p.name === stageName);
  if (!plan) throw new DomainError(`订单 ${orderId} 无阶段计划：${stageName}`);

  if (isRetry) {
    if (stage.status !== "failed") {
      throw new DomainError(`阶段 ${orderId}/${stageName} 状态为 ${stage.status}，不能重试`);
    }
  } else {
    if (stage.status !== "pending") {
      throw new DomainError(`阶段 ${orderId}/${stageName} 状态为 ${stage.status}，不能开工`);
    }
    const idx = order.stages.indexOf(stage);
    const upstream = order.stages.slice(0, idx);
    if (!upstream.every((s) => s.status === "completed")) {
      throw new DomainError(`阶段 ${orderId}/${stageName} 的前置阶段未完工`);
    }
  }

  occupyEquipment(world, plan.equipment, orderId, stageName);

  for (const [material, requiredQty] of Object.entries(stage.required)) {
    const retainedQty = isRetry ? stage.retained[material] ?? 0 : 0;
    const shortfall = requiredQty - retainedQty;
    if (retainedQty > 0) {
      move(world, material, "retained", "held", retainedQty, "retry-reuse-retained", orderId, stageName);
      stage.retained[material] = 0;
    }
    if (shortfall > 0) {
      move(world, material, "onHand", "held", shortfall, isRetry ? "retry-consume-shortfall" : "consume", orderId, stageName);
    }
  }

  stage.attempts += 1;
  stage.status = "in-progress";
}

/** 应用一条已排序事件（reducer，纯领域规则，可重放）。 */
export function apply(world: World, event: Event): void {
  switch (event.kind) {
    case "StockReceived": {
      if (event.qty <= 0) throw new DomainError("收货数量必须为正");
      const account = accountOf(world, event.material);
      account.onHand += event.qty;
      world.ledger.push({
        seq: world.seq, material: event.material, from: "onHand", to: "onHand",
        qty: event.qty, reason: "stock-received", order: null, stage: null,
      });
      return;
    }
    case "EquipmentRegistered": {
      if (world.equipment[event.equipment]) throw new DomainError(`设备重复注册：${event.equipment}`);
      world.equipment[event.equipment] = { id: event.equipment, busyBy: null };
      return;
    }
    case "OrderPlaced": {
      if (world.orders[event.order]) throw new DomainError(`订单重复下达：${event.order}`);
      for (const plan of event.stages) {
        if (!world.equipment[plan.equipment]) throw new DomainError(`设备未注册：${plan.equipment}`);
        for (const [material, rate] of Object.entries(plan.recovery)) {
          if (rate < 0 || rate > 1) throw new DomainError(`回收率越界：${material}=${rate}`);
        }
      }
      world.plans[event.order] = event.stages;
      world.orders[event.order] = {
        id: event.order,
        status: "open",
        stages: event.stages.map((plan) => ({
          name: plan.name,
          status: "pending",
          required: { ...plan.materials },
          retained: {},
          attempts: 0,
        })),
      };
      return;
    }
    case "StageStarted":
      startStage(world, event.order, event.stage, false);
      return;
    case "StageRetried":
      startStage(world, event.order, event.stage, true);
      return;
    case "StageCompleted": {
      const order = orderOf(world, event.order);
      assertOrderOpen(order);
      const stage = stageOf(order, event.stage);
      if (stage.status !== "in-progress") {
        throw new DomainError(`阶段 ${event.order}/${event.stage} 未在制，不能完工`);
      }
      for (const [material, qty] of Object.entries(stage.required)) {
        move(world, material, "held", "consumed", qty, "stage-completed", event.order, event.stage);
      }
      const plan = (world.plans[event.order] ?? []).find((p) => p.name === event.stage);
      if (plan) releaseEquipment(world, plan.equipment);
      stage.status = "completed";
      if (order.stages.every((s) => s.status === "completed")) order.status = "completed";
      return;
    }
    case "StageFailed": {
      const order = orderOf(world, event.order);
      assertOrderOpen(order);
      const stage = stageOf(order, event.stage);
      if (stage.status !== "in-progress") {
        throw new DomainError(`阶段 ${event.order}/${event.stage} 未在制，不能判废`);
      }
      const plan = (world.plans[event.order] ?? []).find((p) => p.name === event.stage);
      if (!plan) throw new DomainError(`订单 ${event.order} 无阶段计划：${event.stage}`);
      for (const [material, qty] of Object.entries(stage.required)) {
        const rate = plan.recovery[material] ?? 0;
        const recovered = Math.floor(qty * rate);
        const lost = qty - recovered;
        if (recovered > 0) {
          move(world, material, "held", "retained", recovered, "failure-recovered", event.order, event.stage);
          stage.retained[material] = (stage.retained[material] ?? 0) + recovered;
        }
        if (lost > 0) {
          move(world, material, "held", "lost", lost, "failure-lost", event.order, event.stage);
        }
      }
      releaseEquipment(world, plan.equipment);
      stage.status = "failed";
      return;
    }
    case "OrderCancelled": {
      const order = orderOf(world, event.order);
      assertOrderOpen(order);
      for (const stage of order.stages) {
        if (stage.status === "in-progress") {
          for (const [material, qty] of Object.entries(stage.required)) {
            move(world, material, "held", "onHand", qty, "reverse-replenishment", event.order, stage.name);
            accountOf(world, material).reversed += qty;
          }
          stage.status = "pending";
        }
        for (const [material, qty] of Object.entries(stage.retained)) {
          if (qty > 0) {
            move(world, material, "retained", "onHand", qty, "reverse-replenishment", event.order, stage.name);
            accountOf(world, material).reversed += qty;
            stage.retained[material] = 0;
          }
        }
      }
      for (const equipment of Object.values(world.equipment)) {
        if (equipment.busyBy?.order === event.order) equipment.busyBy = null;
      }
      order.status = "cancelled";
      return;
    }
  }
}

/** 事件存储：追加时赋予连续序号，保证事件顺序显式且无缝。 */
export function append(world: World, event: Event): SequencedEvent {
  world.seq += 1;
  try {
    apply(world, event);
  } catch (err) {
    world.seq -= 1;
    throw err;
  }
  return { ...event, seq: world.seq };
}

/** 从头重放：校验序号从 1 连续递增，然后在空白状态上逐条应用。 */
export function replay(events: readonly SequencedEvent[]): World {
  const world = initialWorld();
  events.forEach((event, index) => {
    const expected = index + 1;
    if (event.seq !== expected) {
      throw new DomainError(`事件顺序断裂：期望 seq=${expected}，实际 seq=${event.seq}`);
    }
    world.seq = event.seq;
    apply(world, event);
  });
  return world;
}
