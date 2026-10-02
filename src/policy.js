import { naturalCompare } from './util.js';
import { quotaOf } from './config.js';

// 服务策略：优先级高者优先；配额未用尽者优先；最久未服务课题组优先；最后按批 ID
export function makeComparator(state) {
  const usage = {};
  for (const b of Object.values(state.batches)) {
    if (b.status === 'cancelled') continue;
    usage[b.group] = (usage[b.group] || 0) + b.fieldsTotal;
  }
  return (a, b) => {
    if (a.priority !== b.priority) return b.priority - a.priority;
    const ua = (usage[a.group] || 0) < quotaOf(state.config, a.group);
    const ub = (usage[b.group] || 0) < quotaOf(state.config, b.group);
    if (ua !== ub) return ua ? -1 : 1;
    const la = state.groups[a.group]?.lastServedAt ?? -1;
    const lb = state.groups[b.group]?.lastServedAt ?? -1;
    if (la !== lb) return la - lb;
    return naturalCompare(a.id, b.id);
  };
}
