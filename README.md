# recipe-tag-engine

Node.js 22（仅标准库）实现的产线配方标签引擎与单机离线 CLI。

- 常量标签与公式标签；公式支持 `+ - * /`、括号、整数/小数、一元负号
- 同进程维护依赖图、标签值、失效集合与撤销/重做历史
- 新增/修改公式后仅重算下游可达的受影响标签（`recomputed` 字段可见）
- 循环依赖、除零、未知依赖使该标签及下游全部进入 `invalid`，不污染无关分支
- 拓扑排序按标签名确定性决断（Kahn + 字典序）

## CLI

```
node src/cli.js run commands.json -o result.json
```

`commands.json` 为命令数组（或 `{"commands": [...]}`）：

| op       | 字段                                       | 说明                                   |
|----------|--------------------------------------------|----------------------------------------|
| `upsert` | `tag`, `type:"const"`+`value` / `type:"formula"`+`expr` | 新增或修改标签（可改类型） |
| `set`    | `tag`, `value`                             | 修改常量值（不存在则创建常量）         |
| `remove` | `tag`                                      | 删除标签（幂等）；下游因未知依赖失效   |
| `undo`   | —                                          | 撤销上一次状态变更（恢复旧拓扑）       |
| `redo`   | —                                          | 重做；新的变更命令会清空 redo 栈       |
| `commit` | —                                          | 检查点：状态不变，产出带证书的版本     |

`result.json` 中每个版本包含：`version`、`command`、`status`(`ok`/`invalid`)、
`values`、`invalid`、`diff`（`from`/`to`，`absent` 表示不存在）、`recomputed`、
`certificate`。证书含 `seq`（序号）、`topo`（确定性拓扑排序）、
`hash`（规范 JSON 的 SHA-256，键排序后的 `{invalid, values}`）。

输入 JSON 非法、文件不可读或命令非法时，退出码为 1，stdout 输出
`{"error":true,"code","message"}`（code 如 `E_INPUT`/`E_FORMULA`/`E_COMMAND`/`E_USAGE`）。

## 测试

```
node --test
```

测试位于 `test/`：引擎测试含独立参考固定点算法对照（多级更新、循环制造/断环/
撤销恢复拓扑、菱形并列依赖、除零、未知依赖），CLI 测试覆盖端到端输出与错误路径。
`test-results.txt` 记录了 `node --test` 的真实 stdout、stderr 与退出码。
