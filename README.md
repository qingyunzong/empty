# dirswap

目录原子替换 CLI,用于更新程序发布新版本目录。仅使用 Go 标准库。

## 用法

```
dirswap publish -target <dir> -source <dir>   # 原子替换目标目录
dirswap recover -target <dir>                 # 完成未竟事务(重启后唯一允许的动作)
```

## 拒绝条件(publish)

- 目标目录自身是符号链接,或其内部任意位置含符号链接(`ErrSymlink`)。
- 源目录或目标目录与目标父目录不在同一文件系统(跨设备 rename 无法原子完成,
  目标为挂载点亦拒绝)(`ErrCrossDevice`)。
- 已存在未完成的事务日志(`ErrPendingTransaction`):重启后只能完成同一事务,
  不得另起新事务。

## 崩溃恢复协议

事务日志(持久意图记录)写在目标父目录下的 `.<name>.dirswap.journal`,
采用 写临时文件 → fsync → rename → 父目录 fsync 的方式落盘。事务分四步:

1. **staged**:源目录 rename 为 `.<name>.staging-<id>`
2. **retired**:旧目标 rename 为 `.<name>.retired-<id>`
3. **published**:暂存目录 rename 到目标路径
4. 删除退役目录,删除日志

每次 rename 前后都可能崩溃;rename 后、日志更新前崩溃会使磁盘状态领先日志
一步,因此恢复时以文件系统实际状态为准(日志阶段仅作参考),逐步幂等推进,
恰好完成日志中记录的同一事务。

## 不误删外部路径

- 日志加载时校验:staging/retired 路径必须等于由事务 ID 派生的预期路径、
  且位于目标父目录内,否则判定日志被篡改/损坏,拒绝执行任何操作。
- 删除退役目录前再次校验:路径必须等于派生路径、必须是真实目录(非符号链接)、
  内部不得含符号链接,任一不满足即拒绝删除。

## 测试结果

实际运行(2026-10-05,go1.27.1 linux/amd64,因默认构建缓存只读而使用
`GOCACHE=/tmp/gocache`):

```
$ go test ./...
ok  	dirswap	0.057s
```

13 个测试全部通过,覆盖:正常替换、全新目标、目标内/目标自身符号链接拒绝、
跨文件系统源拒绝、6 个 rename 前后崩溃点逐一恢复、恢复幂等(恢复中再次崩溃)、
pending 时拒绝新事务、无 pending 时 recover 报错、伪造日志指向外部路径拒绝删除、
retired 路径被植入符号链接拒绝删除、进程重启后从磁盘日志恢复。

注:本环境工具链中 `crypto/rand` 不可用(工具链本身问题),事务 ID 改用
纳秒时间戳 + PID + 原子计数器生成,仍为标准库。
