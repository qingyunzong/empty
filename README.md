# snapshot-vm

整数栈虚拟机库（TypeScript）：算术指令、条件/无条件跳转、带调用栈的函数调用、
定长堆读写、`yield` 挂起/恢复，以及完整快照（pc、操作数栈、调用栈、堆、输出）。

## 特性

- **快照/恢复**：`snapshot()` 深拷贝全部状态，`restore()` 校验后恢复；
  恢复后继续执行的输出与终态和不停顿执行完全一致。
- **错误原子性**：非法跳转、栈下溢、除零、堆越界、空调用栈 `ret`
  均在任何状态修改之前校验，抛错后 VM 状态保持不变。
- **快照校验**：`restore()` 拒绝 pc/returnPc 非指令边界、堆大小不匹配、
  帧 base 越界等非法快照，且不改变当前状态。

## 使用

```ts
import { VM } from "./src/vm";

const vm = new VM(program);
while (vm.run() === "yielded") {
  const snap = vm.snapshot(); // 可在任意指令边界保存
  // vm.restore(snap) 之后继续执行，输出与不停顿执行相同
}
console.log(vm.getOutput());
```

## 测试

```sh
npm test   # tsc 编译后运行 node:test，含全指令边界保存/恢复核验
```
