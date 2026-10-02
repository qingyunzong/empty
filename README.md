# settle-audit

离线可验证结算审计库及 CLI。Node.js 22，仅标准库（`node:fs` / `node:crypto` / `node:test`），
无网络、无密钥服务依赖。

## 设计

- **MVCC 存储**：每笔支付（payment）、结算（settlement）、撤销（reversal）提交后生成一个新版本；
  旧版本永不删除，支持任意历史版本的 as-of 查询。
- **证书链**：提交成功返回证书 `{ version, parentVersion, snapshotVersion, opHash, prevHash, digest }`。
  `opHash = SHA-256(规范化操作)`，`digest = SHA-256(规范化证书五元组)`，`prevHash` 链接前一证书，
  创世哈希为 64 个 `0`。
- **规范化**：对象键字典序排序、无空白、数组保序的确定性 JSON（`src/canonical.js`）。
- **WAL**：`wal.log` 每行一条 JSON 记录，追加写入并 `fsync` 后才确认提交；只增不改。
- **撤销即反向分录**：reversal 复制原交易的 party/currency、金额取负，原交易标记 `reversed`，
  不删除任何版本。
- **二级索引**：按交易对手（party）维护内存索引，打开时从 WAL 重放重建；
  `auditParty(party, at)` 返回该版本可见的全部记录。
- **乐观并发**：`store.begin()` 取快照，`commit(op, snapshot)` 时若快照版本落后于 head
  则抛 `E_CONFLICT`，不产生任何 WAL 记录，证书链保持连续。
- **verify**：离线逐条重放 WAL，检查序号连续性、parent/snapshot 版本、prevHash 链接，
  并重算 `opHash` 与 `digest`；首个不匹配处返回 `{ ok:false, code:'E_TAMPER', seq, field }`。

## CLI

```sh
node src/cli.js commit --dir D --type payment --id t1 --party alice --amount 100 --currency USD
node src/cli.js commit --dir D --type reversal --ref t1
node src/cli.js get --dir D --id t1 --at 2
node src/cli.js audit --dir D --party alice --at 3
node src/cli.js verify --dir D
node src/cli.js tamper-test --dir D --seq 2   # 复制目录、改写金额、验证副本，原目录不动
```

所有命令输出 JSON；失败时退出码为 1 且输出含 `code`（如 `E_CONFLICT`、`E_TAMPER`）。

## 库 API

```js
import { Store, verify } from './src/store.js';

const store = Store.open(dir);
const cert = await store.commit({ type: 'payment', id: 't1', party: 'alice', amount: 100, currency: 'USD' });
const snap = store.begin();                    // 乐观并发快照
await store.commit({ type: 'reversal', ref: 't1' }, snap);
store.getAt('t1', 2);                          // as-of 查询
store.auditParty('alice', 3);                  // 二级索引 as-of 查询
verify(dir);                                   // 离线完整性校验
```

## 测试

```sh
node --test
```

- `test/store.test.js`：三条验收场景（三连提交 + as-of 可见性；并发撤销一成功一 `E_CONFLICT`；
  复制目录改写 WAL 金额后 `verify` 定位首个不匹配序号）。
- `test/reference.test.js`：参考测试，独立实现规范化与哈希，逐条重算 WAL 记录对照。
- `test/cli.test.js`：CLI 全命令冒烟（进程内调用 `runCli`，与真实入口同一代码路径）。
