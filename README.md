# leasequota

下载库：以租约（lease）预留磁盘配额，Go 标准库实现，无任何第三方依赖。

## 设计

- `Quota` 把总额度拆成 **used**（已提交文件占用）与 **reserved**（在途下载的预留）。
  不变量：`used + reserved <= total`，所有计数变更都在同一把锁内完成，任意时刻成立。
- `Lease` 是一次下载持有的配额预留，只能被 `Commit` 或 `Release` 关闭一次：
  - `Commit(n)`：把实际写入的 `n` 字节转为 used，剩余预留立即返还（短写精确返还）；
  - `Release()`：取消下载，全额返还预留；
  - `Grow(n)`：源端实际长度超过声明长度时按需扩租，额度不足则失败且租约不变；
  - 提交后租约已关闭，再 `Release`/`Commit`/`Grow` 均报错，额度不变（提交后不可再取消）。
- `Store`/`Download` 负责文件侧：先写临时文件，`Commit` 时 fsync + 原子 rename，
  然后才按实际写入字节数结算租约。提交任一环节失败（含注入的 `Hooks.BeforeCommit` 失败）
  都会删除临时文件并全额返还预留。`Delete` 删除已提交文件并释放对应 used 额度。

## 测试覆盖（`go test ./...`）

- 精确预留/提交、短写返还、取消返还、超额预留失败、超 outstanding 提交失败；
- 提交后不可取消、租约关闭后不可复用、扩租成功/失败、`Free` 边界；
- 下载维度：短写提交、取消、注入提交失败、提交后取消报错、文件长度变大
  （额度内扩租成功 / 超额度写入失败并取消）、删除释放 used；
- 并发：16 协程随机预留/扩租/提交/取消 + 不变量采样（`TestConcurrentInvariant`）；
  8 协程交错下载（随机短写/变长/取消/注入提交失败）与删除
  （`TestInterleavedDownloadsAndDeletes`），全程校验 `used+reserved <= total`，
  结束后核对配额计数、Store 记录与磁盘文件三者一致且无残留临时文件。

## 实际测试结果

见 `TEST_RESULTS.md`。
