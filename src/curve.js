import { SchedulerError, ERR_CURVE, ERR_DOMAIN } from './errors.js';

// 分段线性插值；越界时钳到端点值（常数外延）。
export function interpolator(points, valueKey) {
  return (t) => {
    const first = points[0];
    const last = points[points.length - 1];
    if (t <= first.t) return first[valueKey];
    if (t >= last.t) return last[valueKey];
    let lo = 0;
    let hi = points.length - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (points[mid].t <= t) lo = mid;
      else hi = mid;
    }
    const a = points[lo];
    const b = points[hi];
    const f = (t - a.t) / (b.t - a.t);
    return a[valueKey] + f * (b[valueKey] - a[valueKey]);
  };
}

// 时间序列公共校验：t 必须自 0 起严格递增（倒挂/非法 -> ERR_CURVE），
// 数值必须有限（NaN/Infinity -> ERR_DOMAIN）。
export function validateTimeSeries(points, valueKey, label) {
  if (!Array.isArray(points) || points.length === 0) {
    throw new SchedulerError(ERR_CURVE, `${label}: 曲线为空`);
  }
  for (let i = 0; i < points.length; i++) {
    const p = points[i];
    if (p === null || typeof p !== 'object' || !Number.isFinite(p.t) || p.t < 0) {
      throw new SchedulerError(ERR_CURVE, `${label}: 非法时刻 t=${p && p.t}`);
    }
    if (i === 0 && p.t !== 0) {
      throw new SchedulerError(ERR_CURVE, `${label}: 曲线必须从 t=0 开始`);
    }
    if (i > 0 && p.t <= points[i - 1].t) {
      throw new SchedulerError(ERR_CURVE, `${label}: 时刻倒挂 t=${p.t} <= ${points[i - 1].t}`);
    }
    const v = p[valueKey];
    if (typeof v !== 'number' || !Number.isFinite(v)) {
      throw new SchedulerError(ERR_DOMAIN, `${label}: 非法数值 ${v} (t=${p.t})`);
    }
  }
}
