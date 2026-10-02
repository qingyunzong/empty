export const EXIT_CONFLICT = 10;

export class SchedError extends Error {
  constructor(code, message, details = {}, exitCode = 1) {
    super(message);
    this.code = code;
    this.details = details;
    this.exitCode = exitCode;
  }
  explanation() {
    return { error: this.code, message: this.message, details: this.details };
  }
}

export const channelConflict = (id, pair) =>
  new SchedError('CHANNEL_CONFLICT', `通道冲突: 批次 ${id} 的通道组合含互斥对 ${pair.join(' <-> ')}`, { id, pair }, EXIT_CONFLICT);

export const maintenanceOverlap = (a, b) =>
  new SchedError('MAINTENANCE_OVERLAP', `维护重叠: [${a.start},${a.end}) 与已有窗口 [${b.start},${b.end})`, { requested: a, existing: b }, EXIT_CONFLICT);

export const negativeFields = (id, fields) =>
  new SchedError('NEGATIVE_FIELDS', `负视野: 批次 ${id} 视野数变为 ${fields}`, { id, fields }, EXIT_CONFLICT);

export const unknownBatch = (id) =>
  new SchedError('UNKNOWN_BATCH', `未知批次: ${id}`, { id });

export const unknownChannel = (ch) =>
  new SchedError('UNKNOWN_CHANNEL', `未知荧光通道: ${ch}`, { channel: ch });

export const unknownObjective = (o) =>
  new SchedError('UNKNOWN_OBJECTIVE', `未知物镜: ${o}`, { objective: o });

export const invalid = (message, details = {}) =>
  new SchedError('INVALID', message, details);

export const infeasible = (message, details = {}) =>
  new SchedError('INFEASIBLE', message, details);

export const migrationFailed = (window, batches) =>
  new SchedError('MIGRATION_FAILED', `维护撤销时段 [${window.start},${window.end}) 后迁移失败: 超出调度视界`, { window, affectedBatches: batches });

export const immutable = (message, details = {}) =>
  new SchedError('IMMUTABLE', message, details);

export const proofMismatch = (seq, expected, actual) =>
  new SchedError('PROOF_MISMATCH', `回放证明不匹配 seq=${seq}`, { seq, expected, actual });

export const noGeneration = (gen) =>
  new SchedError('NO_GENERATION', `不存在批代际: ${gen}`, { gen });
