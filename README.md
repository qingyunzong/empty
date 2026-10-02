# evidence-patcher

单机离线环境下面向证据包的事务性补丁库与 CLI。仅使用 Node.js 标准库（Node 22），测试基于 `node:test`。

## 数据模型

证据包是一个目录，内含：

- `state.json` — 证据包状态：`{ version, attributes, files, chain }`
  （键值属性、files 清单、证据链）
- `journal.json` — 预写日志（仅在补丁执行期间存在）

补丁文件为 JSON：`{ "ops": [ ... ] }`，每个 op 带条件版本号 `expectVersion`
（必须等于该 op 应用时的状态版本，每个 op 使版本 +1）。

支持的 op：

| op            | 字段                | 说明                       | 危险（需逆操作）     |
| ------------- | ------------------- | -------------------------- | -------------------- |
| `set-attr`    | `path`, `value`     | 设置键值属性               | 覆盖已有键时         |
| `delete-attr` | `path`              | 删除键值属性               | 总是                 |
| `put-file`    | `path`, `value`     | 写入 files 清单条目        | 覆盖已有路径时       |
| `delete-file` | `path`              | 删除 files 清单条目        | 总是                 |
| `append-chain`| `entry`             | 追加证据链                 | 否                   |

危险变更必须在 op 的 `inverse` 字段中携带逆操作，否则整个补丁被拒绝。

## CLI

```sh
node cli.js apply   --pkg <dir> --patch <patch.json> [--fail-at=N]
node cli.js recover --pkg <dir>
```

- `apply`：先自动恢复可能存在的残留日志，再校验整个补丁（未知 op、
  条件版本不匹配、危险变更缺少逆操作一律拒绝，退出码 1，且不落盘），
  校验通过后写预写日志，逐 op 应用并推进日志，全部成功后提交并清理。
- `--fail-at=N`：在第 N 个 op 落盘后模拟崩溃（遗留临时文件，退出码 2）；
  `N = ops 数 + 1` 时模拟提交标记之后、清理之前的崩溃。
- `recover`：依据 `journal.json` 恢复——已提交或已应用全部 op 则前滚完成；
  否则按逆操作回滚到提交前状态。两种路径都会清除全部临时文件与日志。

退出码：`0` 成功；`1` 拒绝/错误；`2` 模拟崩溃。

## 测试

```sh
node --test
```

覆盖：全部提交；用 3 个 op 枚举每个故障点（1..4）崩溃后恢复并核对确定性
状态（回滚到提交前或前滚完成）；危险 op 逆操作回滚；非法 op 拒绝且不落盘。
