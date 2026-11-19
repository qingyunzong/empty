事务管理器需要供执行引擎调用的Go保存点库：保存点按命名压栈，可嵌套建立；回滚到指定保存点须撤销其后全部内层保存点及其持有的锁与资源登记，被撤销的修改按登记逆序归还，目标保存点本身保留；释放保存点只移除该层而不影响更内层归属。重复建立同名保存点、回滚或释放不存在的名字、在空栈上回滚都要返回明确错误且不改变状态。输入带序号的建立、回滚、释放和资源登记事件，输出每步保存点栈、各资源当前归属和错误。用独立朴素状态机逐事件差分，并穷举嵌套回滚后再建立、跨层释放和空栈边界，期望结果不得由被测包生成。

## savepoint 包

实现位于 `savepoint/`，供执行引擎通过 `savepoint.Manager` 调用：

- `Establish(name)`：命名保存点压栈，栈上已存在同名时返回 `ErrDuplicateSavepoint` 且状态不变。
- `Register(Record)`：把锁（`RecordLock`）或资源（`RecordResource`）登记到当前栈顶层；空栈时返回 `ErrNoActiveSavepoint`。
- `Rollback(name)`：弹出目标保存点之后的全部内层，按登记逆序归还其持有的记录（`Undone`），目标层本身保留；空栈返回 `ErrEmptyStack`，名字不存在返回 `ErrSavepointNotFound`。
- `Release(name)`：仅移除该层，其记录重新归属父层（最外层释放后归引擎/根，归属名为空字符串），更内层保存点及其归属不受影响。
- `Apply(Event)`：按带序号事件分发，返回 `StepResult`（栈快照、资源归属表、撤销记录、错误）。
- 所有失败操作均返回哨兵错误（可用 `errors.Is` 匹配）并保持状态不变；`Stack`/`Owners` 返回防御性拷贝。

## 验证方式

测试位于外部测试包 `savepoint_test`，预言机与被测包完全独立（扁平表实现，见 `savepoint/oracle_test.go`）：

- `TestGoldenScenario`：手工黄金序列，逐字定期望的栈、归属、逆序撤销与错误类。
- `TestExhaustiveDifferential`：BFS 枚举预言机全部可达状态（去重），每个状态对所有候选事件差分，覆盖回滚后再建立、任意深度跨层释放、重复登记与空栈边界。
- `TestInvalidOperationsAreAtomic`：直接校验错误原子性与访问器防御性拷贝。

运行：`go test ./... -race -cover`。
