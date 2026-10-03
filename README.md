# recipe-tag-engine

产线配方标签引擎：同一进程内维护依赖图、标签值、失效集合与撤销/重做历史，
仅使用 Node.js 22 标准库（`node:test` 做测试），提供可运行库与单机离线 CLI。

## 运行

```bash
node src/cli.js run commands.json -o result.json   # 写入文件
node src/cli.js run commands.json                  # 输出到 stdout
node --test                                        # 运行全部测试
```

## 命令（commands.json 为数组或 `{"commands": [...]}`）

| op | 字段 | 语义 |
| --- | --- | --- |
| `upsert` | `name`, `type:"const"`, `value` | 新增/修改常量标签 |
| `upsert` | `name`, `type:"formula"`, `expr` | 新增/修改公式标签（仅 `+ - * /`、括号、整数/小数、标签引用） |
| `set` | `name`, `value` | 修改常量值（不存在则创建常量；对公式标签报错） |
| `remove` | `name` | 删除标签，下游公式进入 `unknown-dependency` |
| `undo` / `redo` | — | 撤销/重做上一次标签定义变更，恢复旧拓扑 |
| `commit` | — | 提交当前状态（`committed: true`） |

## 失效语义

- 公式只重算"变更标签 + 其可达下游"（每个版本的 `recomputed` 字段可见），无关分支不被污染。
- 失效原因：`cycle`（循环依赖）、`division-by-zero`（除零）、`unknown-dependency`（未知依赖）、
  `invalid-upstream`（上游失效传播）、`non-finite-result`（非有限结果）。
- 失效沿依赖方向传播到全部下游；拓扑顺序在并列时按标签名字典序确定性决断。

## 输出（result.json）

每个命令产生一个版本条目：`version`、`command`、`status`（`ok`/`noop`/`error`）、
`diff`（`added`/`removed`/`changed`/`invalidated`/`validated`）、`recomputed`、
`values`（失效标签为 `null`）、`invalid`（标签 → 原因）、`certificate`。
证书含 `seq`（序号）、`topo`（确定性拓扑排序）、`hashAlgorithm` 与
`hash`（规范 JSON 值哈希，键排序、无空白、SHA-256）。顶层 `final` 为最终状态。

## 退出码

- `0`：成功（命令级错误记录在该版本的 `status:"error"` 中，不中断后续命令）。
- `1`：输入非法或文件不可读，stdout 返回 `{"error":true,"code","message"}`，
  `code` 为 `INVALID_ARGS` / `FILE_UNREADABLE` / `INVALID_JSON` / `INVALID_INPUT` / `OUTPUT_UNWRITABLE`。

## 库用法

```js
const { RecipeEngine } = require('./src/engine');
const engine = new RecipeEngine();
engine.execute({ op: 'upsert', name: 'a', type: 'const', value: 2 });
engine.execute({ op: 'upsert', name: 'b', type: 'formula', expr: 'a * 3' });
console.log(engine.finalState().values); // { a: 2, b: 6 }
```

## 测试

`node --test` 运行 `test/` 下全部测试。验收测试（`test/acceptance.test.js`）包含：
多级随机配方与独立参考定点算法逐步对照、制造循环后下游失效/断环恢复/撤销恢复旧拓扑、
并列（菱形）依赖与除零边界；并把真实 CLI 运行的 stdout、stderr、退出码记录到
`test-results.txt`。
