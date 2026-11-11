网页采集SDK会收到GraphQL延迟字段和流式列表，请实现可导入的TypeScript结果合成组件。输入初始树与补丁，补丁带唯一ID、父补丁ID、路径及对象合并或列表插入操作；依赖未到先挂起，同ID内容不同报冲突。列表位置按父补丁完成后的版本解释，每个父补丁列出子补丁ID及序号，齐备后兄弟补丁按序号执行。调用方仅获取不可变已完成版本；终止时缺依赖必须报错。用深层嵌套、父补丁迟到及消费者保留旧版本的测试验证结果与顺序执行一致。

## 用法

组件入口为 `src/index.ts`，导出 `ResultAssembler` 及 `Patch`、`PatchConflictError`、`MissingDependencyError`、`PatchProtocolError` 等类型。

```ts
import { ResultAssembler } from "./src/index.js";

const assembler = new ResultAssembler(initialTree, {
  onVersion: (version, patchId) => { /* 每个已完成版本回调，版本已深度冻结 */ },
});

assembler.addPatch({
  id: "p1",
  parentId: null,                 // null 表示依赖初始树
  path: ["viewer", "feed"],       // 对象键用字符串，数组下标用非负整数
  op: { kind: "insert", index: 0, items: [item] },
  children: [{ id: "c1", seq: 1 }], // 声明子补丁及执行序号
});
assembler.addPatch({
  id: "c1",
  parentId: "p1",
  path: ["viewer"],
  op: { kind: "merge", value: { email: "a@x" } }, // 深合并对象
});

assembler.current;    // 最新已完成版本（不可变）
assembler.versions;   // 全部已完成版本（含初始版本）
assembler.pendingIds(); // 仍在挂起的补丁 ID
assembler.finalize(); // 流终止：有缺失依赖时抛 MissingDependencyError，否则返回最终版本
```

语义要点：
- 父补丁未完成的子补丁一律挂起；兄弟补丁在父补丁声明的子补丁全部到齐后，按 `seq` 升序执行，列表插入位置按父补丁完成后的版本解释。
- 同一 ID 重复到达且内容一致为幂等无操作；内容不同抛 `PatchConflictError`。
- 未在父补丁 `children` 中声明的子补丁、无法解析的路径、越界插入等抛 `PatchProtocolError`。
- 每个版本通过写时复制生成并深度冻结，消费者可安全保留任意旧版本。

构建与测试：`npm run build`、`npm test`（编译后用 `node --test` 运行 `test/assembler.test.ts`）。
