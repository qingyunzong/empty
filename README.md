# tradehist

交易更正与撤销的历史分块库及 CLI（Node.js 22，仅标准库 + node:test）。

## 模型

- `put` 建立交易（price/quantity），`replace` 更正价格或数量，`cancel` 撤销。
- 每次修订（revision）都作为新版本追加到块存储，旧版本永久保留。
- 修订记录包含：哈希、父修订哈希列表、作者及作者序号（seq）、变更字段、CRC32；
  数据块 `data.blk` 为 `[magic][len][crc32][json]` 记录序列，`index.json` 保存哈希→偏移索引与各交易的头集合。
- `materialize` 按因果版本重放，计算当前有效交易并重新计算保证金冻结
  （`frozen = price * quantity * 0.1`，已撤销则为 0）。

## 并发历史判定

- 两个修订基于同一父版本时不直接覆盖：
  - 修改字段不相交 → 自动生成 merge 修订（双亲），退出 0，`status: "merged"`；
  - 修改同一字段 → 保留并列头，返回 `CONFLICT`，退出 2；后继 replace/cancel 被拒绝，
    必须 `resolve --winner <hash>` 显式解决。
- 取消与字段修改冲突时取消优先：并发 cancel 自动合并为已撤销；交易撤销后的修改被拒绝（退出 1）。
- 参考实现（`src/reference.js`）对不超过 6 个修订枚举所有因果排列，
  校验最终头集合与胜出版本一致（`reference.deterministic`）。

## 故障恢复

- `verify` 校验每条记录的 magic/长度/CRC32/哈希，并比对索引页。
- 索引页删除或损坏但数据块完好：`verify --rebuild` 扫描数据块、沿反向链重建偏移索引与头集合。
- 反向链断裂：返回 `BROKEN_CHAIN` 及首个缺失版本哈希，退出 1。

## CLI

```sh
node cli.js put         --id T1 --price 100 --qty 10 --author alice [--store DIR]
node cli.js replace     --id T1 [--base HASH] [--price P] [--qty Q] [--store DIR]
node cli.js cancel      --id T1 [--base HASH] [--store DIR]
node cli.js resolve     --id T1 --winner HASH [--price P] [--qty Q] [--store DIR]
node cli.js materialize --id T1 [--store DIR]
node cli.js history     --id T1 [--store DIR]
node cli.js verify      [--rebuild] [--store DIR]
```

所有输出为 JSON。退出码：0 成功，1 错误（含数据损坏、链断裂、撤销后修改），2 冲突。

## 测试

```sh
node --test > result.txt 2>&1; echo $? >> result.txt
```
