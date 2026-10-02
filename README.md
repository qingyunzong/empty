# workorder-vcs

离线笔记本上的设备维护工单版本库：多历史分支、Lamport 时钟、因果并发判定、
按版本可见性过滤的短语索引、逆操作 undo、冲突显式 merge。Node.js 22，仅标准库。

## 设计

- **版本与 Lamport 时钟**：每次 commit 生成 `{id, clock, parents, branch, ops}`。
  时钟必须严格大于所有父版本时钟，否则 `E_CLOCK`；缺省自动取 `max(父时钟)+1`。
- **并发判定**：仅由因果序（祖先闭包）决定——互不包含即并发。到达先后（seq）
  从不参与并发判定；同字段并发写只能由显式 merge 解决，merge 提交时钟最高、
  最后回放，因此物化结果与到达顺序无关。
- **as_of 可见性**：`visibleVersions(v)` 只含 v 的祖先闭包；文档状态与短语索引
  都按该集合过滤后回放。
- **undo**：不删历史，追加一个含逆操作的新提交（字段恢复到目标版本父状态的值）。
- **merge**：三路合并（LCA），两侧都改且值不同的字段列入冲突清单；未提供
  resolution 时抛 `E_CONFLICT`（附 `details.conflicts`），不产生任何提交。
- **短语索引**：文本 posting 增量追加；删除是版本化墓碑（`del` posting）。
  CJK 文本按单字建词项，查询先做词项候选过滤再按可见文本验证子串。
- **索引压缩**：仅删除“对所有可能 as_of 查询都不可见”的冗余 posting
  （移除前后每个版本上的有效 posting 完全一致才删）；仍有效的墓碑保留。

## CLI

```
node cli.js commit  --store f.json --branch main --doc WO-1 --set notes=轴承过热 [--del f] [--clock N]
node cli.js branch  --store f.json --name dev --from main
node cli.js merge   --store f.json --into main --from dev [--resolve WO-1.notes=...]
node cli.js undo    --store f.json --branch main --version v3
node cli.js query   --store f.json --phrase 轴承过热 [--as-of v1 | --branch main]
```

错误码（stderr 输出，退出码 1）：`E_CLOCK`、`E_CONFLICT`（同时逐行列出冲突
字段的 base/ours/theirs）、`E_VERSION`。用法错误退出码 2。

## 库 API

`lib/store.js` 导出 `Store`：`commit / createBranch / merge / undo / queryPhrase /
visibleVersions / documentsAt / docStateAt / areConcurrent / compact / toJSON /
fromJSON`。存储文件为 JSON；索引是派生状态，加载时重放全部提交重建。

## 测试

`node --test`（Node v22.22.1 实测结果）：

```
ok 1 - test/cli.test.js
ok 2 - test/store.test.js
# tests 2
# pass 2
# fail 0
```

`test/store.test.js` 9 个用例全部通过，覆盖四条验收标准：

1. 枚举小历史（6 版本、含分支与 merge）所有祖先闭包，与独立实现逐版本对照可见文档；
2. 并发修改同字段触发 `E_CONFLICT` 并列出冲突字段，resolution 后合并成功；
   另有专项用例验证并发判定不受到达先后影响（后到版本带更低时钟仍判并发）；
3. undo 后历史完整（版本数不减），as_of 旧版本仍可读到旧值并命中短语查询；
4. 索引压缩（实测移除冗余 posting，removed > 0）前后，全部版本 × 全部短语的
   as_of 查询结果逐一相等；另有墓碑保留专项用例。
