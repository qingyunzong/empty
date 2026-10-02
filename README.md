# evpack — 离线科研证据包

仅依赖 Node.js 22 标准库。证据块哈希链 + Merkle 包含证明 + 反熵同步 + epoch 屏障。

## 布局

```
<pack>/
  commit.json          # 提交记录 {epoch,length,head,root}，tmp+rename 原子落盘
  epoch.json           # 成员视图 {epoch,members}，成员变更 => epoch+1（写屏障）
  blocks/00000000.json # 证据块 {index,epoch,prev,data,hash}
```

写入顺序：先落块文件，后落提交记录（均 tmp+fsync+rename）。崩溃只可能留下
提交记录之外的孤儿块，所有读取路径按 `commit.length` 截断，不存在半提交块。

## CLI

```
evpack init <pack> [--members a,b,c]
evpack add <pack> (--data '<json>' | --file evidence.jsonl)
evpack prove <pack> --index N [--out proof.json]
evpack verify <pack> [--proof proof.json]
evpack digest <pack>
evpack sync <packA> <packB>
evpack epoch <pack> --members a,b,c   # 成员变更 => epoch 屏障
```

stdout 一律 JSON；失败时 stderr 输出 `{"ok":false,"error":{code,message,...}}`。

## 退出码

| code | 含义 |
|---|---|
| 0 | 成功 |
| 1 | 其他错误（冲突、IO、内部） |
| 2 | TAMPER_DETECTED 篡改（哈希链/根不匹配，stderr 带 index） |
| 3 | MISSING_BLOCK 缺块 |
| 4 | INVALID_PROOF 证明无效 |
| 5 | STALE_EPOCH 旧 epoch 写入被拒（旧数据仍可读） |
| 6 | USAGE 用法错误 |

## 反熵

`sync A B` 先交换 `{epoch, head, length, root}` 握手：epoch 取高者（成员视图随
握手传播）；随后双向补齐——先填已提交区间内的缺块，再按缺失区间拉取尾部，
逐块校验哈希链与 epoch 屏障，整链重算 Merkle 根与对端提交记录一致后才原子推
进本地提交记录。幂等：重复执行第二轮传输量为 0。

## 测试

```
node --test
```
