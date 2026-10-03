# 债券分销树（Node.js 22 标准库，单机离线）

## 功能
- 分销树节点：`id / parentId / faceValue / lineLimit / terms / state`，`lineLimit <= 0` 表示不限额。
- 压缩位置索引：posting 位置差分 + varint 编码（`src/index.js`），支持短语与近邻（NEAR/k）查询，删除节点时增量移除位置。
- 撤销补偿（`src/tree.js` `revoke`）：自节点向上逐层释放，每层释放不超过该层实际占用；任一层额度不足则整树不变（原子）。证书含每层释放前/后占用、命中位置与哈希链，`rootCertHash()` 给出根证书哈希。
- 删除（`deleteNode`）：有存活（active）子节点时拒绝物理删除；否则级联移除子树并增量更新索引；数据落盘，重启后不可见。

## 库用法
```js
import { BondTree } from './src/tree.js';
const t = new BondTree('data.json');   // 传 null 则纯内存
t.addNode({ id: 'root', lineLimit: 1000, terms: '国债 分销' });
t.addNode({ id: 'mid', parentId: 'root', lineLimit: 600, terms: '可提前 赎回 条款' });
t.allocate('mid', 200);
t.findByPhrase('可提前 赎回');         // Map(nodeId -> [起始位置])
t.findNear('提前 赎回', 5);            // Map(nodeId -> [{start,end}])
t.revoke('mid', 100);                  // { ok, certificate }
t.revokeByNear('提前 赎回', 5, 100);   // 近邻定位 + 批量撤销
t.deleteNode('mid');
t.postOrderOccupied();                 // 独立后序遍历重算占用（校验用）
```

## CLI
```
node src/cli.js [--data FILE] add --id ID [--parent ID] [--face N] [--limit N] [--terms TEXT]
node src/cli.js [--data FILE] allocate --id ID --amount N
node src/cli.js [--data FILE] revoke --id ID --amount N
node src/cli.js [--data FILE] revoke --near "t1 t2" --k K --amount N
node src/cli.js [--data FILE] delete --id ID
node src/cli.js [--data FILE] search --phrase "..." | search --near "t1 t2" --k K
node src/cli.js [--data FILE] show [--id ID] | roothash
```

## 测试
```
node --test
```
覆盖：三层补偿与独立后序遍历对照、额度不足时整树不变、短语/近邻对照枚举窗口、
有子节点删除失败、无子节点删除重启后不可见、压缩序列化往返、增量移除。
