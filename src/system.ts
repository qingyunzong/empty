import { apply } from './apply.js';
import type { Event, EventPayload } from './events.js';
import type { JobSpec, JobState, MaterialQty, State } from './state.js';
import { cloneQty, initialState, isEmptyQty, mergeQty } from './state.js';

/**
 * 命令层：校验业务规则后产生显式有序事件并立即应用。
 * 所有派生数量（保留抵扣、损耗、退回）都在此计算并写入事件载荷。
 */
export class ProductionSystem {
  readonly state: State = initialState();
  readonly events: Event[] = [];

  private emit(payload: EventPayload): void {
    const event: Event = { ...payload, seq: this.events.length + 1 };
    apply(this.state, event);
    this.events.push(event);
  }

  initStock(items: MaterialQty): void {
    this.emit({ type: 'StockInitialized', items: cloneQty(items) });
  }

  registerEquipment(equipmentId: string, capacity: number): void {
    this.emit({ type: 'EquipmentRegistered', equipmentId, capacity });
  }

  placeOrder(orderId: string, jobs: JobSpec[]): void {
    this.emit({ type: 'OrderPlaced', orderId, jobs });
  }

  private jobOf(jobId: string): JobState {
    const job = this.state.jobs[jobId];
    if (!job) throw new Error(`unknown job: ${jobId}`);
    return job;
  }

  /** 开始当前阶段：保留料优先抵扣，只为缺口新增占用；同时占用设备 */
  startStage(jobId: string): void {
    const job = this.jobOf(jobId);
    if (job.status !== 'pending' && job.status !== 'in-progress') {
      throw new Error(`job ${jobId} not startable in status ${job.status}`);
    }
    if (job.activeStage) throw new Error(`job ${jobId} already has active stage`);
    const stage = job.stages[job.nextStage];
    if (!stage) throw new Error(`job ${jobId} has no remaining stage`);

    const fromRetained: MaterialQty = {};
    const fresh: MaterialQty = {};
    for (const [materialId, need] of Object.entries(stage.materials)) {
      const kept = Math.min(job.retained[materialId] ?? 0, need);
      if (kept > 0) fromRetained[materialId] = kept;
      if (need - kept > 0) fresh[materialId] = need - kept;
    }
    for (const [materialId, qty] of Object.entries(fresh)) {
      const entry = this.state.materials[materialId];
      if (!entry || entry.onHand < qty) {
        throw new Error(`insufficient ${materialId}: need ${qty}, on hand ${entry?.onHand ?? 0}`);
      }
    }
    for (const [equipmentId, units] of Object.entries(stage.equipment)) {
      const entry = this.state.equipment[equipmentId];
      if (!entry || entry.capacity - entry.inUse < units) {
        throw new Error(`equipment ${equipmentId} unavailable`);
      }
    }

    const attempt = job.attempt + 1;
    if (!isEmptyQty(fresh) || !isEmptyQty(fromRetained)) {
      this.emit({
        type: 'MaterialsReserved',
        orderId: job.orderId,
        jobId,
        stageId: stage.stageId,
        attempt,
        reserved: fresh,
        fromRetained,
      });
    }
    if (!isEmptyQty(stage.equipment)) {
      this.emit({ type: 'EquipmentOccupied', jobId, stageId: stage.stageId, units: cloneQty(stage.equipment) });
    }
    this.emit({ type: 'StageStarted', jobId, stageId: stage.stageId, attempt });
  }

  /** 阶段完成：在制原料转为消耗，释放设备；全部阶段完成则作业/订单完工 */
  completeStage(jobId: string): void {
    const job = this.jobOf(jobId);
    const active = job.activeStage;
    if (!active) throw new Error(`job ${jobId} has no active stage`);

    const consumed = cloneQty(job.held);
    this.emit({ type: 'StageCompleted', jobId, stageId: active.stageId, attempt: active.attempt, consumed });
    if (!isEmptyQty(job.heldEquipment)) {
      this.emit({ type: 'EquipmentReleased', jobId, stageId: active.stageId, units: cloneQty(job.heldEquipment) });
    }
    if (job.nextStage === job.stages.length) {
      this.emit({ type: 'JobCompleted', jobId });
      const order = this.state.orders[job.orderId];
      if (order && order.jobIds.every((id) => this.state.jobs[id]?.status === 'completed')) {
        this.emit({ type: 'OrderCompleted', orderId: job.orderId });
      }
    }
  }

  /** 阶段失败：按阶段回收策略拆分在制原料——可回收部分保留给重试，其余记损耗；释放设备 */
  failStage(jobId: string, reason: string): void {
    const job = this.jobOf(jobId);
    const active = job.activeStage;
    if (!active) throw new Error(`job ${jobId} has no active stage`);
    const stage = job.stages[job.nextStage];
    if (!stage) throw new Error(`job ${jobId} stage spec missing`);

    this.emit({ type: 'StageFailed', jobId, stageId: active.stageId, attempt: active.attempt, reason });

    const recoverable: MaterialQty = {};
    const scrapped: MaterialQty = {};
    for (const [materialId, qty] of Object.entries(job.held)) {
      const kept = Math.min(stage.recovery[materialId] ?? 0, qty);
      if (kept > 0) recoverable[materialId] = kept;
      if (qty - kept > 0) scrapped[materialId] = qty - kept;
    }
    if (!isEmptyQty(recoverable)) {
      this.emit({ type: 'MaterialsRetained', jobId, stageId: active.stageId, items: recoverable });
    }
    if (!isEmptyQty(scrapped)) {
      this.emit({ type: 'MaterialsScrapped', jobId, stageId: active.stageId, items: scrapped });
    }
    if (!isEmptyQty(job.heldEquipment)) {
      this.emit({ type: 'EquipmentReleased', jobId, stageId: active.stageId, units: cloneQty(job.heldEquipment) });
    }
  }

  /** 重试失败作业：仅允许 failed 状态；保留料直接抵扣，不会再次消耗库存 */
  retry(jobId: string): void {
    const job = this.jobOf(jobId);
    if (job.status !== 'failed') throw new Error(`job ${jobId} not failed, cannot retry`);
    this.emit({ type: 'JobRetried', jobId, attempt: job.attempt + 1 });
    this.startStage(jobId);
  }

  /** 整单取消：未完成作业取消，在制与保留原料全部逆向补料退回库存，释放设备 */
  cancelOrder(orderId: string): void {
    const order = this.state.orders[orderId];
    if (!order) throw new Error(`unknown order: ${orderId}`);
    if (order.status !== 'open') throw new Error(`order ${orderId} already ${order.status}`);

    this.emit({ type: 'OrderCancelled', orderId });
    for (const jobId of order.jobIds) {
      const job = this.state.jobs[jobId];
      if (!job || job.status === 'completed' || job.status === 'cancelled') continue;
      if (!isEmptyQty(job.heldEquipment)) {
        this.emit({
          type: 'EquipmentReleased',
          jobId,
          stageId: job.activeStage?.stageId ?? '-',
          units: cloneQty(job.heldEquipment),
        });
      }
      this.emit({ type: 'JobCancelled', orderId, jobId });
      const returned = mergeQty(job.held, job.retained);
      if (!isEmptyQty(returned)) {
        this.emit({ type: 'MaterialsReturned', orderId, jobId, items: returned, reason: 'order-cancel' });
      }
    }
  }
}
