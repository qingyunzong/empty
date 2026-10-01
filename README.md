# mmcheck — 迷你模块类型检查器

一个纯 Python 3.11+ 标准库实现的迷你模块类型检查器，支持按导入依赖进行
确定性增量重查，且各模块的错误状态相互隔离。

## 语言

每个 `.mm` 文件是一个模块（模块名 = 文件名去扩展名），每行一条语句：

```
import util                          # 导入模块，将其导出名字引入作用域
let x: Int = 1                       # 带类型注解的 let
let y = x + 1                        # 类型推断（Int）
fun add(a: Int, b: Int) -> Int = a + b   # 函数
let z: Int = add(x, y)               # 调用
```

- 唯一类型：`Int` 与函数类型 `(Int, ...) -> Int`
- 表达式：整数字面量、变量、`+` / `*`（含优先级）、调用、括号
- `#` 开头为注释；允许前向引用；`import` 的名字不再次导出

## CLI

```
python -m mmcheck load <dir>     # 加载并全量检查目录下所有 .mm 模块
python -m mmcheck check          # 对已加载项目做全量重查（诊断 id 重排为 1..n）
python -m mmcheck patch <file>   # 只重查该文件所属模块及其传递依赖者
```

状态保存在当前目录的 `.mmcheck.json`（含项目目录、各模块导入/导出接口、
诊断及其稳定 id）。

### 退出码

| 码 | 含义 |
|----|------|
| 0  | 成功，无诊断 |
| 1  | 成功，存在诊断 |
| 2  | 用法/状态错误（如未 load 就 check） |
| 3  | 检测到导入环（load/patch 原子失败，状态不被修改） |

### 诊断输出

```
#3 user.mm:2: E_TYPE: expected 2 argument(s), got 1
```

格式为 `#<id> <file>:<line>: <code>: <message>`，输出按
`(file, line, code)` 排序。错误码：`E_PARSE`（语法）、`E_NAME`（未定义/
重复定义/未知模块）、`E_TYPE`（类型不匹配）。

## 增量语义

- **确定性**：全量检查按拓扑序（Kahn，堆按模块名 tie-break）检查模块，
  诊断 id 按 `(file, line, code)` 顺序从 1 开始分配。
- **patch 重查范围**：被 patch 模块 ∪ 其在新旧两张导入图中的传递依赖者。
  依赖的导出接口持久化在状态里，未受影响模块不会被重新读取或重查，
  其诊断（含 id 序号）保持不变。
- **no-op**：patch 内容与已加载状态相同（SHA-256 一致）时不改任何状态。
- **错误隔离**：模块的导出接口与诊断按模块独立存储；一个模块的
  类型/语法错误不会使不依赖它的模块失败（依赖它的模块按新接口重查，
  例如依赖方会因名字缺失得到自己的 `E_NAME`）。
- **环原子性**：load 或 patch 后若导入图有环，命令以退出码 3 失败，
  已保存的状态完全不被修改。

## 项目结构

```
mmcheck/lang.py      词法、语法分析（E_PARSE）
mmcheck/checker.py   单模块类型检查（E_NAME / E_TYPE），惰性解析 let
mmcheck/project.py   依赖图、环检测、拓扑序、全量/增量检查、状态持久化
mmcheck/cli.py       load / check / patch 子命令与退出码
tests/               unittest 测试（单元 + CLI 端到端 + 随机对照）
```

## 测试

```
python -m unittest discover -s tests -v
```

覆盖验收标准：

- **A**（改接口只影响导入方）：`TestPatch.test_interface_change_only_affects_importers`
- **B**（坏模块不污染独立模块）：`TestIsolation`
- **C**（环原子失败）：`test_cycle_fails_atomically_exit3`、
  `test_patch_introducing_cycle_fails_atomically`
- **D**（随机小工程增量 vs 全量对照）：`TestFuzzIncremental`，
  3 个随机种子 × 5 模块工程 × 6 步随机 patch，逐步断言增量诊断集合
  与全量 `check` 一致，且未重查模块的诊断 id 不变。

### 最近一次真实测试结果

```
Ran 38 tests in 21.877s

OK
```

**38 通过 / 0 失败**（Python 3.14.4，2026-10-01 运行）。
