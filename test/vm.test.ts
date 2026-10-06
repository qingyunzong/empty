import { test, describe } from "node:test";
import * as assert from "node:assert/strict";
import { VM, VmError, Instruction, Snapshot, VmErrorCode } from "../src/vm";

/** 递归阶乘：fact(5) = 120，验证调用栈与 ret 的栈恢复约定 */
const factProgram: Instruction[] = [
  /* 0 */ { op: "push", value: 5 },
  /* 1 */ { op: "call", target: 4, arity: 1 },
  /* 2 */ { op: "out" },
  /* 3 */ { op: "halt" },
  // fact(n):
  /* 4 */ { op: "dup" },
  /* 5 */ { op: "jz", target: 12 },
  /* 6 */ { op: "dup" },
  /* 7 */ { op: "push", value: 1 },
  /* 8 */ { op: "sub" },
  /* 9 */ { op: "call", target: 4, arity: 1 },
  /* 10 */ { op: "mul" },
  /* 11 */ { op: "ret" },
  // base: n == 0 -> 1
  /* 12 */ { op: "pop" },
  /* 13 */ { op: "push", value: 1 },
  /* 14 */ { op: "ret" },
];

/** 混合程序：堆读写 + 调用 + yield。输出 [26] */
const mixedProgram: Instruction[] = [
  /* 0 */ { op: "push", value: 10 },
  /* 1 */ { op: "store", addr: 0 }, // heap[0] = 10
  /* 2 */ { op: "push", value: 3 },
  /* 3 */ { op: "call", target: 8, arity: 1 }, // f(3)
  /* 4 */ { op: "load", addr: 0 },
  /* 5 */ { op: "add" },
  /* 6 */ { op: "out" },
  /* 7 */ { op: "halt" },
  // f(x) = x * 2 + heap[0]，中间 yield 一次
  /* 8 */ { op: "dup" },
  /* 9 */ { op: "push", value: 2 },
  /* 10 */ { op: "mul" },
  /* 11 */ { op: "yield" },
  /* 12 */ { op: "load", addr: 0 },
  /* 13 */ { op: "add" },
  /* 14 */ { op: "ret" },
];

/** 循环输出 1..5，每轮 yield 一次 */
const yieldProgram: Instruction[] = [
  /* 0 */ { op: "push", value: 0 },
  /* 1 */ { op: "push", value: 1 },
  /* 2 */ { op: "add" },
  /* 3 */ { op: "dup" },
  /* 4 */ { op: "out" },
  /* 5 */ { op: "yield" },
  /* 6 */ { op: "dup" },
  /* 7 */ { op: "push", value: 5 },
  /* 8 */ { op: "sub" },
  /* 9 */ { op: "jnz", target: 1 },
  /* 10 */ { op: "pop" },
  /* 11 */ { op: "halt" },
];

function runToHalt(vm: VM): void {
  while (vm.run() === "yielded") {
    // 继续恢复执行
  }
}

function expectErrorUnchanged(vm: VM, code: VmErrorCode, act: () => unknown): void {
  const before = vm.snapshot();
  assert.throws(act, (err: unknown) => err instanceof VmError && err.code === code);
  assert.deepEqual(vm.snapshot(), before, `state must be unchanged after ${code}`);
}

/** 推进 vm 到出错指令前一条，再核验单步抛错且状态不变 */
function expectStepErrorUnchanged(vm: VM, code: VmErrorCode, preSteps: number): void {
  for (let i = 0; i < preSteps; i += 1) vm.step();
  expectErrorUnchanged(vm, code, () => vm.step());
}

