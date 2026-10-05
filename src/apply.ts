import type { Event } from './events.js';
import type { MaterialState, State } from './state.js';
import { addQty } from './state.js';

function materialOf(state: State, materialId: string): MaterialState {
  const found = state.materials[materialId];
  if (!found) throw new Error(`unknown material: ${materialId}`);
  return found;
}

function jobOf(state: State, jobId: string) {
  const job = state.jobs[jobId];
  if (!job) throw new Error(`unknown job: ${jobId}`);
  return job;
}

/**
 * 纯归约器：线上执行与从头重放共用同一份逻辑，
 * 事件载荷已携带全部派生数量，重放无需重新决策。
 */
export function apply(state: State, event: Event): void {
  switch (event.type) {
    case 'StockInitialized': {
      for (const [materialId, qty] of Object.entries(event.items)) {
        const entry = state.materials[materialId] ?? { onHand: 0, reserved: 0 };
        entry.onHand += qty;
        state.materials[materialId] = entry;
      }
      return;
    }
    case 'EquipmentRegistered': {
      if (state.equipment[event.equipmentId]) throw new Error(`equipment exists: ${event.equipmentId}`);
      state.equipment[event.equipmentId] = { capacity: event.capacity, inUse: 0 };
      return;
    }
    case 'OrderPlaced': {
      if (state.orders[event.orderId]) throw new Error(`order exists: ${event.orderId}`);
      state.orders[event.orderId] = {
        orderId: event.orderId,
        jobIds: event.jobs.map((job) => job.jobId),
        status: 'open',
      };
      for (const spec of event.jobs) {
        if (state.jobs[spec.jobId]) throw new Error(`job exists: ${spec.jobId}`);
        state.jobs[spec.jobId] = {
          jobId: spec.jobId,
          orderId: event.orderId,
          stages: spec.stages,
          nextStage: 0,
          attempt: 0,
          status: 'pending',
          held: {},
          retained: {},
          consumed: {},
          heldEquipment: {},
          activeStage: null,
        };
      }
      return;
    }
    case 'MaterialsReserved': {
      const job = jobOf(state, event.jobId);
      for (const [materialId, qty] of Object.entries(event.reserved)) {
        const entry = materialOf(state, materialId);
        if (entry.onHand < qty) throw new Error(`insufficient ${materialId}`);
        entry.onHand -= qty;
        entry.reserved += qty;
      }
      addQty(job.retained, event.fromRetained, -1);
      addQty(job.held, event.reserved);
      addQty(job.held, event.fromRetained);
      return;
    }
    case 'EquipmentOccupied': {
      const job = jobOf(state, event.jobId);
      for (const [equipmentId, units] of Object.entries(event.units)) {
        const entry = state.equipment[equipmentId];
        if (!entry) throw new Error(`unknown equipment: ${equipmentId}`);
        if (entry.capacity - entry.inUse < units) throw new Error(`equipment busy: ${equipmentId}`);
        entry.inUse += units;
      }
      addQty(job.heldEquipment, event.units);
      return;
    }
    case 'StageStarted': {
      const job = jobOf(state, event.jobId);
      job.attempt = event.attempt;
      job.status = 'in-progress';
      job.activeStage = { stageId: event.stageId, attempt: event.attempt };
      return;
    }
    case 'StageCompleted': {
      const job = jobOf(state, event.jobId);
      for (const [materialId, qty] of Object.entries(event.consumed)) {
        materialOf(state, materialId).reserved -= qty;
      }
      addQty(job.held, event.consumed, -1);
      addQty(job.consumed, event.consumed);
      job.nextStage += 1;
      job.attempt = 0;
      job.activeStage = null;
      return;
    }
    case 'StageFailed': {
      const job = jobOf(state, event.jobId);
      job.status = 'failed';
      job.activeStage = null;
      return;
    }
    case 'MaterialsRetained': {
      const job = jobOf(state, event.jobId);
      addQty(job.held, event.items, -1);
      addQty(job.retained, event.items);
      return;
    }
    case 'MaterialsScrapped': {
      const job = jobOf(state, event.jobId);
      for (const [materialId, qty] of Object.entries(event.items)) {
        materialOf(state, materialId).reserved -= qty;
      }
      addQty(job.held, event.items, -1);
      addQty(state.scrapped, event.items);
      return;
    }
    case 'EquipmentReleased': {
      const job = jobOf(state, event.jobId);
      for (const [equipmentId, units] of Object.entries(event.units)) {
        const entry = state.equipment[equipmentId];
        if (!entry) throw new Error(`unknown equipment: ${equipmentId}`);
        entry.inUse -= units;
      }
      addQty(job.heldEquipment, event.units, -1);
      return;
    }
    case 'JobRetried': {
      const job = jobOf(state, event.jobId);
      job.status = 'in-progress';
      return;
    }
    case 'JobCompleted': {
      const job = jobOf(state, event.jobId);
      job.status = 'completed';
      return;
    }
    case 'OrderCompleted': {
      const order = state.orders[event.orderId];
      if (!order) throw new Error(`unknown order: ${event.orderId}`);
      order.status = 'completed';
      return;
    }
    case 'OrderCancelled': {
      const order = state.orders[event.orderId];
      if (!order) throw new Error(`unknown order: ${event.orderId}`);
      order.status = 'cancelled';
      return;
    }
    case 'JobCancelled': {
      const job = jobOf(state, event.jobId);
      job.status = 'cancelled';
      job.activeStage = null;
      return;
    }
    case 'MaterialsReturned': {
      const job = jobOf(state, event.jobId);
      for (const [materialId, qty] of Object.entries(event.items)) {
        const entry = materialOf(state, materialId);
        entry.reserved -= qty;
        entry.onHand += qty;
      }
      job.held = {};
      job.retained = {};
      return;
    }
  }
}
