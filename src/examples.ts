import type { Program } from './simulator.js';

export interface Example {
  name: string;
  note: string;
  maxSteps: number;
  program: Program;
}

/**
 * 手写小例：覆盖微任务优先、微任务链式派生、定时器并列 FIFO、
 * 定时器回调内派生微任务、以及两种未闭合（预算耗尽）形态。
 */
export const examples: Example[] = [
  {
    name: 'micro-before-timer',
    note: '宏任务结束后先排空微任务，再取定时项：delay=0 的定时器也排在微任务之后。',
    maxSteps: 16,
    program: {
      main: (api) => {
        api.log('script');
        api.setTimeout('timer', 0);
        api.queueMicrotask('micro');
      },
      tasks: {
        micro: (api) => api.log('micro task'),
        timer: (api) => api.log('timer'),
      },
    },
  },
  {
    name: 'micro-chain',
    note: '微任务可继续派生微任务，同一检查点内全部排空，定时器 @5 最后执行。',
    maxSteps: 16,
    program: {
      main: (api) => {
        api.setTimeout('timer', 5);
        api.queueMicrotask('m1');
      },
      tasks: {
        m1: (api) => api.queueMicrotask('m2'),
        m2: (api) => api.queueMicrotask('m3'),
        m3: (api) => api.log('chain end'),
        timer: (api) => api.log('timer'),
      },
    },
  },
  {
    name: 'timer-tie-fifo',
    note: '触发时间相同的定时项按入队先后执行；更早的 @5 最先。',
    maxSteps: 16,
    program: {
      main: (api) => {
        api.setTimeout('a', 10);
        api.setTimeout('b', 10);
        api.setTimeout('c', 10);
        api.setTimeout('early', 5);
      },
      tasks: {
        a: (api) => api.log('a'),
        b: (api) => api.log('b'),
        c: (api) => api.log('c'),
        early: (api) => api.log('early'),
      },
    },
  },
  {
    name: 'micro-inside-timer',
    note: '定时器回调内派生的微任务立即在当前时间点排空，早于 @10 的下一个定时器。',
    maxSteps: 16,
    program: {
      main: (api) => {
        api.setTimeout('t1', 5);
        api.setTimeout('t2', 10);
      },
      tasks: {
        t1: (api) => {
          api.log('t1');
          api.queueMicrotask('m');
        },
        m: (api) => api.log('m between timers'),
        t2: (api) => api.log('t2'),
      },
    },
  },
  {
    name: 'unclosed-microtask-loop',
    note: '微任务自我派生永不闭合，步数预算 7 耗尽，返回 budget-exceeded。',
    maxSteps: 7,
    program: {
      main: (api) => api.queueMicrotask('spin'),
      tasks: {
        spin: (api) => api.queueMicrotask('spin'),
      },
    },
  },
  {
    name: 'unclosed-timer-chain',
    note: '定时器每拍自我重排（delay=1），预算 5 耗尽时仍有 1 个定时项挂起。',
    maxSteps: 5,
    program: {
      main: (api) => api.setTimeout('tick', 1),
      tasks: {
        tick: (api) => api.setTimeout('tick', 1),
      },
    },
  },
];
