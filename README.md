# evpack — 可离线校验的科研证据包

仅依赖 Node.js 22 标准库。证据块构成 SHA-256 哈希链，链上所有块哈希再构成
Merkle 树，树根即证据包摘要（digest）。成员变更产生 epoch 屏障；两个副本之间
通过反熵（anti-entropy）交换 `{epoch, heads, digest}` 摘要并按缺失区间拉取块。

## 布局

```
<dir>/pack.json          清单（commit 记录）：epoch、成员、count、tip、digest
<dir>/blocks/NNNNNN.json 证据块：{index, epoch, prev, kind, payload, hash}
```

每次提交是两段原子落盘（tmp + fsync + rename）：先块文件，后清单（commit
记录）。崩溃恢复时，清单未确认的孤儿块会被回滚，绝不出现半提交块。

## CLI

```
evpack init    <dir> --members a,b[,c...]
evpack add     <dir> (--data JSON | --jsonl FILE) --member M [--epoch N]
evpack prove   <dir> --index N
evpack verify  <dir> [--proof FILE] [--digest HEX]
evpack digest  <dir>
evpack sync    <dirA> <dirB>
evpack members <dir> --set a,b[,c...] --member M [--epoch N]
```

所有命令 stdout 输出 JSON；失败时 stderr 输出
`{"error":{"code","message","details}}}`。

## 退出码

| code | 含义 |
|---|---|
| 0 | 成功 |
| 1 | 一般错误（用法、IO 等） |
| 2 | `TAMPER_DETECTED` 篡改（哈希链/摘要校验失败，details.index 定位） |
| 3 | `MISSING_BLOCK` 缺块 |
| 4 | `INVALID_PROOF` 包含证明无效 |
| 5 | `STALE_EPOCH` 旧 epoch 写入被屏障拒绝 |
| 6 | `NOT_MEMBER` 写入者不在当前成员集 |
| 7 | `DIVERGENT` 反熵发现历史分叉 |

## 库

```js
import { initPack, openPack } from './src/pack.js';
const pack = initPack(dir, { members: ['alice'] });
pack.add({ any: 'json' }, { member: 'alice' });
pack.prove(0);            // => {index, hash, count, epoch, digest, proof}
pack.verify();            // 全量重算哈希链 + Merkle 根
pack.verifyProof(proof);  // 校验包含证明
pack.syncFrom(peer);      // 反熵拉取缺失区间，幂等
```

## 测试

```
node --test
```
