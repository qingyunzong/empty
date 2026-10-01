# mtc — 迷你模块类型检查器

纯 Python 3.11 标准库实现，无第三方依赖。

## 语言

模块 = 目录下的 `<name>.mt` 文件，模块名即文件名（不含扩展名）。

```
import b                          # 导入模块 b，其顶层名字进入作用域
let x: Int = 1                    # 带注解的绑定
let y = x + 1                     # 类型推断
fn f(a: Int, b: Bool) -> Int = a  # 函数（参数/返回类型必须注解）
```

- 类型：`Int`、`Bool`；字面量为整数与 `true`/`false`；表达式支持 `+`、调用、括号；`#` 为行注释。
- 名字查找顺序：函数参数 → 本模块顶层（按出现顺序）→ 导入模块的导出。
- 未定义名字报 `E_NAME` 后按未知类型处理，不产生级联报错。

## CLI

```
python -m mtc load <dir>    # 加载目录、建依赖图、全量检查，写入 .mtc_state.json
python -m mtc check         # 从磁盘全量重查已加载工程
python -m mtc patch <file>  # 增量重查：仅该模块及其传递依赖者
```

- 诊断输出格式 `file:line:code: message`，按 `(file, line, code)` 排序，输出到 stdout。
- 退出码：`0` 无诊断；`1` 有诊断；`2` 用法/IO 错误；`3` 检测到导入环。
- `check` / `patch` 需在与 `load` 相同的工作目录下运行（状态文件 `.mtc_state.json` 位于 cwd）。

## 语义要点

1. **无环依赖**：`load`/`check`/`patch` 任一操作发现环即整体失败（exit 3），状态文件不被修改（原子失败）。
2. **确定性增量重查**：`patch` 只重查被改模块及其传递依赖者（按拓扑序、堆序确定），未依赖模块的诊断逐字节不变。
3. **错误隔离**：某模块的类型/名字错误不影响无依赖关系的其它模块通过。
4. **no-op patch**：文件内容 SHA-256 与状态一致时输出 `no-op`，状态不变。
5. **错误码**：语法 `E_PARSE`，未定义名字 `E_NAME`，类型错误 `E_TYPE`，环 exit 3。

## 结构

- `mtc/lang.py` — 词法、递归下降语法分析、AST、类型表示
- `mtc/checker.py` — 单模块类型检查（仅依赖被导入模块的导出环境）
- `mtc/core.py` — 依赖图（环检测/拓扑序/传递依赖者）、状态、load/check/patch
- `mtc/cli.py` — 命令行入口

## 测试

```
python -m unittest discover -s tests -v
```

最近一次实际运行结果：**35 个测试，35 通过，0 失败**（`Ran 35 tests ... OK`）。

覆盖验收项：

- A（`tests/test_cli.py::TestAcceptanceA`）：改接口只影响导入方，无关模块诊断不变
- B（`TestAcceptanceB`）：坏模块不污染独立模块
- C（`TestAcceptanceC`）：load/patch 引入环均原子失败（exit 3，状态不变）
- D（`tests/test_incremental.py`）：30 个随机种子工程 × 6 次随机 patch，增量结果与全量重查诊断集合逐一比对一致
