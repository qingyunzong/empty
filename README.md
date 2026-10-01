# quota — 层级配额事务引擎

`python -m quota apply tx.json --state state.json --out newstate.json`

## 语义

- **状态树**：每个节点为 `{"id", "limit", "used", "children"}`，`children` 递归。
  `limit` 为 `null` 表示无限，但 `used` 仍不得为负。
- **事务**：`{"ops": [{"op": "add"|"sub", "path": [id, ...], "amount": int}]}`。
- **add**：path 上每个祖先（含自身）须满足 `used + amount <= limit`；子孙不变。
- **sub**：path 上任何节点 `used` 不得变为负。
- **原子性**：任一 op 失败则整个事务无效果，`--out` 写入与输入**字节相同**的
  原 state，stderr 输出 JSON `{"error": ..., "first_error_index": N}`，退出码 1。
- **路径**：必须存在于树中且以根 id 开头；不存在是 op 级错误（退出码 1），
  不创建隐式节点。
- **成功**：`used` 只沿 path 增减，退出码 0。
- **校验错误**（退出码 2，不写 `--out`）：amount 非整数（含 bool）或为负、
  环 path（重复 id）、根缺失/状态树畸形、JSON 无法解析、同级 id 重复等。

## 退出码

| 码 | 含义 |
|----|------|
| 0 | 事务成功，新 state 写入 `--out` |
| 1 | op 失败，原 state 字节原样写入 `--out`，stderr 含 `first_error_index` |
| 2 | 输入校验错误（amount 非整数 / 环 path / 根缺失等），不写 `--out` |

## 测试（实际运行结果）

命令：`python3 -m unittest discover -s tests -v`

```
Ran 10 tests in 0.940s
OK
```

覆盖验收项：

- **A** 三层树 add 越上限：`--out` 与输入 state 字节一致（`cmp` 通过）。
- **B** 多 op 中第 3 个 sub 致负：`first_error_index == 2`，前两个 op 回滚。
- **C** `limit: null` 祖先下，有限子节点仍受自身 limit 约束。
- **D** 300 个随机用例（深度 ≤ 4、ops ≤ 8，固定种子 20261001）与测试中
  独立的递归拷贝参考实现对照最终 `used`，全部一致。
- **E** 重复 apply 同一成功 tx 不幂等：第二次必须报错（退出码 1，
  `first_error_index == 0`），而非静默成功。

## 示例（实际运行结果）

成功：

```
$ python3 -m quota apply examples/tx_ok.json --state examples/state.json --out examples/newstate_ok.json
{"status": "ok", "ops_applied": 2}
exit=0
```

失败（op 1 越 svc-1 上限，op 0 已回滚）：

```
$ python3 -m quota apply examples/tx_fail.json --state examples/state.json --out examples/newstate_fail.json
{"error": "add would exceed limit at node 'svc-1': 3 + 20 > 15", "first_error_index": 1}
exit=1
```

校验错误（环 path）：

```
$ python3 -m quota apply tx_bad.json --state examples/state.json --out out.json
error: ops[0]: cyclic path (repeated id)
exit=2   # 未写出 out.json
```

sha256（本次实际运行生成）：

```
93d9fa7e8ca0064a07ad90f2e5de8ef0eaa0d8f80849c922f3de6fe75bf045a9  examples/state.json
0934195bacf1abab6e2c9f6ad5cd3ef67474d15b0298c21e5b979ec0065201a1  examples/newstate_ok.json
93d9fa7e8ca0064a07ad90f2e5de8ef0eaa0d8f80849c922f3de6fe75bf045a9  examples/newstate_fail.json
```

失败输出的哈希与输入 state 完全相同，证明回滚字节级一致。

## 结构

- `quota/core.py` — 校验与事务引擎（`apply_tx` 在深拷贝上执行，失败即弃）。
- `quota/__main__.py` — CLI 入口与退出码。
- `tests/test_quota.py` — 验收 A–E、退出码 2 校验、随机对照参考实现。
- `examples/` — 上文实际运行所用的输入与产物。
