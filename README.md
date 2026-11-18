文件系统需要供命名空间操作调用的 Go 配额计数库，对硬链接计数、目录树大小与
inode 用量精确守恒，处理重命名与删除。重命名只在原子步骤更新两棵子树的聚合，
硬链接增减与 inode 计数一一对应，目录树大小包含全部后代。用操作历史穷举，对照
朴素逐文件求和核对每个目录的计数与大小，并发重命名与删除交错时不重不漏。

## 模型

`formal.FS` 是一个内存中的文件系统命名空间，根目录为 `/`。每个目录维护整个子树
的 `Usage`：

- `Links`：子树中的命名空间条目（硬链接）总数，包含指向子目录的条目。
- `Inodes`：子树中引用的不同 inode 数。硬链接共享同一个 inode。
- `Bytes`：子树中不同 inode 的大小之和。一个文件即使有多条硬链接，也只计一次。

目录自身的大小为 0；`Usage` 描述目录下面的条目，不包含目录自身的 inode。
`GlobalUsage` 返回全局活跃 inode（含根 inode）、链接和字节总数。

## API

```go
fs := formal.New()

_ = fs.MkdirAll("/data/project")
_ = fs.CreateFile("/data/project/a", 4096)
_ = fs.Link("/data/project/a", "/data/a-link") // 硬链接
_ = fs.Rename("/data/project/a", "/data/project/b")
_ = fs.Remove("/data/a-link")

usage, _ := fs.Stats("/data")   // 维护好的聚合值
naive, _ := fs.NaiveStats("/data") // 朴素重新遍历，用于审计
_ = fs.Check()                  // 校验整棵树的全部不变量
```

常用操作：`Mkdir`、`MkdirAll`、`CreateFile`/`Create`、`Link`/`HardLink`、
`LinkInode`、`Remove`/`Unlink`、`Rmdir`、`RemoveAll`、`Rename`、`Stats`/`Stat`、
`NaiveStats`、`Dirs`、`GlobalUsage`、`Inode`、`InodeLinks`、`Check`。

## 重命名与并发

`Rename` 在一次加锁的原子步骤中完成：

1. 若目标存在，先按普通 rename 语义替换。
2. 只沿源父目录到最近公共祖先、目标父目录到最近公共祖先这两条分支更新聚合。
3. 公共祖先的链接数、不同 inode 数和字节数都不变，因为移动的条目仍在其子树中。

移动目录时，会收集整个闭包中每个 inode 的链接数，因此跨边界的硬链接也能正确
增减：源分支中最后一个引用离开时扣除 inode 和字节，目标分支中第一次出现时加入
inode 和字节。`RemoveAll` 与并发的 rename/delete 由同一把读写锁串行化，读操作
只会看到操作前或操作后的完整状态。

## 测试

`go test ./...` 包含：

- 基础计数、硬链接、替换 rename、跨分支目录 rename、`RemoveAll` 等定向测试。
- 操作历史穷举：从固定初始结构出发，遍历所有可达命名空间状态，每个状态和状态
  迁移都用 `Check` 校验，并把每个目录的维护值与 `NaiveStats` 的逐条目求和对比。
- 并发压力测试：多个 goroutine 交错执行硬链接增删、文件/目录 rename 和递归删除，
  同时持续运行 `Check`；建议用 `go test -race ./...` 验证。
