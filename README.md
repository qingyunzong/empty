# chain-guarantee

链式保函（chained guarantee）账本：Node.js 22 标准库实现，单机离线，零依赖。

## 模型

- 保函字段：`id`、`parentId`、`exposure`、`cap`、`terms`、`expiresAt`、`state`（`active`/`revoked`/`expired`）。
- 开立时沿父链逐层检查并冻结敞口：每层 `used(子树存活敞口) + 新敞口 <= cap`，任一层超额即整体失败，无部分写入。
- 撤销（`revoke`）只释放其自身敞口沿祖先链的占用，父、兄弟、其他分支不受影响。
- `sweep(now)` 将到期保函逻辑删除（`expired`），释放占用、移出查询结果，倒排索引保留物理词条。
- `purge(id)` 仅当子树无存活节点时物理删除整棵死子树，并增量压缩 terms 位置索引（移除该文档 postings、清理空词项）。
- 每条保函携带链哈希 `sha256(id, parentId, exposure, cap, terms, expiresAt, parentHash)`；`audit` 返回整条占用路径、每层剩余额度、命中位置与链哈希。
- 持久化：单文件 JSON 快照，临时文件 + `rename` 原子替换；重开目录即重启恢复，`verify()` 独立重算子树敞口、哈希链与索引一致性。

## 库用法

```js
import { GuaranteeStore } from './src/store.js';
const store = new GuaranteeStore('./data');
store.issue({ id: 'R', exposure: 100, cap: 1000, terms: 'standby credit', expiresAt: 1e15 });
store.issue({ id: 'A', parentId: 'R', exposure: 50, cap: 300, terms: 'payable on demand', expiresAt: 1e15 });
store.phraseQuery('standby credit');   // => [{ id, positions }]
store.nearQuery(['standby', 'credit'], 5);
store.audit('A', 'standby');           // 占用路径 + 剩余额度 + 命中位置 + 链哈希
store.revoke('A');
store.sweep(Date.now());
store.purge('A');
store.verify();
```

## CLI

```sh
node bin/cli.js issue --data ./data --id R --exposure 100 --cap 1000 --terms "standby credit" --expires 99999999999999
node bin/cli.js phrase --data ./data "standby credit"
node bin/cli.js near --data ./data standby credit --k 5
node bin/cli.js audit --data ./data --id R --query "standby"
node bin/cli.js revoke --data ./data --id R
node bin/cli.js sweep --data ./data
node bin/cli.js purge --data ./data --id R
node bin/cli.js verify --data ./data
```

所有命令输出 JSON；失败时退出码为 1，stderr 为 `{"error": <code>, "message": ...}`。

## 测试

```sh
node --test
```
