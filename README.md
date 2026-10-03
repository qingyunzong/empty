# plate-qc-incremental

酶标板实验质控的增量计算库及 CLI（Node.js 22，仅标准库 + `node:test`，全程离线）。

## 模型

- 孔位 `well:{plate}:{well}`：原始吸光度（源节点）。
- 对照 `ctrl:{plate}:neg|pos`：板级节点，引用阳性/阴性对照孔；未映射或映射孔缺失时报 `E_QC`。
- 阴性校正 `corr:{plate}:{well}` = 孔原始值 − 阴性对照值。
- 阳性比值 `ratio:{plate}:{well}` = （孔原始值 − 阴性） / （阳性 − 阴性）；分母为 0 时标记 `invalid`。
- 板均值 `mean:{plate}`：全板校正值的均值；空板报 `E_QC`。
- 复孔组 `rep:{group}:mean|cv`：引用孔位的校正值，给出均值与 CV（样本标准差/均值×100）。
  空组或成员孔缺失报 `E_QC`；单孔组 CV 报 `E_QC`（insufficient replicates）；CV 分母（均值）为 0 时标记 `invalid`。

`E_QC` 沿依赖边传播到所有下游节点。对照孔更正、孔位在复孔组间移动、板映射修改都会改写依赖边，引擎只重算受影响（脏标记闭包）的节点。

## 操作

`addPlate` / `removePlate` / `setWell` / `removeWell` / `setControl{kind:neg|pos}` /
`addGroup` / `removeGroup` / `addToGroup` / `removeFromGroup` / `moveWell{from,to}` /
`undo` / `redo`。撤销/恢复按操作栈处理；新操作清空 redo 栈。

## 证书

每次 `apply` 返回证书：`{ seq, op, recomputed, changed, invalid, errors }`。
`recomputed` 为实际重算的节点集合（排序），`changed` 为差分（节点删除记为 `null`），
`invalid`/`errors` 为操作后的全量快照，可与全量枚举参考实现逐项比对。

## CLI

```sh
echo '{"ops":[{"type":"addPlate","plate":"P1"}, ...]}' | node cli.js
```

输出每个操作的证书与最终状态快照；输入非法时退出码为 1。

## 测试

```sh
node --test
```

- `test/incremental-vs-reference.test.js`：两块板、每板 ≤8 孔的随机操作序列（含 undo/redo），
  逐步与全量枚举参考比较数值、invalid 集合与证书差分。
- `test/move-invalidation.test.js`：移动孔位后旧组与新组的最小失效集合。
- `test/edge-cases.test.js`：缺失对照、单孔复孔、CV 分母为 0、撤销后修改、空板等稳定状态。
- `test/cli.test.js`：CLI 端到端。
