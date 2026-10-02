# 审计同步库（快照 + 增量 → 审计库）

日终将账户余额快照与增量流水同步到审计库；目标快照损坏或进程中断后，
能精确定位最近可信点并继续恢复。仅依赖 Node.js 22 标准库与 `node:test`。

## 存储布局

```
<store>/
  delta.log                          # 追加式 JSONL，每行 {"seq":n,"ops":[...]}，seq 从 1 连续
  snapshots/snap-000001/
    chunks/chunk-000000 ...          # 状态规范化序列化后的分块，逐块 sha256
    manifest.json                    # 原子提交：先写 manifest.json.tmp + fsync，再 rename + 目录 fsync
```

manifest 记录 `baseSeq`（快照覆盖到的 commitSeq）、每块哈希、`stateHash`、
`deltaHash`（seq ≤ baseSeq 的流水前缀哈希）。manifest 已 rename 提交 ⇒ 快照可信；
只有 `.tmp` 或 manifest 缺失 ⇒ 视为未提交，恢复时跳过。

## 恢复规则（restore）

1. 从最新快照向回找第一个 manifest 已提交且全部块哈希校验通过的快照 → 可信点；
   坏块/缺块只导致回退到更早快照，不中断恢复。
2. 校验 delta.log：seq 必须从 1 连续；可信快照的 `deltaHash` 必须等于流水前缀哈希
   （同 seq 不同内容 ⇒ 冲突 code 52）；更高 commitSeq 的流水在快照状态上按序重放。
3. 操作语义：`add` 累加；`correct` 更正为绝对值；`undo seq` 逐操作取反
   （add 取负；correct/undo 的撤销需目标在快照边界之后，否则判冲突）。

## 命令

```
node cli.js snapshot --store D [--state state.json] [--chunk-size N] [--crash-point P]
node cli.js delta    --store D (--ops '<json>' | --file f.json)
node cli.js restore  --store D [--out state.json]
node cli.js check    --store D [--proof proof.json]   # 输出覆盖证明
node cli.js check    --store D --verify proof.json    # 独立重算并验证证明
```

`snapshot` 不带 `--state` 时以当前库内恢复结果作为源余额。`--crash-point` 取值
`before-manifest-fsync` / `before-commit` / `after-commit`，用于以 SIGKILL 模拟中断。

## 错误码（进程退出码）

- `50` 块缺失（chunk missing）
- `51` seq 空洞（sequence hole）
- `52` 冲突（同 seq 不同内容 / 非法 undo）
- `53` 块哈希不匹配

## 测试

```
node --test test/*.test.js
```

真实输出见 `RESULTS.md`。
