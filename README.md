# clearing-netting

清算所多机构净额轧差引擎：指令（instruction）→ 机构余额（balance）→ 净额批次（batch）
的增量依赖图，支持指令持续追加、撤销、替换时的差分更新与审计证书，无需全量重算。
仅使用 Node.js 22 标准库。

## 设计

- `src/graph.js` — 增量依赖图：动态拓扑（加/删节点与边）、加边时环检测、
  失效沿边传播、`sync()` 按拓扑序只重算脏节点。
- `src/ledger.js` — 清算语义：指令版本幂等（同版本同内容 no-op、同版本冲突报错、
  低版本忽略、高版本替换）；撤销/替换已入批指令生成反向分录并保留原哈希；
  金额为整数分，求和溢出即 `OVERFLOW` 错误并整体回滚；每事件输出哈希链证书，
  确定性重算与朴素全量（`naiveNets()`）一致。
- `src/store.js` — 崩溃安全持久化：journal 追加 + fsync；批次文件写 tmp、fsync、
  原子 rename；启动时清理残留 `*.tmp`、截断撕裂的日志尾、剔除无日志引用的批次文件。
- `bin/clearing.js` — CLI：stdin 读 JSONL 事件，每事件后 stdout 输出
  `{seq, nets, certificate, batch}`，错误写 stderr 并以码 2 退出。

## 事件

```json
{"type":"add_institution","id":"A"}
{"type":"submit","id":"i1","version":1,"from":"A","to":"B","amount":100}
{"type":"revoke","id":"i1"}
{"type":"depends","from":"A","to":"B"}
{"type":"undepends","from":"A","to":"B"}
{"type":"commit"}
```

`amount` 为整数分（正安全整数）；`depends` 构成机构间依赖边，成环即拒绝（`CYCLE`）。

## 运行

```sh
printf '%s\n' \
  '{"type":"add_institution","id":"A"}' \
  '{"type":"add_institution","id":"B"}' \
  '{"type":"submit","id":"i1","version":1,"from":"A","to":"B","amount":100}' \
  '{"type":"commit"}' \
  '{"type":"revoke","id":"i1"}' \
  | node bin/clearing.js --state /tmp/clearing-state
```

## 测试

```sh
node --test
```

覆盖：撤销后恢复与反向分录原哈希、循环依赖拒绝（库与 CLI 退出码 2）、
随机小规模与枚举全量对照朴素重算、整数分溢出回滚、
以及故障点（写批次文件中途 kill）重启后不出现半批次。
