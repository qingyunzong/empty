// 工单状态机（库实现）。
// 合法迁移: create -> created; created -> assigned|cancelled;
//           assigned -> started|cancelled; started -> completed。
// 显式禁止: completed -> start, cancelled -> assign（表中无对应边，一律拒绝）。

const TRANSITIONS = {
  created: { assign: 'assigned', cancel: 'cancelled' },
  assigned: { start: 'started', cancel: 'cancelled' },
  started: { complete: 'completed' },
  completed: {},
  cancelled: {},
};

export const STATUSES = ['created', 'assigned', 'started', 'completed', 'cancelled'];
export const COMMANDS = ['create', 'assign', 'start', 'complete', 'cancel'];

export function step(status, type) {
  if (type === 'create') {
    return status === null
      ? { ok: true, status: 'created' }
      : { ok: false, reason: 'duplicate-create' };
  }
  if (status === null || status === undefined) {
    return { ok: false, reason: 'unknown-order' };
  }
  const next = TRANSITIONS[status]?.[type];
  if (!next) {
    return { ok: false, reason: `illegal-transition:${status}->${type}` };
  }
  return { ok: true, status: next };
}
