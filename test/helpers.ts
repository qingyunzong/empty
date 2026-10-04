import type { Program, ScheduleApi } from '../src/simulator.js';

/** 确定性伪随机数发生器（mulberry32），保证测试可复现。 */
export function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * 生成 DAG 型随机程序：label ti 只能派生 tj（j > i），
 * 保证有限步内闭合（预算足够时 status 必为 settled）。
 */
export function genDagProgram(seed: number): Program {
  const rand = mulberry32(seed);
  const pick = (n: number): number => Math.floor(rand() * n);
  const count = 3 + pick(6); // 3..8 个任务
  const labels = Array.from({ length: count }, (_, i) => `t${i}`);
  const tasks: Record<string, (api: ScheduleApi) => void> = {};

  labels.forEach((label, i) => {
    const higher = labels.slice(i + 1);
    const timerEffects: Array<{ label: string; delay: number }> = [];
    const microEffects: string[] = [];
    if (higher.length > 0) {
      for (let k = 0, n = pick(3); k < n; k += 1) {
        timerEffects.push({ label: higher[pick(higher.length)]!, delay: pick(16) });
      }
      for (let k = 0, n = pick(3); k < n; k += 1) {
        microEffects.push(higher[pick(higher.length)]!);
      }
    }
    tasks[label] = (api) => {
      api.log(`${label} ran`);
      for (const effect of timerEffects) api.setTimeout(effect.label, effect.delay);
      for (const micro of microEffects) api.queueMicrotask(micro);
    };
  });

  // 主脚本的效果在生成期一次性确定，保证程序体纯函数、可重复执行（可重放）。
  const mainTimerEffects: Array<{ label: string; delay: number }> = [];
  const mainMicroEffects: string[] = [];
  for (let k = 0, n = 1 + pick(3); k < n; k += 1) {
    mainTimerEffects.push({ label: labels[pick(count)]!, delay: pick(16) });
  }
  for (let k = 0, n = pick(3); k < n; k += 1) {
    mainMicroEffects.push(labels[pick(count)]!);
  }

  return {
    main: (api) => {
      api.log('main');
      for (const effect of mainTimerEffects) api.setTimeout(effect.label, effect.delay);
      for (const micro of mainMicroEffects) api.queueMicrotask(micro);
    },
    tasks,
  };
}

/**
 * 生成环型随机程序：每个任务都会自我派生微任务（外加随机定时器/微任务），
 * 永远不会自然闭合，必然走到 budget-exceeded 分支。
 */
export function genCyclicProgram(seed: number): Program {
  const rand = mulberry32(seed);
  const pick = (n: number): number => Math.floor(rand() * n);
  const count = 2 + pick(3); // 2..4 个任务
  const labels = Array.from({ length: count }, (_, i) => `c${i}`);
  const tasks: Record<string, (api: ScheduleApi) => void> = {};

  for (const label of labels) {
    const timerEffects: Array<{ label: string; delay: number }> = [];
    const microEffects: string[] = [];
    for (let k = 0, n = pick(3); k < n; k += 1) {
      timerEffects.push({ label: labels[pick(count)]!, delay: pick(5) });
    }
    for (let k = 0, n = pick(3); k < n; k += 1) {
      microEffects.push(labels[pick(count)]!);
    }
    tasks[label] = (api) => {
      api.queueMicrotask(label); // 自我派生，保证不闭合
      for (const effect of timerEffects) api.setTimeout(effect.label, effect.delay);
      for (const micro of microEffects) api.queueMicrotask(micro);
    };
  }

  const mainMicro = labels[pick(count)]!;
  const mainTimerEffects: Array<{ label: string; delay: number }> = [];
  for (let k = 0, n = pick(2); k < n; k += 1) {
    mainTimerEffects.push({ label: labels[pick(count)]!, delay: pick(5) });
  }

  return {
    main: (api) => {
      api.queueMicrotask(mainMicro);
      for (const effect of mainTimerEffects) api.setTimeout(effect.label, effect.delay);
    },
    tasks,
  };
}
