# stable-cursor-sequence

一个带稳定 ID 游标遍历的 TypeScript 序列库。

## 语义

- **稳定 ID**：每个元素获得 `"<slot>:<generation>"` 形式的 ID，在元素存活期间不变。
- **删除当前项**：游标当前元素被删除后，其记录作为墓碑保留，`next()` 落到原后继元素。
- **插入可见性**：插入到游标位置之前的元素不会被重访；插入到游标之后的元素会按序访问到。
- **代际 ID**：槽位被复用时代际号递增，过期 ID（旧代际）会被检测并抛出 `stale or unknown id`。
- **游标关闭**：`close()` 释放游标保留的墓碑记录（引用计数归零时物理摘除并发出 `unlink` 事件）。
- **事件流**：所有可观察步骤（`open` / `visit` / `end` / `close` / `insert` / `remove` / `unlink`）
  通过 `onEvent` 回调上报，可与参考模型逐步核验。

## 用法

```ts
import { Sequence } from "./src/sequence.ts";

const seq = new Sequence<string>({ onEvent: (e) => console.log(e) });
const a = seq.append("a");
const b = seq.append("b");

const cur = seq.cursor();   // 从头之前开始；seq.cursor(b) 则从 b 之后继续
cur.next();                 // { done: false, id: a, value: "a" }
seq.remove(a);              // 删除当前项：记录作为墓碑保留
cur.next();                 // { done: false, id: b, value: "b" } —— 原后继
cur.close();                // 释放保留记录
```

## 测试

```sh
npm test
```

`npm test` 先用 `tsc` 编译到 `dist/`，再用 Node 内置测试运行器执行
`test/sequence.test.ts`。测试包含两部分：

1. 针对上述每条语义的单元测试（含精确的期望事件序列）。
2. 随机化差分测试：以多个固定种子生成操作流，同时驱动实现与
   `test/model.ts` 中带墓碑的链表参考模型，逐步断言两边的事件序列、
   访问结果、存活 ID 序列与墓碑计数完全一致。

其他脚本：`npm run build`（仅编译）、`npm run typecheck`（仅类型检查）、
`npm run test:only`（跳过编译直接跑 `dist/` 中的测试）。
