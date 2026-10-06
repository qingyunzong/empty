# linearck — 线性命令借用检查库

`linearck` 对**线性命令**构成的控制流图做借用检查：支持共享借用与独占借用，
独占期间禁止别名访问，借用可转移（move）但不得比所有者活得更久，
分支汇合处要求借用状态兼容。所有违规都附带触发它的**违法路径**；
另提供一个独立的**有限命令状态枚举**参考实现用于交叉核验。

## 程序模型

程序是有限控制流图：`Program{Entry, Blocks}`，每个 `Block` 是直线命令序列，
`Next` 为后继块（0 个 = 退出，2 个 = 分支，自环 = 循环）。

命令（`Cmd`）：

| 命令 | 含义 |
| --- | --- |
| `new x` | 声明所有者 |
| `share r = &x` | 共享借用 |
| `mut m = &mut x` | 独占借用 |
| `use n` / `write n` | 读 / 写（所有者或引用） |
| `move d = s` | 转移借用，`s` 立即失效 |
| `end r` | 结束借用 |
| `drop x` | 所有者离开作用域 |

## 检查规则

规则常量见 `check.go`：

- `share-during-exclusive` / `exclusive-while-borrowed`：共享与独占互斥；
- `alias-during-exclusive`：独占借用存续期间禁止通过所有者别名访问；
- `write-while-borrowed` / `write-through-shared`：写需要独占；
- `use-after-move` / `move-of-invalid`：借用可转移，转移后旧名失效；
- `borrow-outlives-owner`：`drop x` 时仍有活跃借用，或使用悬垂引用；
- `merge-incompatible`：分支/循环汇合处各前驱的借用状态必须一致，
  否则报违规并给出两条冲突路径（分析仍继续，以发现后续违规）。

## 有限状态枚举与参考核验

- `Status` 是所有者的有限状态枚举：`dead / owned / lent / mut-borrowed`
  （`State.StatusOf`）。
- `Reference` 是独立实现的参考模型：深度优先穷举有限的 (块, 状态) 机器，
  使用独立的状态编码，不做合并推理。
- `Enumerate` 列出全部可达状态；`Replay` 沿报告路径重放以验证其可行性。
- 测试对全部手写程序和 500 个随机程序断言：`Check` 与 `Reference`
  报告的命令违规完全一致，且每个可达状态上 `StatusOf` 与独立的
  `refStatuses` 一致；每条违法路径都能被 `Replay` 复现。

## 运行测试

```sh
go test ./...
```

## 输出示例

```
alias-during-exclusive: use x at main[2]
  path: main -> main[0] -> main[1] -> main[2]
merge-incompatible: block join entered with incompatible borrow states
  path A: entry -> entry[0] -> right -> join
  path B: entry -> entry[0] -> left -> left[0] -> join
```
