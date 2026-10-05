# storecli — 崩溃安全的页式存储整理 CLI

仅使用 Go 标准库。外部引用通过**稳定页 ID** 解析；整理（compaction）把活页
搬入紧凑段，并将**搬迁结果与引用更新在同一代（generation）内原子发布**。

## 磁盘布局

```
COMMIT            已提交代（8 字节代号 + CRC32），tmp+rename 原子替换
idx-NNNNNN.log    该代的索引日志：头部 + 追加式条目（页ID→位置，逐条 CRC32）
seg-NNNNNN.dat    段文件：magic + 页ID + 长度 + 负载 + CRC32（逐页摘要）
```

## 一致性协议

1. `put`：记录追加到活段并 fsync，索引条目追加到当前代索引日志并 fsync。
2. `compact`：
   - 复制活页到新紧凑段（逐页校验源页 CRC32），fsync；
   - 新代索引日志写 tmp、fsync、rename、fsync 目录；
   - **COMMIT 原子 rename —— 唯一发布点**，搬迁与引用更新同代生效；
   - 退役旧段与旧索引日志，fsync 目录。
3. 恢复（`Open`）：只信任 COMMIT 指定的代；未提交段、他代索引、tmp 文件
   全部回收；被引用段缺失则报错。掉电后要么旧引用完整、要么新引用完整。

## 故障注入边界（测试用）

`FaultInjector` 可在以下边界注入 `ErrCrash`（模拟掉电）：
`FaultBeforeCopy`、`FaultAfterCopy`、`FaultAfterIndexFlush`、
`FaultAfterCommit`、`FaultDuringRetire`（复制 / 索引刷盘 / 提交 / 退役边界）。

## 用法

```sh
storecli put     -dir D -id N -data STR
storecli get     -dir D -id N
storecli list    -dir D
storecli compact -dir D
storecli verify  -dir D   # 逐页核对 CRC32 摘要 + 回收范围审计
```

`verify` 审计：被引用段必须存在、盘上不得有未引用段/临时文件/他代索引、
每页记录必须通过 CRC32 校验。

## 测试

见 `TEST_RESULTS.md`（`go test ./...` 实际输出）。
