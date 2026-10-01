# quota — 层级配额事务引擎

`python -m quota apply tx.json --state state.json --out newstate.json`

对树状配额状态原子地应用一组 add/sub 操作：任一 op 失败则整个事务
回滚，输出的 state 与输入逐字节相同。

## 数据模型

- **state**：树，根节点及每个节点字段为 `{id, limit, used, children}`；
  `limit` 为整数或 `null`（无限），`used` 为非负整数，`children` 为节点列表。
- **tx**：`{"ops": [{"op": "add"|"sub", "path": [id, ...], "amount": int}]}`，
  `path[0]` 必须是根节点 id。

## 语义

1. `add`：path 上每个节点（含自身）须满足 `used + amount <= limit`；子孙不变。
2. `sub`：path 上每个节点扣减后 `used >= 0`。
3. 任一 op 失败 → 整个 tx 无效果，输出原 state（逐字节），
   stderr 打印 `first_error_index`（从 0 计），退出码 1。
4. `limit: null` 表示无限，但 `used` 仍不得为负。
5. 路径不存在是 op 失败（回滚），不会隐式创建节点。
6. 成功时 `used` 只沿 path 增减，输出新 state，退出码 0。

结构性错误（退出码 2）：amount 非整数、path 含环（重复 id）、根节点缺失、
JSON 无法解析、文件不可读等。

幂等性不成立：对同一成功 tx 重复 apply 会因配额校验失败而报错（退出码 1），
不会静默成功。

## 测试

```
python -m unittest discover -s tests -v
```

实际运行结果（Python 3.14.4）：**18 个测试全部 OK**，覆盖验收用例：

- A：三层树 add 越上限 → 状态与输入逐字节相等（`test_a_add_exceeds_limit_rolls_back`
  及 CLI 测试 `test_cli_failure_exit_1_and_byte_identical_state`）。
- B：多 op 中第 3 个 sub 致负 → `first_error_index == 2` 且回滚
  （`test_b_multi_op_third_sub_negative`）。
- C：`limit: null` 祖先下的有限子节点仍受限（`test_c_null_limit_ancestor_finite_child_still_capped`）。
- D：300 个随机用例（深度 ≤ 4、ops ≤ 8）与测试内独立的递归拷贝参考实现
  对照最终 `used` 与 `first_error_index`（`test_random_against_reference`）。
- E：重复 apply 同一成功 tx 第二次必报错（`test_e_reapply_same_tx_is_not_idempotent`）。

## 示例（真实运行记录）

以下命令均在仓库根目录实际执行，退出码、stderr 与哈希为真实输出。

### 成功（退出码 0）

```
$ python -m quota apply examples/tx_ok.json --state examples/state.json --out examples/out_ok.json
ok: applied 2 op(s); wrote examples/out_ok.json
$ echo $?
0
```

- `examples/state.json`    sha256 = `c465181659f4e535999509f04d58f1f45c9f62bae1400cb27e3a92996f2901f0`
- `examples/out_ok.json`   sha256 = `3ea05cc66dc31d9f1dbf4220744dea0c7ecbbab3c55bc8bac291357b22b436fe`

`used` 仅沿 path 变化：root 10→12，team-a 5→8，svc-1 2→5，team-b 1→0。

### 失败回滚（退出码 1）

```
$ python -m quota apply examples/tx_fail.json --state examples/state.json --out examples/out_fail.json
{"error": "tx rolled back: op failed", "first_error_index": 1}   # stderr
$ echo $?
1
```

ops[1] 对 `svc-3`（limit 8, used 8）add 1 越限，整个 tx 回滚：

- `examples/out_fail.json` sha256 = `c465181659f4e535999509f04d58f1f45c9f62bae1400cb27e3a92996f2901f0`
  （与输入 state 完全相同，`cmp` 验证逐字节一致）。

### 结构性错误（退出码 2）

```
$ python -m quota apply examples/tx_bad.json --state examples/state.json --out examples/out_bad.json
error: ops[0].path contains a cycle (repeated id)                # stderr
$ echo $?
2
```

## 代码结构

- `quota/core.py` — 校验（`validate_state`/`validate_tx`）与原子应用（`apply_tx`）。
- `quota/__main__.py` — CLI 入口与退出码处理。
- `tests/test_quota.py` — 单元测试、随机对照测试与 CLI 子进程测试。
- `examples/` — 上文记录的示例输入与真实输出。
