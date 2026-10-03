# meta-rank

荟萃分析证据排名的增量维护库与 CLI。Node.js 22，仅标准库，全程离线。

## 模型

- **研究节点**：`{ weight, effect, active }`，通过 `study.upsert` / `study.retract` / `study.correct` 维护。
- **假声明节点**：`{ combinator: 'all' | 'any', refs: [{ kind: 'study' | 'hypothesis', id }] }`，可引用研究或其他声明。
  - `all`：全部引用可用时声明可用，可用研究为全部引用研究集的并集。
  - `any`：任一引用可用即可用，可用研究为可用引用研究集的并集。
- **候选假设总分**：可用研究中权重 > 0 者的加权平均 `Σw·e / Σw`。

## 约定结果

- **零权重**：权重为 0 的研究不参与加权平均，也不计入证书的纳入研究集合；若假设没有任何权重大于 0 的可用研究，则标记 `excluded`，不参与排名。
- **环**：引用边变更若引入环，操作被拒绝并返回 `E_CYCLE`，引擎状态保持不变。
- **全部撤回**：所有研究撤回后，相关假设全部 `excluded`，排名为空，证书中 `score`/`rank` 为 `null`。
- **同序号冲突**：重放按 `(seq, authorId)` 升序排序，再按操作的规范 JSON 序列升序；`(seq, authorId)` 相同的操作在报告中标记 `conflict: true`，仍按确定顺序应用（后写覆盖先写），任意到达顺序重放结果一致。
- **并列**：总分相同按假设 id 升序（数字先于字符串，各自按数值/字典序）。

## 增量维护

研究撤回、权重更正或引用边变更后，引擎沿反向依赖图定位受影响假设，仅对其重算，再由缓存分数维护排名。`rankDiff(before, after)` 给出最小排名差分（仅含排名或成员资格实际变化的假设）。

## 证书

`certificate(id)` 返回 `{ hypothesis, includedStudies, score, rank, excluded, hash }`，其中 `hash` 为前五个字段规范 JSON 的 SHA-256。

## CLI

```sh
node cli.js replay <ops.json|->            # 重放操作日志，输出排名/排除列表/证书/逐条报告
node cli.js certificate <ops.json> <id>    # 输出单个假设的证书
node cli.js diff <opsA.json> <opsB.json>   # 两份日志最终排名的最小差分
```

输出均为 JSON；错误以 JSON 写 stderr，退出码非 0。

操作类型：`study.upsert`、`study.retract`、`study.correct`、`hypothesis.set`、`hypothesis.remove`、`edge.add`、`edge.remove`，均带 `seq` 与 `authorId`。

## 测试

```sh
node --test
```

- `test/engine.test.js`：单元测试（加权平均、all/any、嵌套传播、增量更新、环、零权重、证书哈希、重放顺序）。
- `test/acceptance.test.js`：验收测试（≤6 假设 / ≤10 研究的随机场景与独立全量重算参考逐步对比；撤回关键研究后的最小排名差分与固定并列顺序；零权重、环、全部撤回、同序号冲突的约定结果）。
