# guarantee-chain — 链式保函

Node.js 22 标准库实现，单机离线，无第三方依赖。测试使用 `node:test`。

## 模型

保函字段：`id`、`parentId`、`exposure`、`cap`、`terms`、`expiresAt`、`state`
（`ACTIVE` / `REVOKED` / `EXPIRED`）。

- **开立**：沿父链逐层检查 `used + exposure <= cap`，全部通过后在每个祖先上冻结
  `exposure`；任一祖先超额即整体失败，无部分写入。
- **撤销**：仅 `ACTIVE` 可撤销；只释放该保函自身在祖先链上的占用，父、兄弟、
  其他分支及其子孙的占用不受影响。重复撤销报 `INVALID_STATE`。
- **到期**：`now >= expiresAt` 的 `ACTIVE` 保函可逻辑删除（置 `EXPIRED` 并释放自身占用）。
- **purge**：仅非 `ACTIVE` 且已逾期、且存储中无任何子节点的保函可物理删除；
  删除时从 terms 位置索引中增量移除其 postings，空词项即时回收（增量压缩）。
- **审计证书** `audit(id, query)`：返回根到该节点的整条占用路径（每层
  `exposure/cap/used/remaining` 与 `chainHash`）、查询命中位置、链哈希与重算校验位。
- **链哈希**：`sha256(parentChainHash | canonical(不可变字段))`，根以 `GENESIS` 起步。
- **持久化**：每次变更原子写入 `state.json`（tmp + rename），内含全部记录与
  SHA-256 校验和；`GuaranteeChain.load()` 校验和 + 结构校验（used 重算、链哈希、
  索引重建比对）通过后才可用，重启后状态可验证。

## 库 API（`src/guarantee-chain.js`）

```js
import { GuaranteeChain } from './src/guarantee-chain.js';
const chain = GuaranteeChain.load({ dataDir: './data' });
chain.issue({ id, parentId, exposure, cap, terms, expiresAt });
chain.revoke(id); chain.expire(id, now); chain.purge(id, now);
chain.queryPhrase('advance payment');   // { docId: [startPos] }
chain.queryNear('standby', 'credit', 3); // { docId: [[posA, posB]] } 有序近邻
chain.audit(id, { phrase: '...' });      // 或 { near: { terms: [a, b], k } }
chain.verify();                          // { ok, problems }
```

错误均为 `GuaranteeError`，`code` 取值：`OVER_CAP`、`PARENT_NOT_FOUND`、
`PARENT_INACTIVE`、`DUPLICATE_ID`、`INVALID_STATE`、`NOT_FOUND`、`NOT_EXPIRED`、
`STILL_ACTIVE`、`HAS_LIVE_CHILDREN`、`CHECKSUM_MISMATCH`、`INTEGRITY_FAILURE` 等。

## CLI（`src/cli.js`）

```
node src/cli.js [--data DIR] issue --id ID [--parent ID] --exposure N --cap N --expires-at ISO [--terms TEXT]
node src/cli.js [--data DIR] revoke|show --id ID
node src/cli.js [--data DIR] expire|purge --id ID [--now ISO]
node src/cli.js [--data DIR] list | verify
node src/cli.js [--data DIR] phrase <phrase...>
node src/cli.js [--data DIR] near <termA> <termB> --k N
node src/cli.js [--data DIR] audit --id ID [--phrase TEXT | --near-a A --near-b B --k N]
```

成功输出 JSON、退出码 0；失败输出 `error <CODE>: ...`、退出码 1。

## 测试

`node --test`（或 `npm test`）。覆盖：

1. `test/guarantee-chain.test.js` — 多分支开立/撤销/到期后，逐层 `used` 与独立树
   遍历求和一致；purge 增量压缩索引；审计证书路径/剩余额度/命中位置/链哈希；
   超额、父不存在、purge 有存活子节点、重复撤销等失败均无部分写入（内存快照与
   磁盘文件逐字节不变）；重启后 `load` 状态一致且 `verify()` 通过；篡改状态文件
   被校验和拒绝。
2. `test/text-index.test.js` — 短语与有序近邻结果对照小样本暴力枚举位置窗口
   （155 个短语 × 25 文档、100 个词对 × 4 种距离）；索引增量压缩。
3. `test/cli.test.js` — CLI 全命令与失败退出码。

最近一次真实运行（2026-10-03，Node v22.22.1）：

```
$ node --test ; echo $?
0
# tests 3   (3 个测试文件全部通过)
# pass 3
# fail 0
```

子测试明细（逐文件直接运行）：cli 1/1、guarantee-chain 6/6、text-index 4/4，
共 11 通过、0 失败，无失败输出。
