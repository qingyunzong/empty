# obs-adjudicator

多观测员更正历史裁决库及 CLI（Node.js 22，仅标准库，测试使用 `node:test`）。

## 日志格式

```
note: <自由文本>                                       注解，裁决器忽略
<node> <clock> commit <key> = <value> [after <node>@<clock> ...]
<node> <clock> mask <key>             [after <node>@<clock> ...]
<node> <clock> rollback <key>         [after <node>@<clock> ...]
```

- 词法器（`src/lexer.js`）区分结构化事件行与 `note:` 自由文本；缺时钟、非法 op、缺 `= value` 均为解析错误。
- 编译器（`src/compiler.js`）把事件编译为 COMMIT / MASK / ROLLBACK / CONFLICT_CHECK 字节码，并构建 happens-before 因果边：同节点按逻辑时钟排序，跨节点由 `after` 显式声明；重复 `(node, clock)` 拒绝。
- 裁决器（`src/adjudicator.js`）重放字节码：有因果边者按因果序；无因果关系为并发。同键并发写且值不同 → 冲突证书，冲突事件不入状态，已提交前缀保留；不同键并发按键名字典序（再按节点、时钟）形成确定历史。每个事件只生效一次。

## 使用

```
node src/cli.js <logfile> [--explain] [--topo]
node --test
```

- `--explain` 输出裁决依据的因果边与每个事件的排序理由。
- `--topo` 枚举全部拓扑序并标出确定性选择。
- 退出码：0 正常；1 解析/编译/重放错误；2 用法错误；3 存在冲突证书。

示例日志见 `examples/`。真实测试与运行记录见 `run-record.txt`。
