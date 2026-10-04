# tx-state

事务式整数状态脚本库（TypeScript，仅依赖 Node.js 内置模块）。

## 语义

- **整数状态**：`get/set/add` 操作命名整数变量（缺省 0），只接受安全整数，否则抛 `TypeError`。
- **嵌套保存点**：`begin/commit/rollback` 构成层栈。内层 `rollback` 只撤本层；内层 `commit` 把变更与暂存动作合并进父层。
- **外部动作暂存**：`stage(action)` 把外部动作挂到当前层；任何回滚都会丢弃本层暂存；只有最外层（根层）`commit` 才真正发布（进入 `published()`）。
- **异常捕获**：`capture(fn)` 在新保存点中执行 `fn`；抛异常时仅回滚该保存点并返回 `{ ok: false, error }`，成功则合并并返回 `{ ok: true, value }`。
- **预算终止**：`set/add/stage` 各消耗 1 单位预算（`new TxState({ budget })`，默认无限）。超预算时全部打开层回滚到最近提交的基线、丢弃所有暂存动作、抛 `BudgetExceededError`；`capture` 不会吞掉该异常。终止后库可继续使用，预算重新计数。

## 实现与模型

- `src/txstate.ts`：增量实现——单一变量表 + 每层撤销日志与暂存列表。
- `test/model.ts`：复制栈参照模型——每个保存点物理复制整张变量表与暂存列表，语义直白。
- `test/random.ts`：种子化随机程序生成器与解释器，对两种实现回放同一操作序列，逐条比对读数、深度、异常类型与已发布动作。

## 测试

```sh
npm test            # tsc 编译 + node --test（默认 500 个随机种子）
SEEDS=2000 npm test # 加大差分测试规模
```