describe("基本指令", () => {
  test("算术与输出", () => {
    const vm = new VM([
      { op: "push", value: 7 },
      { op: "push", value: 3 },
      { op: "sub" }, // 4
      { op: "push", value: 6 },
      { op: "mul" }, // 24
      { op: "out" },
      { op: "push", value: 17 },
      { op: "push", value: 5 },
      { op: "div" }, // 3
      { op: "out" },
      { op: "push", value: 17 },
      { op: "push", value: 5 },
      { op: "mod" }, // 2
      { op: "neg" }, // -2
      { op: "out" },
      { op: "halt" },
    ]);
    assert.equal(vm.run(), "halted");
    assert.deepEqual(vm.getOutput(), [24, 3, -2]);
  });

  test("递归调用与调用栈", () => {
    const vm = new VM(factProgram);
    runToHalt(vm);
    assert.deepEqual(vm.getOutput(), [120]);
    assert.deepEqual(vm.snapshot().callStack, []);
  });

  test("堆读写", () => {
    const vm = new VM([
      { op: "push", value: 42 },
      { op: "store", addr: 7 },
      { op: "load", addr: 7 },
      { op: "out" },
      { op: "halt" },
    ]);
    runToHalt(vm);
    assert.deepEqual(vm.getOutput(), [42]);
    assert.equal(vm.snapshot().heap[7], 42);
  });
});

describe("yield 与快照恢复", () => {
  test("yield 恢复后输出与不停顿执行相同", () => {
    const yielding = new VM(yieldProgram);
    const chunks: string[] = [];
    for (;;) {
      chunks.push(yielding.run());
      if (yielding.isHalted) break;
    }
    assert.equal(chunks.filter((c) => c === "yielded").length, 5);
    assert.deepEqual(yielding.getOutput(), [1, 2, 3, 4, 5]);
  });

  test("快照包含 pc、调用栈与堆，恢复后继续执行结果一致", () => {
    const vm = new VM(mixedProgram);
    // 执行到函数体内 yield 处（此刻调用栈与堆均非空）
    assert.equal(vm.run(), "yielded");
    const snap = vm.snapshot();
    assert.ok(snap.callStack.length > 0, "yield 时调用栈应非空");
    assert.equal(snap.heap[0], 10);
    assert.equal(snap.pc, 12);

    const restored = new VM(mixedProgram);
    restored.restore(snap);
    runToHalt(restored);

    const straight = new VM(mixedProgram);
    runToHalt(straight);
    assert.deepEqual(restored.getOutput(), straight.getOutput());
    assert.deepEqual(restored.snapshot(), straight.snapshot());
  });

  test("所有指令边界保存/恢复核验：任意步数快照恢复后输出与终态相同", () => {
    for (const [name, program] of [
      ["fact", factProgram],
      ["mixed", mixedProgram],
      ["yield", yieldProgram],
    ] as const) {
      // 基线：单步执行到底，记录总步数与终态
      const baseline = new VM(program);
      let steps = 0;
      while (!baseline.isHalted) {
        baseline.step();
        steps += 1;
      }
      const baselineSnap = baseline.snapshot();

      // 在每个指令边界保存快照，恢复到全新 VM 后继续执行
      for (let k = 0; k <= steps; k += 1) {
        const prefix = new VM(program);
        for (let i = 0; i < k; i += 1) prefix.step();
        const snap = prefix.snapshot();

        const restored = new VM(program);
        restored.restore(snap);
        runToHalt(restored);

        assert.deepEqual(
          restored.snapshot(),
          baselineSnap,
          `${name}: 在第 ${k} 条指令边界恢复后终态应与不停顿执行相同`,
        );
      }
    }
  });

  test("快照是深拷贝，外部修改不影响 VM", () => {
    const vm = new VM(mixedProgram);
    vm.run();
    const snap = vm.snapshot();
    const before = vm.snapshot();
    snap.stack.push(999);
    snap.heap[0] = 999;
    snap.callStack.pop();
    snap.output.push(999);
    snap.pc = 0;
    assert.deepEqual(vm.snapshot(), before);
  });
});

