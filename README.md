# stable-id-sequence

稳定 ID 游标序列库（TypeScript），语义契约：

- **稳定 ID 句柄**：元素句柄 = `{ id, gen }`（槽位 ID + 代际）。
- **墓碑删除**：`delete` 是逻辑删除；只要仍有游标保留该记录，记录留在链表中，
  因此**删除当前项后 `next()` 到达原后继**。
- **游标遍历**：游标锚定“当前记录”。**插入到锚点之前（含锚点处）不会被重访；
  插入到锚点之后会被后续 `next()` 访问**。
- **代际复用**：墓碑在保留计数归零时被摘除并回收槽位；**槽位再用时代际 +1**，
  旧代际句柄一律失效（`get` 返回 `undefined`，其余操作抛 `RangeError`）。
- **游标关闭**：`close()` 释放保留的记录，可能触发延迟回收。
- **事件日志**：`insert / delete / recycle / cursor-open / cursor-close`
  追加到 `store.events`，可与墓碑链表模型（`tests/model.ts`）逐条核验。

## 使用

```ts
import { SequenceStore } from "./src/sequence.ts";

const s = new SequenceStore<string>();
const ha = s.append("a");
s.append("b");
const cur = s.openCursor();
const first = cur.next()!;   // a
s.delete(first.handle);      // 删除当前项
cur.next();                  // => b（原后继）
cur.close();                 // 释放保留记录
```

## 测试

```sh
npm test   # tsc 类型检查 + 编译 + node:test（含与模型的随机一致性核验）
```
