# shift-archive

跨班次设备事件归档库与 CLI。Node.js 22,仅标准库,`node:test` 测试,单机离线。

## 模型

- 事件 `{id, ts, device, tokens}` 先写入**活动段**(可写,`active/events.jsonl`)。
- `freeze` 把活动段固化为**冻结段**(`frozen/seg-XXXXXX/`),冻结段用**共享字典**压缩
  存储 token;字典按版本不可变(`dict/dict-N.json`),旧冻结段永远引用旧版本,
  字典更新后仍可解码。
- 每个设备的事件流按段链顺序(冻结段按 manifest 顺序,再接活动段)拼接成全局
  token 位置流,因此短语与近邻查询可以**跨段边界**命中。

## 索引(两层)

- **活动层**:精确小索引,`token -> device -> [pos]`,查询时从活动事件即时构建。
- **冻结层**:倒排表按 16 条一块做 delta+varint **块压缩**,每块记录
  `skip = {last, count}` 构成**跳表**,解码时可按位置跳块。

## 查询规范化

- 短语:token 序列(小写、非字母数字切分)必须在流中**连续**出现。
- 近邻 `--near A,B,K`:同一设备流中 `|posA - posB| <= K`。
- 结果按 `(startTs, device, 事件序列字典序, start, end)` 排序。

## retention 与 merge

- `retain --before T` 打**墓碑**:`ts < T` 的事件对查询不可见(`ts == T` 保留),
  活动段立即物理清理,冻结段等 merge 时物理回收。
- `merge --from F --to T` 合并窗口完整覆盖的冻结段(≥2):新段先写入
  `.staging-*`,**原子提交点**是 manifest 的 tmp+rename;提交前崩溃(杀进程)
  旧窗口完整可用,暂存残留下次启动自动清理。

## CLI

```
node src/cli.js append --archive DIR --ts N --device NAME --tokens "a b c"
node src/cli.js freeze --archive DIR
node src/cli.js merge  --archive DIR --from N --to N
node src/cli.js retain --archive DIR --before N
node src/cli.js query  --archive DIR --phrase "a b c"
node src/cli.js query  --archive DIR --near A,B,K
node src/cli.js stats  --archive DIR
```

错误码(退出码 1,stderr 输出):`E_WINDOW`(窗口非法/为空/与冻结段重叠)、
`E_MERGE`(窗口内段数不足)、`E_RETAIN`(retention 窗口非法或已被覆盖)。

## 测试

```
node --test
```

- `test/enumeration.test.js`:枚举小事件流 × 全部冻结窗口划分,短语/近邻对照暴力 oracle
- `test/merge-crash.test.js`:merge 中途 SIGKILL 后旧窗口可用;成功 merge 原子替换
- `test/retain.test.js`:retain 边界 `ts == cutoff` 保留 / `ts < cutoff` 剔除
- `test/dict.test.js`:共享字典更新后旧冻结段仍可解码
- `test/index.test.js`:块压缩 + 跳表单测;`test/cli.test.js`:CLI 错误码