describe("错误不改变状态", () => {
  test("非法跳转目标（越界 / 负数 / 非整数）", () => {
    for (const target of [99, -1, 1.5, NaN]) {
      const vm = new VM([{ op: "jmp", target }, { op: "halt" }]);
      expectErrorUnchanged(vm, "ILLEGAL_JUMP", () => vm.step());
    }
    // 条件跳转同样先校验目标
    const vm = new VM([{ op: "push", value: 0 }, { op: "jz", target: 42 }, { op: "halt" }]);
    expectStepErrorUnchanged(vm, "ILLEGAL_JUMP", 1);
  });

  test("栈下溢：二元运算 / pop / dup / out / store / 条件跳转", () => {
    const cases: Array<[program: Instruction[], preSteps: number]> = [
      [[{ op: "add" }, { op: "halt" }], 0],
      [[{ op: "push", value: 1 }, { op: "mul" }, { op: "halt" }], 1],
      [[{ op: "pop" }, { op: "halt" }], 0],
      [[{ op: "dup" }, { op: "halt" }], 0],
      [[{ op: "out" }, { op: "halt" }], 0],
      [[{ op: "store", addr: 0 }, { op: "halt" }], 0],
      [[{ op: "jz", target: 1 }, { op: "halt" }], 0],
      [[{ op: "neg" }, { op: "halt" }], 0],
    ];
    for (const [program, preSteps] of cases) {
      const vm = new VM(program);
      expectStepErrorUnchanged(vm, "STACK_UNDERFLOW", preSteps);
    }
  });

  test("ret 时调用栈为空", () => {
    const vm = new VM([{ op: "push", value: 1 }, { op: "ret" }, { op: "halt" }]);
    expectStepErrorUnchanged(vm, "CALL_STACK_UNDERFLOW", 1);
  });

  test("除零与堆越界", () => {
    const divZero = new VM([
      { op: "push", value: 1 },
      { op: "push", value: 0 },
      { op: "div" },
      { op: "halt" },
    ]);
    expectStepErrorUnchanged(divZero, "DIVIDE_BY_ZERO", 2);

    const oob = new VM([{ op: "load", addr: 1000 }, { op: "halt" }], 8);
    expectStepErrorUnchanged(oob, "HEAP_OUT_OF_BOUNDS", 0);

    const oobStore = new VM([{ op: "push", value: 1 }, { op: "store", addr: -1 }, { op: "halt" }], 8);
    expectStepErrorUnchanged(oobStore, "HEAP_OUT_OF_BOUNDS", 1);
  });

  test("停机后拒绝继续执行", () => {
    const vm = new VM([{ op: "halt" }]);
    vm.run();
    expectErrorUnchanged(vm, "HALTED", () => vm.step());
  });
});

describe("快照校验", () => {
  const validSnap = (): Snapshot => ({
    pc: 0,
    stack: [1],
    callStack: [{ returnPc: 1, base: 0 }],
    heap: [0, 0],
    output: [],
    halted: false,
  });

  test("非法快照被拒绝且不改变 VM 状态", () => {
    const program: Instruction[] = [{ op: "halt" }, { op: "halt" }];
    const invalid: Snapshot[] = [
      { ...validSnap(), pc: -1 },
      { ...validSnap(), pc: 3 }, // 超出程序长度
      { ...validSnap(), pc: 0.5 },
      { ...validSnap(), heap: [0] }, // 堆大小不匹配
      { ...validSnap(), callStack: [{ returnPc: 99, base: 0 }] },
      { ...validSnap(), callStack: [{ returnPc: 1, base: 5 }] }, // base 超过栈深
    ];
    for (const snap of invalid) {
      const vm = new VM(program, 2);
      expectErrorUnchanged(vm, "INVALID_SNAPSHOT", () => vm.restore(snap));
    }
  });

  test("合法快照可恢复", () => {
    const vm = new VM([{ op: "halt" }, { op: "halt" }], 2);
    vm.restore(validSnap());
    assert.deepEqual(vm.snapshot(), validSnap());
  });
});
