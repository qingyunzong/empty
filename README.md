# export-linker

模块导出链接器：合并**显式导出**、**星号导出**与**别名**，在含循环的模块图上做**逐轮全图合并**直至固定点，并输出每个导出的**来源路径**。

## 规则

- **显式优先**：本地导出（`local`）与再导出（`reexport`）优先于星号导出（`star`），同名时星号候选被覆盖。
- **别名**：`as` 改变对外导出名，绑定身份仍为 `定义模块#本地名`。
- **星号歧义**：同名来自**不同绑定**时报歧义且不导出该名；来自**同一绑定的多条路径**不歧义，保留较短路径。
- **循环模块**：每轮基于上一轮状态整体重算全图，状态单调有界故必收敛到固定点。

## 使用

```bash
npm test          # 编译并运行测试（tsc + node --test）
npm run build     # 仅编译到 dist/
node dist/src/cli.js graph.json   # 链接并打印各模块导出表
```

`graph.json` 为模块数组：

```json
[
  { "id": "a", "exports": [
    { "kind": "local", "name": "x", "as": "y" },
    { "kind": "reexport", "name": "x", "from": "b" },
    { "kind": "star", "from": "c" }
  ]}
]
```

输出形如 `export y <= a#x (path: a -> b -> c)`，歧义以 `! ambiguous` 报告。

## 核验

- `verifyFixedPoint(specs, result)`：对结果再做一轮全图合并，状态必须不变。
- `referenceLink(specs)`：参考实现（Gauss-Seidel 式就地迭代），与逐轮同步合并的最小不动点一致，测试中逐模块交叉核验。
- `link()` 返回的 `trace` 保存逐轮快照，测试断言其单调增长且末两轮相同。
