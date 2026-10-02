// 灭菌釜(retort)控制状态机。
// 相: IDLE -> READY -> HEATING -> VENTING/COOLING -> IDLE
// 传感器: DOOR / PRESSURE / TEMP, 未收到 ack 前保持 UNKNOWN。
// 安全联锁: 升温(HEATING)中开排汽(OPEN_EXHAUST)必须已确认 PRESSURE=OK;
//           开釜门(OPEN_DOOR)必须已确认 PRESSURE=ZERO。
// 传感器值 UNKNOWN 时联锁无法被证明安全 -> 该步 UNKNOWN, 不判安全。

export const SENSORS = ['DOOR', 'PRESSURE', 'TEMP'];

// ack 因果: 每个传感器 ack 必须由对应命令引发, 否则历史不可线性化。
export const ACK_CAUSE = {
  DOOR: 'LOCK_DOOR',
  PRESSURE: 'START_HEAT',
  TEMP: 'START_HEAT',
};

export const COMMANDS = ['LOCK_DOOR', 'START_HEAT', 'STOP_HEAT', 'OPEN_EXHAUST', 'OPEN_DOOR'];

export const SENSOR_VALUES = {
  DOOR: ['LOCKED', 'UNLOCKED'],
  PRESSURE: ['OK', 'LOW', 'ZERO'],
  TEMP: ['OK', 'LOW'],
};

export function createMachine() {
  return {
    phase: 'IDLE',
    sensors: { DOOR: 'UNKNOWN', PRESSURE: 'UNKNOWN', TEMP: 'UNKNOWN' },
    issued: [],
  };
}

function clone(state) {
  return { phase: state.phase, sensors: { ...state.sensors }, issued: [...state.issued] };
}

const ok = (state) => ({ state, status: 'OK', reason: null });
const fail = (state, status, reason) => ({ state, status, reason });

function applyCmd(state, name) {
  state.issued.push(name);
  switch (name) {
    case 'LOCK_DOOR':
      if (state.phase !== 'IDLE') return fail(state, 'VIOLATION', `LOCK_DOOR illegal in phase ${state.phase}`);
      state.phase = 'READY';
      return ok(state);
    case 'START_HEAT':
      if (state.phase !== 'READY') return fail(state, 'VIOLATION', `START_HEAT illegal in phase ${state.phase}`);
      state.phase = 'HEATING';
      return ok(state);
    case 'STOP_HEAT':
      if (state.phase !== 'HEATING') return fail(state, 'VIOLATION', `STOP_HEAT illegal in phase ${state.phase}`);
      state.phase = 'COOLING';
      return ok(state);
    case 'OPEN_EXHAUST':
      if (state.phase === 'HEATING') {
        const p = state.sensors.PRESSURE;
        if (p === 'UNKNOWN') return fail(state, 'UNKNOWN', 'OPEN_EXHAUST while PRESSURE ack unknown: blocked, cannot prove safe');
        if (p !== 'OK') return fail(state, 'VIOLATION', `OPEN_EXHAUST during HEATING before pressure reached (PRESSURE=${p})`);
        state.phase = 'VENTING';
        return ok(state);
      }
      if (state.phase === 'COOLING' || state.phase === 'VENTING') {
        state.phase = 'VENTING';
        return ok(state);
      }
      return fail(state, 'VIOLATION', `OPEN_EXHAUST illegal in phase ${state.phase}`);
    case 'OPEN_DOOR': {
      const p = state.sensors.PRESSURE;
      if (p === 'UNKNOWN') return fail(state, 'UNKNOWN', 'OPEN_DOOR while PRESSURE ack unknown: blocked, cannot prove safe');
      if (p !== 'ZERO') return fail(state, 'VIOLATION', `OPEN_DOOR under pressure (PRESSURE=${p})`);
      state.phase = 'IDLE';
      return ok(state);
    }
    default:
      return fail(state, 'VIOLATION', `unknown command ${name}`);
  }
}

function applyAck(state, sensor, value) {
  const cause = ACK_CAUSE[sensor];
  if (!cause) return fail(state, 'VIOLATION', `ack for unknown sensor ${sensor}`);
  if (!state.issued.includes(cause)) {
    return fail(state, 'VIOLATION', `ack ${sensor} has no causal antecedent ${cause}: history not linearizable`);
  }
  state.sensors[sensor] = value;
  return ok(state);
}

// 单步执行; 不修改入参。
export function step(state, event) {
  const next = clone(state);
  if (event.type === 'cmd') return applyCmd(next, event.name);
  if (event.type === 'ack') return applyAck(next, event.sensor, event.value);
  return fail(next, 'VIOLATION', `unknown event type ${event.type}`);
}

// 依记录顺序做线性化核验(含 cmd/ack 因果), 汇总判定。
export function evaluate(history) {
  let state = createMachine();
  let verdict = 'SAFE';
  let violationIndex = -1;
  let violationReason = null;
  const steps = [];
  for (let i = 0; i < history.length; i++) {
    const r = step(state, history[i]);
    state = r.state;
    steps.push({ status: r.status, reason: r.reason });
    if (r.status === 'VIOLATION') {
      if (verdict !== 'VIOLATION') {
        verdict = 'VIOLATION';
        violationIndex = i;
        violationReason = r.reason;
      }
    } else if (r.status === 'UNKNOWN' && verdict === 'SAFE') {
      verdict = 'UNKNOWN';
    }
  }
  return {
    verdict,
    safeState: {
      phase: state.phase,
      sensors: { ...state.sensors },
      isSafe: verdict === 'SAFE',
    },
    violationIndex,
    violationReason,
    steps,
  };
}

// 最小违例序列: 使判定首次变为 VIOLATION 的最短前缀。
export function minimalViolation(history) {
  const r = evaluate(history);
  if (r.verdict !== 'VIOLATION') return null;
  return history.slice(0, r.violationIndex + 1);
}
