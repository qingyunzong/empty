import { SchedulerError, ERR_CURVE, ERR_DOMAIN } from './errors.js';
import { interpolator, validateTimeSeries } from './curve.js';

const EPS = 1e-9;

// 校验并规范化一个批次：
//  - curve: [{t, temp, phase?}] 升温/保温/降温曲线，t 自 0 严格递增；
//    两端均标记 phase==='hold' 的保温段禁止负斜率（ERR_CURVE）。
//  - power: [{t, power}] 功率曲线，功率非负有限（NaN -> ERR_DOMAIN）。
// 占用炉子的区间为半开区间 [0, duration)，duration 为温度曲线末时刻。
export function prepareBatch(raw) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new SchedulerError(ERR_DOMAIN, '批次必须是对象');
  }
  const { id, alloy, band, mass, curve, power } = raw;
  if (id === undefined || id === null || id === '') {
    throw new SchedulerError(ERR_DOMAIN, '批次缺少 id');
  }
  if (typeof alloy !== 'string' || alloy.length === 0) {
    throw new SchedulerError(ERR_DOMAIN, `批次 ${id}: 缺少合金牌号 alloy`);
  }
  if (!Array.isArray(band) || band.length !== 2 || !band.every(Number.isFinite)) {
    throw new SchedulerError(ERR_DOMAIN, `批次 ${id}: 温度带 band 非法`);
  }
  if (band[0] > band[1]) {
    throw new SchedulerError(ERR_DOMAIN, `批次 ${id}: 温度带上下限颠倒 [${band}]`);
  }
  if (typeof mass !== 'number' || !Number.isFinite(mass) || mass <= 0) {
    throw new SchedulerError(ERR_DOMAIN, `批次 ${id}: 装炉量 mass 非法 (${mass})`);
  }
  validateTimeSeries(curve, 'temp', `批次 ${id} 温度曲线`);
  if (curve.length < 2) {
    throw new SchedulerError(ERR_CURVE, `批次 ${id}: 温度曲线至少需要 2 个节点`);
  }
  for (let i = 0; i + 1 < curve.length; i++) {
    const a = curve[i];
    const b = curve[i + 1];
    if (a.phase === 'hold' && b.phase === 'hold' && b.temp < a.temp - EPS) {
      throw new SchedulerError(ERR_CURVE, `批次 ${id}: 保温段禁止负斜率 (t=${a.t} ${a.temp} -> t=${b.t} ${b.temp})`);
    }
  }
  validateTimeSeries(power, 'power', `批次 ${id} 功率曲线`);
  for (const p of power) {
    if (p.power < 0) {
      throw new SchedulerError(ERR_DOMAIN, `批次 ${id}: 功率为负 (${p.power})`);
    }
  }
  const duration = curve[curve.length - 1].t;
  if (duration <= 0) {
    throw new SchedulerError(ERR_CURVE, `批次 ${id}: 曲线时长必须为正`);
  }
  const tempAtRaw = interpolator(curve, 'temp');
  const powerAtRaw = interpolator(power, 'power');
  const out = {
    id,
    alloy,
    band: [band[0], band[1]],
    mass,
    duration,
    knots: curve.map((p) => p.t),
    tempAt: (t) => tempAtRaw(Math.min(Math.max(t, 0), duration)),
    powerAt: (t) => (t < -EPS || t > duration + EPS ? 0 : powerAtRaw(Math.min(Math.max(t, 0), duration))),
  };
  if (raw._version !== undefined) out._version = raw._version;
  return out;
}

// 同炉兼容：同合金、温度带有公共交集、装炉量总和不超过容量、
// 并且在任一曲线节点时刻同炉温差不超过 deltaMax。
export function runCompatible(members, cfg) {
  const tol = cfg.tol ?? EPS;
  const alloy = members[0].alloy;
  let mass = 0;
  let lo = -Infinity;
  let hi = Infinity;
  for (const b of members) {
    if (b.alloy !== alloy) return false;
    mass += b.mass;
    lo = Math.max(lo, b.band[0]);
    hi = Math.min(hi, b.band[1]);
  }
  if (mass > cfg.capacity + tol) return false;
  if (lo > hi + tol) return false;
  const runDuration = Math.max(...members.map((b) => b.duration));
  const knots = new Set();
  for (const b of members) {
    for (const k of b.knots) {
      if (k <= runDuration + tol) knots.add(Math.min(k, runDuration));
    }
  }
  for (const t of knots) {
    let mn = Infinity;
    let mx = -Infinity;
    for (const b of members) {
      if (t > b.duration + tol) continue;
      const tmp = b.tempAt(t);
      if (tmp < mn) mn = tmp;
      if (tmp > mx) mx = tmp;
    }
    if (mx - mn > cfg.deltaMax + tol) return false;
  }
  return true;
}

// 一个炉次：成员曲线对齐到同一开炉时刻，功率包络按 grid 采样（半开区间 [0, duration)）。
export function makeRun(members, grid = 1) {
  const duration = Math.max(...members.map((b) => b.duration));
  const slots = Math.max(1, Math.ceil(duration / grid - EPS));
  const profile = new Float64Array(slots);
  for (let j = 0; j < slots; j++) {
    const tau = j * grid;
    let p = 0;
    for (const b of members) p += b.powerAt(tau);
    profile[j] = p;
  }
  let peak = 0;
  for (const p of profile) peak = Math.max(peak, p);
  return { members, duration, profile, peak };
}
