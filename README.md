# settlement-index

商户结算凭证的可持久化检索库。Node.js 22 标准库实现，单机离线，无第三方依赖。

## 数据模型

JSONL 每行一条记录：`{id, merchant, amount, tags, text, status}`。
`text` 按 Unicode 字母/数字分词（小写）建立**位置索引**。

## 查询语义

- 精确短语：`slop = 0`（默认）。
- 有序近邻：词项位置 `p1 < p2 < ... < pk`，当 `(pk - p1) - (k-1) <= slop` 时命中。
- 返回：命中文档（含 `amount`）、命中词位置窗口、证书
  `{indexVersion, query:{phrase, slop, terms}, liveCount, liveSha256}`，
  其中 `liveSha256` 为全部存活记录（按 id 排序、键序稳定）的 SHA-256。

## 存储与一致性

- `records.jsonl`：追加式操作日志（add / del / restore），为事实源。
- `segment-N.bin`：派生索引快照。头部 JSON（文档、墓碑、词项表）+
  位置块（varint + 差值编码的二进制，可逆，**不存 JSON 位置数组**）。
- `COMMIT`：提交标记，指向当前段与日志偏移。
- 提交流程：写 `segment-N.tmp` → fsync → 原子 rename → 写 `COMMIT.tmp` →
  fsync → 原子 rename。提交前退出时，重启读取旧 `COMMIT`，回到旧索引；
  临时文件与未引用的孤儿段在启动时清理，不会出现半段。
- 删除写墓碑（tombstone），被撤销凭证不再命中；`restore` 恢复；
  日志重放保证增量删除在重启后仍然一致。

## CLI

```sh
node bin/cli.js add <dir> <file.jsonl|->     # 批量导入（损坏 JSON / 重复 id 整体拒绝）
node bin/cli.js delete <dir> <id>           # 撤销（写墓碑）
node bin/cli.js restore <dir> <id>          # 恢复
node bin/cli.js query <dir> --phrase "..." [--slop N]
node bin/cli.js decode <dir>                # 解码当前压缩段的位置索引
```

错误约定：退出码 1，stderr 输出 `{"error": "...", "code": "..."}`，
且存储状态不变。错误码：`UNKNOWN_ID`、`INVALID_SLOP`、`CORRUPT_JSON`、
`DUPLICATE_ID`、`INVALID_RECORD`、`CORRUPT_SEGMENT`、`USAGE`。

## 库

```js
const { Store } = require('./src/store');
const store = Store.open(dir);
store.addRecords(records);
store.delete(id); store.restore(id);
const { hits, certificate } = store.query('exact phrase', { slop: 1 });
store.decodeCurrentSegment(); // { indexVersion, terms: {term: {docId: [pos]}} }
```

## 测试

```sh
node --test
```
