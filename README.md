# delta-merge-library

订阅合并库（TypeScript + Node.js 内置库，零运行时依赖）：

- **版本差量接收**：每项差量声明父版本（`parentId`），携带 payload 与 sha256 摘要；
- **父缺失缓冲**：父版本未到达时进入缓冲，父到达后自动落图（含孙代递归冲刷）；
- **多分支不强行线性化**：一个父版本可有多个子版本，`heads()` 列出全部分支头；
- **查询必须指定分支头**：`query(headId)` / `mergeState(headId)` 沿根→头路径返回差量序列 / 合并状态，缺参或未知头即抛错；
- **坏摘要隔离**：摘要不匹配的版本记为 `quarantined`，其后继（含乱序后补到的）一并记为 `isolated`，均不可查询、不占分支头；
- **乱序重放对照**：`MergeLibrary.replay()` 支持任意到达顺序，`snapshot()` 与到达顺序无关，`MergeLibrary.equivalent()` 可对照乱序重放与完整版本图构建是否等价。

## 使用

```ts
import { makeDelta } from "./src/delta.js";
import { MergeLibrary } from "./src/merge-library.js";

const lib = new MergeLibrary();
lib.ingest(makeDelta("root", null, { rev: 0 }));
lib.ingest(makeDelta("a1", "root", { rev: 1 }));
lib.ingest(makeDelta("b1", "root", { rev: 1, draft: true })); // 第二分支

lib.heads();               // ["a1", "b1"]
lib.query("a1");           // 根 -> a1 的差量路径
lib.mergeState("b1");      // { rev: 1, draft: true }
```

## 测试

```sh
npm test   # tsc 编译 + node --test
```

实际结果见 [TEST_RESULTS.md](./TEST_RESULTS.md)。
