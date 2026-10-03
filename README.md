# maint-history

离线单机工单历史库与 CLI。仅 Node.js 22 标准库，无外部依赖。

## 模型

- **版本 DAG**：每次 `commit`/`merge`/`undo` 生成一个版本，记录 Lamport 时钟与父版本列表。
- **因果判定**：`concurrent(a, b)` 当且仅当两边互不互为祖先；并发不按到达先后排序。
- **as_of 可见性**：`materialize(v)` / `query(phrase, {asOf: v})` 只计入 `v` 的祖先闭包。
- **undo**：不删历史，追加一个含逆操作（set/unset/delete/restore 的逆）的新版本。
- **merge**：相对 LCA 做字段级三方比对；并发改同一字段且结果不同即冲突，未决冲突抛
  `E_CONFLICT` 并列出冲突字段（`doc.field: ours/theirs`），绝不当作无解静默处理。
- **短语索引**：每个版本为受影响文档增量追加 posting（全文文本），删除是版本化墓碑
  posting；查询按 as_of 祖先闭包过滤可见 posting 后折叠。`compact` 合并段并去重，
  保留全部版本化 posting，因此压缩前后任意 as_of 结果一致。

## 错误码

- `E_CLOCK`：显式 Lamport 时钟未严格大于所有父版本。
- `E_CONFLICT`：merge 存在未决冲突（附冲突字段列表）。
- `E_VERSION`：未知版本/分支、非法 undo 目标等。

## CLI

```sh
node bin/cli.js branch main
node bin/cli.js commit --branch main --set w1.note=更换轴承 --message c1
node bin/cli.js branch feat --from v1
node bin/cli.js commit --branch feat --set w1.note=更换皮带
node bin/cli.js merge --branch main --from feat --resolve w1.note=更换轴承
node bin/cli.js undo --branch main --version v4
node bin/cli.js query --phrase 更换轴承 --as-of v3
node bin/cli.js compact
```

状态持久化在 `maint-store.json`（可用 `--store PATH` 覆盖）。出错时打印
`E_xxx: message` 并以退出码 1 终止。

## 测试

```sh
node --test
```

覆盖验收标准：
1. 枚举小历史全部祖先闭包，对照朴素重放的可见文档与短语查询结果；
2. 并发同字段修改触发 `E_CONFLICT`，列冲突字段，解决后合并成功；
3. undo 后旧版本经 as_of 仍可读，头部已回滚；
4. 索引压缩前后同一 as_of 查询结果一致。
