# stack-vm

可快照的整数栈虚拟机（TypeScript）。支持整数栈指令、过程调用、`yield` 挂起/恢复，
快照包含指令位置（pc）、调用栈与堆，恢复后输出与不停顿执行完全一致。

## 指令集

| 指令 | 语义 |
| --- | --- |
| `push n` / `pop` / `dup` / `swap` | 栈操作 |
| `add` `sub` `mul` `div` `mod` | 二元整数运算（`div` 截断取整） |
| `load addr` / `store addr` | 堆读写（未写过的单元读出 0） |
| `jmp t` / `jz t` | 无条件 / 弹栈为零跳转 |
| `call t` / `ret` | 调用（返回地址入调用栈）/ 返回 |
| `emit` | 弹栈追加到输出 |
| `yield` / `halt` | 挂起（可恢复）/ 停机 |

## API

- `new VM(program)`：构造虚拟机。
- `vm.step()`：执行一条指令；出错抛 `VmError` 且**状态不变**（非法跳转目标、
  栈/调用栈下溢、除零等均先校验后变更）。
- `vm.run()`：运行到 `yield` 或 `halt`，返回 `'yielded' | 'halted'`；再次调用即恢复。
- `vm.runToCompletion()`：一路运行（自动越过 yield）直到停机，返回输出。
- `vm.snapshot()`：返回可 JSON 序列化的快照 `{ pc, stack, callStack, heap, output, halted, yielded }`。
- `VM.restore(program, snapshot)`：从快照恢复出等价虚拟机。

## 测试

```sh
npm test
```

测试覆盖：算术/调用/堆/yield 程序的正确性；对三个程序在**每一条指令边界**
打快照、JSON 往返、恢复后运行到停机，最终状态与不停顿执行完全一致；
以及非法跳转、栈下溢、空调用栈 `ret`、除零等错误不改变虚拟机状态。
