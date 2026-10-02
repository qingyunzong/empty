# evidence-guard

单机离线（Node.js 22，仅标准库）的证据守卫规则库与 CLI。
脚本由**嵌套实验块、守卫、观测赋值**组成，执行流程：
静态类型检查 → 编译为栈式字节码 → 解释执行（事务化，可回滚、可崩溃恢复）。

## 运行

```sh
node src/cli.js --script script.json [--state state.json] [--crash N] [--dump]
node --test
```

- 输出：成功 `{"ok": true, "observations": {...}}`；失败 `{"ok": false, "error": "..."}`（空结果加错误，退出码 1）。
- `--dump`：打印 1 起始的全局指令清单后退出，不执行。
- `--crash N`：执行完第 N 条指令后、事务提交前退出（退出码 42）。
- 状态文件（默认 `<script>.state.json`）记录已提交事务序号与观测快照，原子写入（tmp + rename）。
  不带 `--crash` 重跑时跳过已提交事务，未提交事务不会半生效。

## 脚本格式

```json
{
  "observations": {
    "count": { "type": "int", "value": 0 },
    "ratio": { "type": "float", "value": 1.5 },
    "flag": { "type": "bool", "value": false },
    "proof": { "type": "evidence", "value": "init" }
  },
  "transactions": [
    {
      "name": "tx1",
      "body": [
        { "assign": "count", "expr": { "op": "+", "left": { "var": "count" }, "right": { "lit": 1 } } },
        { "guard": { "op": ">", "left": { "var": "count" }, "right": { "lit": 0 } } },
        { "block": "inner", "body": [ ] }
      ]
    }
  ]
}
```

- 语句：`{"assign": name, "expr": E}`、`{"guard": E}`、`{"block": name, "body": [...]}`（可嵌套）。
- 表达式：`{"lit": v}`、`{"var": name}`、二元 `{"op": o, "left": E, "right": E}`、一元 `{"op": "not"|"neg", "arg": E}`。
- 字面量：整数→`int`，小数→`float`，布尔→`bool`，`{"evidence": "tag"}`→`evidence`。
- 二元运算：`+ - * / %`、比较 `< <= > >=`、等值 `== !=`、逻辑 `and or`。

## 类型规则（静态检查）

- 仅 `int` / `float` / `bool` / `evidence` 四种类型。
- 守卫表达式必须为 `bool`。
- evidence 字段只能绑定 evidence；`int` 可提升绑定到 `float` 字段；其余必须同型。
- 算术只接受数值；`%` 只接受 `int`；比较只接受数值；等值要求同型或同为数值。

## 字节码与事务语义

- 指令：`BEGIN_TX/COMMIT name`、`PUSH v`、`LOAD/STORE name`、`ADD SUB MUL DIV MOD NEG`、
  `EQ NE LT LE GT GE`、`AND OR NOT`、`GUARD`。
- `int/int` 除法向零取整；除零（含 `%`）为运行时错误。
- 每笔事务从 `BEGIN_TX` 到 `COMMIT`；任一守卫失败、除零或运行时类型不符，
  整笔事务回滚（已修改寄存器恢复旧值），已提交的前序事务不受影响。
- 只有 `COMMIT` 会把观测快照与已提交序号写入状态文件，因此崩溃点之后不会出现半提交事务。

## 代码结构

- `src/lang.js` — 静态类型检查
- `src/compile.js` — 字节码编译与 `--dump` 清单
- `src/vm.js` — 栈式字节码解释器（事务回滚）
- `src/cli.js` — 命令行入口（`run(argv)` 返回 `{code, stdout}`，便于进程内测试）
- `test/cli.test.js` — node:test 验收测试
- `examples/crash.json` — 崩溃恢复演示脚本
