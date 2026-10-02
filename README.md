# risk-patch

风控每日额度/冻结迁移补丁工具：从 `base` 到 `target` 生成**可审查、可回滚、可重放**的结构化补丁，而非整表覆盖。Node.js 22，仅标准库，单机离线。

## 状态模型

```json
{
  "accounts": {
    "a1": {
      "limit": 150,
      "used": 20,
      "holds": [{ "hid": "h1", "amount": 10, "tag": "fraud" }]
    }
  }
}
```

可用额 = `limit - used - sum(holds.amount)`。不变量：`hid` 账户内唯一、`amount > 0`、`limit >= used + sum(holds)`（可用额不为负）。

## CLI

```bash
node bin/cli.js diff   <base.json> <target.json> --out patch.json
node bin/cli.js apply  <state.json> <patch.json> [--dry-run]
node bin/cli.js revert <state.json> <patch.json>
```

- `diff`：生成补丁，仅含四类结构化 op：`setLimit` / `addHold` / `removeHold` / `changeTag`（`used` 或账户集合变化不可表示，`diff` 直接报错拒绝）。
- `apply`：校验补丁 `sha256` 与状态哈希后原子应用；任一 op 失败则整体回滚（状态文件不变），输出首个失败的 `opIndex`。当前哈希已等于 `toHash` 时幂等跳过（`already-applied`）。`--dry-run` 只校验模拟、不写文件。
- `revert`：仅当当前状态哈希等于补丁 `toHash` 时，应用 `inverse` 逆操作序列回到 `fromHash`，否则拒绝。

### 退出码

| code | 含义 |
| ---- | ---- |
| 0 | 成功（含幂等跳过） |
| 1 | 用法/输入文件/不可表示的差异等一般错误 |
| 6 | 哈希不匹配（状态哈希不符、补丁 sha256 被篡改、revert 拒绝） |
| 7 | 不变量失败（额度不足 `limit < used + holds`、hid 重复、amount<=0、hold 不存在） |
| 8 | 未知 op |

## 补丁格式

```json
{
  "fromHash": "…", "toHash": "…",
  "ops": [ { "op": "setLimit", "account": "a1", "limit": 200 }, … ],
  "inverse": [ … ],
  "sha256": "…"
}
```

`fromHash`/`toHash` 是状态的规范化 SHA-256（键排序、holds 按 `hid` 排序后序列化）；`inverse` 为逐 op 逆操作（revert 所需）；`sha256` 覆盖 `{fromHash,toHash,ops,inverse}`，篡改即拒绝。

## 真实运行输出（node 22，`bin/cli.js`）

```console
$ node bin/cli.js diff base.json target.json --out patch.json
{"status":"diffed","fromHash":"4e1a45ab…","toHash":"d56f2213…","ops":3,"sha256":"e8739ba4…","out":"patch.json"}   # exit=0

$ node bin/cli.js apply state.json patch.json --dry-run
{"status":"dry-run","fromHash":"4e1a45ab…","toHash":"d56f2213…","ops":3}                                          # exit=0，文件未改

$ node bin/cli.js apply state.json patch.json
{"status":"applied","fromHash":"4e1a45ab…","toHash":"d56f2213…","ops":3}                                          # exit=0

$ node bin/cli.js apply state.json patch.json        # 重复 apply：幂等
{"status":"already-applied","hash":"d56f2213…"}                                                                    # exit=0

$ node bin/cli.js revert state.json patch.json
{"status":"reverted","fromHash":"4e1a45ab…","toHash":"d56f2213…","ops":3}                                          # exit=0

$ node bin/cli.js revert state.json patch.json        # 非 toHash：拒绝
{"error":"revert refused: current state hash != patch.toHash","currentHash":"4e1a45ab…","toHash":"d56f2213…"}      # exit=6
```

超限补丁（第二条 addHold 使 `a2` 的 holds 合计 110 > limit 100）原子失败，状态文件保持不变：

```console
$ node bin/cli.js apply state2.json evil.json
{"error":"account a2: limit < used + holds (insufficient limit)","opIndex":1}                                      # exit=7
```

完整哈希值（上例省略部分）：

```
fromHash = 4e1a45abbb10b332cfae70c871d9902bfe336fbc0b30e0c26a254104241b2c1c
toHash   = d56f2213f26d0799740319c61763faa297b0641988635af9abd1cc29b4e3b2b9
sha256   = e8739ba4ff16bf96de86601e1c8ca67cbfc2a1fcaae0d515338e1955e8de01e2
```

## 测试

```bash
node --test
```

真实输出：

```
# tests 5
# pass 5
# fail 0
# duration_ms 15769.744361
```

覆盖验收项：

- `test/diff-apply.test.js`：新增/释放冻结、setLimit、changeTag、dry-run 不写文件。
- `test/atomic.test.js`：超限 apply 整体原子失败（文件不变、首个失败 `opIndex`、exit 7）；未知 op exit 8；哈希不匹配 exit 6。
- `test/idempotent-revert.test.js`：重复 apply 幂等；revert 仅在当前哈希等于 `toHash` 时接受；篡改补丁拒绝。
- `test/roundtrip.test.js`：独立枚举器对 3 账户 × ≤2 holds（n≤6）的全部 4096 个合法目标状态验证 `diff → apply → revert` 往返（哈希与深比较均一致）。

## 结构

- `src/state.js`：规范化序列化、状态哈希、不变量校验。
- `src/diff.js`：结构化 diff、补丁构建（构建时自验证可重放）、补丁完整性校验。
- `src/apply.js`：原子 op 应用（正向与逆向共用）。
- `src/cli.js`：命令实现（进程内可调用，返回 `{code,stdout,stderr}`）。
- `bin/cli.js`：可执行入口。
