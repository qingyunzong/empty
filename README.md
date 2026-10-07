# dairy-trace

乳品工厂质量追溯:谱系图 + CLI。某原料批复检不合格时,回答哪些成品批、
在途箱、客户工单受影响,并支持化验员更正后撤销。

Node.js 22,仅标准库,测试用 `node:test`。

## 模型

- **节点 = lot**:`raw | wip | finished | in_transit | customer_order`,
  带 `qty / time / frozen / failed`。
- **边**: `consume | split | merge | rework`,带 `qty / time`,
  `ratio = qty / from.qty`。
- **传播语义**(noisy-or):`p(source)=1`,
  `p(v) = 1 - Π(1 - p(u)·ratio(u,v))`。
  冻结批次(frozen)被计入受影响集合但**不再向下游传播**(库存冻结规则)。
- **守恒**:`split` 出边 ratio 之和 ≤ 1;`merge` 入边 qty 之和 = 目标批 qty
  (违反报 `ERR_CONSERVATION`);成环边报 `ERR_CYCLE` 且不污染状态/WAL。
- **最小召回证书**:受影响集合 = 恰好所有 `p ≥ threshold` 的批次。
  证书为每个批次给出最大概率见证路径;`verifyCertificate` 验证
  去掉任一被列批次后集合不再满足规则。

## 命令

```sh
node src/cli.js [--db DIR] add-lot  --id L --kind raw --qty 100 [--failed] [--frozen]
node src/cli.js [--db DIR] add-edge --id E --from A --to B --kind split --qty 50
node src/cli.js [--db DIR] impact   --lot L [--threshold 0.05]
node src/cli.js [--db DIR] correct  --edge E --qty 5     # 化验员更正,增量重算
node src/cli.js [--db DIR] undo | redo | snapshot
```

- `correct` 只增量重算该边下游锥(`stats.recomputed` 可观察),结果与全量
  重算(`impactFull`)一致。
- 每次变更是一个 WAL 事务(segment + index 两段写,各自 fsync)。
  故障点 = 写完 segment 未写 index;恢复时孤儿 segment 被截断,
  事务要么整批可见要么不可见。undo/redo 本身也是 WAL 记录,跨崩溃可恢复。
- 故障注入:`TRACE_CRASH_POINT=after_segment` 时进程在 segment 落盘、
  index 未写处 `SIGKILL` 自杀(仅用于测试)。

## 测试

```sh
node --test
```

- `test/impact.test.js`  — 20 批随机图对照独立 DFS 参考;最小召回证书;冻结阻断
- `test/cycle.test.js`   — 环边 `ERR_CYCLE` 且不污染状态/WAL/undo 栈
- `test/correct.test.js` — 更正拆分比例:增量 == 全量重算,undo/redo 恢复;守恒约束
- `test/crash.test.js`   — `kill -9` 于故障点后重启,结果确定;undo/redo 日志跨崩溃
