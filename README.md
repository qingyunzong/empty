# recall-trace

产品召回追溯库与 CLI。Node.js 22，仅标准库与 node:test，离线单机运行。

## 模型

- **批次**：`{id, localStart, localEnd, shelfLife, packaging}`，工厂本地生产区间 `[localStart, localEnd)`、保质期长度、包装封存期长度（均为毫秒，非负）。
- **转换表**：`[{local, utc}, ...]`，分段常数偏移，把本地时刻映射为 UTC。保质期窗口为 `[endUtc, endUtc+shelfLife)`，包装封存窗口为 `[endUtc, endUtc+packaging)`。
- **谱系记录**：`{id, inputs:[batchId...], output: batchId}`；`correct` 以同 id 生成新版本，旧快照保留旧版本。
- **快照**：`snapshot` 保存状态副本；`rollback` 把当前状态恢复到命名快照，但不修改任何已存快照；查询始终基于命名快照。
- **区间集合**：左闭右开 `[start, end)`，支持并/交/差；仅端点接触（如 `[0,5)` 与 `[5,10)`）不算命中，跨越 1ms 即命中。

## CLI

```
node src/cli.js [input.json]     # 省略文件时从 stdin 读取
```

输入：`{conversion: [...], ops: [...]}`，`ops` 为操作日志：`batch` / `record` / `correct` / `snapshot` / `rollback` / `query`。输出 `{results: [...]}`，每个操作一条结果；查询结果含 `affected` 数组，每项含命中输入区间 `hitIntervalUtc`、包装命中区间与路径证书 `certificates`（含快照名、记录版本路径与 sha256 摘要）。

错误以 `{error: {code, message}}` 返回：`ERR_UNKNOWN_SNAPSHOT`（快照未知）、`ERR_INTERVAL_REVERSED`（区间反转）、`ERR_NEGATIVE_SHELF_LIFE`（保质期为负）等。

示例见 `examples/recall-demo.json`。

## 测试

```
node --test
```

验收场景：三层合流批次部分成品保质期命中；端点接触排除、跨越 1ms 命中；快照回滚后新旧结果并存，并以枚举全部谱系路径的参考算法交叉校验。真实结果写入 `test-results.txt`。
