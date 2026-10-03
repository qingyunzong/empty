# mrp-netreq

单机离线离散制造工单净需求核算库与 CLI。Node.js 22，仅标准库，测试使用 `node:test`。

## 数据模型

- 工单 `WORKORDER(id, product, qty)`
- BOM `BOM(parent, component, usage)`
- 库存 `INVENTORY(component, qty)`，`qty = null` 表示库存未知

净需求计算：先按关系代数（半朴素不动点 JOIN/UNION）展开多级 BOM 并聚合毛需求，
再左连接库存；库存未知（`null` 或缺行）时净需求为 `null`，绝不当作 0。

## CLI

```bash
node src/cli.js apply <ev.json> [--fail before_append|after_append] [--dir DIR]
node src/cli.js query [--dir DIR]
```

- 成功：stdout 输出 JSON，退出码 0。
- 失败：stdout 输出 `{"error":"..."}`，退出码 1。
- `query` 返回 `version`、`gross`/`inventory`/`net`、相对上一版本的正负增量
  `delta.{components,positive,negative}`，以及输入哈希证书 `hash`（事件日志的 SHA-256）。

## 事件格式

`ev.json` 为 `{"events":[...]}`（也接受单事件或数组）：

```json
{"op":"insert","entity":"workorder","key":{"id":"WO1"},"value":{"product":"P1","qty":5}}
{"op":"insert","entity":"bom","key":{"parent":"P1","component":"A"},"value":{"usage":2}}
{"op":"insert","entity":"inventory","key":{"component":"A"},"value":{"qty":null}}
{"op":"correct","entity":"inventory","key":{"component":"A"},"value":{"qty":0}}
{"op":"delete","entity":"workorder","key":{"id":"WO1"}}
```

每批事件作为一个新版本追加到仅追加日志 `data/events.log`（含旧值/新值），
随后原子写入快照 `data/snapshot.json`。更正按键撤销旧值；更正/删除未知键、
插入重复键均报错且无任何持久化影响。

## 故障点

- `--fail before_append`：追加前崩溃，退出后无任何影响。
- `--fail after_append`：日志已持久化但快照缺失；重启后 `query` 通过重放日志尾部恢复，
  并重建快照。

## 参考算法

`src/reference.js` 独立枚举全部 BOM 根到叶路径（默认上限 20 条，超出报错）并重算
毛/净需求，用于交叉核对关系代数引擎（`test/mrp.test.js`）。

## 测试与验收

```bash
node --test                  # 单元与场景测试
bash scripts/run_scenarios.sh  # 重新生成 result.txt（真实退出码/stdout/stderr）
```
