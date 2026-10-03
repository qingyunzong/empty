# 批次谱系追溯（lot-genealogy-trace）

单机离线质量批次正向/逆向追溯库与 CLI，仅依赖 Node.js 22 标准库。

## 模型

- 谱系边：`{ child, parent, quantity }`（parent 为上游投入批次，child 为下游产出批次）
- 检验记录：`{ lot, result, ts }`，`result ∈ pass | block | null`；`null` 或缺失表示未检，不隐式合格
- 批次 blocked ⟺ 自身或任一批量上游存在 block 记录；路径上只有未检记录时证书状态为 `uninspected`

## CLI

```sh
node bin/cli.js init   --state state.json [--data seed.json]
node bin/cli.js commit --state state.json --tx '{"id":"t1","kind":"edge","old":null,"new":{"child":"B","parent":"A","quantity":50}}'
node bin/cli.js commit --state state.json --tx '{"id":"t2","kind":"inspection","old":{"lot":"A","result":null,"ts":1},"new":{"lot":"A","result":"block","ts":2}}'
node bin/cli.js trace  --state state.json --lot D
node bin/cli.js undo   --state state.json --tx-id t2
```

- `commit` 以事务形式提交更正（旧边/新边 或 旧检验/新检验），生成新谱系版本
- `undo` 按事务 id 精确恢复原闭包与阻塞集合；不存在则报错；重复撤销幂等（`changed:false`，状态不变）
- `trace` 输出证书：根集合 `roots`、叶集合 `leaves`、阻塞记录集合 `blockedRecords`、`status`、`inputHash`

## 测试

```sh
node --test
```

测试含小规模参考算法（独立 DFS 枚举可达节点）与递归关系代数实现的交叉验证。
真实 CLI 运行结果见 `result.txt`。
