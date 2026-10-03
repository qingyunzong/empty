# tx-history-chunks

交易更正与撤销的历史分块库及 CLI。Node.js 22,仅标准库 + `node:test`,零依赖。

## 功能

- `put` 建立交易(价格、数量),`replace` 更正价格或数量,`cancel` 撤销。
- 每次替换保留旧版本(追加式因果 DAG),`materialize` 按因果版本回放,
  计算当前有效交易并重新计算保证金冻结:`frozen = price * qty * 0.1`
  (撤销后为 0)。
- 修订记录持久化在分块(chunk)文件中,块内每条记录包含:修订内容、
  父修订哈希、作者序号、CRC32 校验;另有独立的偏移索引页(`index.idx`)。
- 并发历史判定(两个修订基于同一父版本):
  - 修改字段不相交 → 自动合并(`MERGED`);
  - 取消与字段修改并发 → 取消优先(`MERGED_CANCEL`),后继修改被拒绝;
  - 修改同一字段 → 保留并列头,返回 `CONFLICT`,后继写入被阻塞,
    必须显式 `resolve` 后才能生成后继。
- 参考实现(`src/reference.js`):对不超过 6 个修订枚举全部排列,
  校验最终头集合与胜出版本与顺序无关。
- 故障恢复:索引页删除/损坏时 `verify --rebuild` 依据父哈希反向链重建;
  若反向链也断裂,返回首个缺失版本(`firstMissing`)。

## CLI

```sh
node cli.js put         --tx T1 --price 100 --qty 5 --author alice [--dir ./txdata]
node cli.js replace     --tx T1 [--price 101] [--qty 6] [--base HASH] --author bob
node cli.js cancel      --tx T1 [--base HASH] --author carol
node cli.js resolve     --tx T1 [--price 101] [--qty 6] [--cancel] --author dave
node cli.js materialize --tx T1
node cli.js history     [--tx T1]
node cli.js verify      [--rebuild]
```

所有命令输出 JSON 到 stdout。退出码:`0` 成功(含自动合并),
`1` 错误(交易不存在、已撤销、索引损坏等),`2` 冲突(`CONFLICT` /
`UNRESOLVED_CONFLICT`)。

## 存储格式

```
<dir>/chunks/chunk-NNNNNN.bin   数据块(默认 1MB 滚动)
<dir>/index.idx                 偏移索引页(带 CRC32)
```

块内记录帧:`magic 'TXR1' | length u32 | crc32 u32 | payload(JSON)`。
索引页:`magic 'TXI1' | count u32 | entries(hash, chunk, offset, length) | crc32 u32`。

## 测试

```sh
node --test > result.txt 2>&1; echo $? >> result.txt
```
