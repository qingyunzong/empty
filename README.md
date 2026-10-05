# evidence-guard

证据守卫规则库与 CLI。脚本由**嵌套实验块**（block）、**事务**（txn）、**守卫**（guard）
与**观测赋值**（assign）组成；先静态类型检查，再编译为栈式字节码并解释执行。
仅使用 Node.js 22 标准库，测试使用 `node:test`。

## 运行

```sh
node src/cli.js --script examples/experiment.json --obs examples/obs.json \
    [--state evidence-guard.state.json] [--dump] [--crash N]
node --test
```

- `--dump`：向 stderr 打印编译后的指令清单（序号 + 操作码 + 参数）。
- `--crash N`：执行完第 N 条指令（1 起计）后、任何后续提交前以退出码 75 退出，
  模拟宕机。状态文件只包含已提交事务。
- 再次运行（不带 `--crash`）且 `--state` 指向同一状态文件时，依据文件中已提交
  序号跳过对应事务，从未提交事务不会半生效，结果与一次成功运行一致。
- 退出码：`0` 成功；`1` 静态类型错误 / 输入错误；`2` 用法错误；`75` 模拟崩溃。

## 脚本格式（JSON）

```jsonc
{
  "kind": "block", "name": "root",
  "body": [
    { "kind": "txn", "seq": 1, "body": [
      { "kind": "assign", "name": "x", "expr": { "kind": "bin", "op": "+",
        "left": { "kind": "obs", "name": "x" }, "right": { "kind": "int", "value": 1 } } },
      { "kind": "guard", "expr": { "kind": "bin", "op": ">",
        "left": { "kind": "obs", "name": "x" }, "right": { "kind": "int", "value": 0 } } }
    ]},
    { "kind": "block", "name": "inner", "body": [ /* 更多 txn / block */ ] }
  ]
}
```

表达式节点：`int` / `float` / `bool` / `evidence`（字面量）、`obs`（读观测字段）、
`bin`（`+ - * / % < <= > >= == != && ||`）、`un`（`!`、`-`）。

## 类型规则

- 类型仅 `int`、`float`、`bool`、`evidence`。
- 守卫表达式必须为 `bool`，否则静态检查拒绝。
- evidence 字段只能绑定 evidence 值；`int` 可 widening 到 `float` 字段。
- `%` 仅允许 `int`；比较运算仅允许数值；`==`/`!=` 允许同类型或数值混合。
- 初始观测的类型由 JSON 推断：整数→`int`，小数→`float`，布尔→`bool`，
  字符串或 `{"$evidence": "..."}`→`evidence`。

## 字节码与事务语义

指令集：`TXN_BEGIN/TXN_COMMIT seq`、`PUSH_INT/PUSH_FLOAT/PUSH_BOOL/PUSH_EV v`、
`LOAD/STORE name`、`ADD SUB MUL DIV MOD`、`LT LE GT GE EQ NE`、`AND OR NOT NEG`、`GUARD`。

- 每条事务含多条赋值；事务内任一守卫失败、除零或运行时类型不符 → 整笔事务回滚，
  已修改寄存器按撤销日志恢复旧值，之后继续执行后续事务。
- `TXN_COMMIT` 时把已提交序号与全部寄存器原子写入状态文件（临时文件 + rename）。
- 崩溃恢复：重启后跳过已提交序号的事务，未提交事务的寄存器修改只存在于内存，
  随进程消失，不会半生效。

## 输出

成功：`{"ok": true, "resumed": bool, "observations": {...}, "committed": [...], "rolledBack": [...]}`；
失败：`{"ok": false, "error": "...", "observations": {}}`。

## 测试结果（真实运行记录）

`node --test`（Node v22.22.1）：8/8 通过。

```
ok 1 - two normal transactions produce hand-computed result
ok 2 - failed guard rolls back its whole transaction, earlier commits stay
ok 3 - division by zero rolls back its whole transaction
ok 4 - static type errors are rejected before compilation
ok 5 - --dump listing matches manual enumeration
ok 6 - crash recovery: rerun after --crash matches a clean run
ok 7 - static type error via CLI yields empty result plus error
ok 8 - StaticError is an Error subclass
# tests 8  # pass 8  # fail 0
```

验收对照：

1. 两笔正常事务：`x:1→4→8`，`y:2.5→5.0`，`sample:A→B`，与手算一致（测试 1）。
2. 第二笔守卫失败：第一笔 `x=10` 保留，第二笔 `x=99,y=7` 全部回滚（测试 2、3）。
3. `--crash 16` 在事务 2 提交前退出（退出码 75），状态文件仅含已提交事务 1；
   重跑后 `{x:10, y:14, sample:B}` 与一次成功运行完全一致；`--dump` 输出与
   测试中手工枚举的 32 条指令逐行一致（测试 5、6）。
