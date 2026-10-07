# vm-snapshot

虚拟机快照库:把 VM 堆中的对象图序列化为 JSON 文档,并能原子地恢复。

## 特性

- **对象图序列化**:保留共享引用、循环(互环/自环)与稳定对象 ID。
- **两阶段加载**:先为所有对象建壳(阶段一),再逐字段连边(阶段二),
  因此前向引用与环都能正确还原。
- **坏引用拒绝整图**:加载前对整份文档做完整校验(结构、ID 唯一性、
  字段值、引用完整性),任何悬空引用都抛出 `BadReferenceError`,整图被拒绝。
- **值类型**:整数(安全整数范围)与字节串(base64 编码),以及对象引用。
- **往返同构核验**:`verifyRoundTrip` 序列化→加载→图同构断言;
  `areIsomorphic` 用指纹剪枝 + 回溯搜索判断两堆是否图同构(ID 可不同)。
- **故障不污染旧堆**:`VM.restore` 在独立新堆上完成校验与加载,
  任何字段级故障都在提交前抛出,旧堆保持不变;`Heap.setField`
  同样先校验后写入。

## 使用

```ts
import { VM, intValue, bytesValue, refValue, verifyRoundTrip } from "./src/index.js";

const vm = new VM();
vm.heap.allocate(1);
vm.heap.allocate(2);
vm.heap.setField(1, "count", intValue(42));
vm.heap.setField(1, "blob", bytesValue(new Uint8Array([1, 2, 3])));
vm.heap.setField(1, "next", refValue(2));
vm.heap.setField(2, "next", refValue(1)); // 循环

const json = vm.snapshotString(); // 序列化
verifyRoundTrip(vm.heap);         // 往返同构核验

const vm2 = new VM();
vm2.restoreString(json);          // 原子恢复;失败时 vm2 旧堆不变
```

## 测试

```sh
npm test   # tsc 编译后运行 node:test 测试(19 个用例)
```

## 快照格式

```json
{
  "format": "vm-snapshot/1",
  "objects": [
    { "id": 1, "fields": {
      "count": { "t": "int", "v": 42 },
      "blob":  { "t": "bytes", "v": "AQID" },
      "next":  { "t": "ref", "id": 2 }
    }}
  ]
}
```
