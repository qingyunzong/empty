# backupverify

备份校验 CLI 与库：读取全量清单（manifest）和按父摘要链接的增量包
（package），按对象版本应用删除与替换，校验链的完整性。仅使用 Go 标准库。

## 数据模型

- **全量清单** `full.json`：`{"objects": [{"id", "version", "deleted?", "chunks?"}]}`，
  其摘要为链的根。
- **增量包** `pkg.json`：`{"parent": "<前驱摘要>", "ops": [...]}`，op 为
  `put`（替换 id@version 的内容，携带有序块引用）或 `delete`（墓碑化
  id@version）。包摘要覆盖 parent 与 ops。
- **块存储**：目录下以 sha256 十六进制命名的块文件；引用形如
  `sha256:<hex>`，校验存在性与内容哈希。

## 校验语义

串行清单解释器从清单开始逐包应用，任一失败即给出**最早失效边**
（position 0 为清单，1..n 为链中第 i 个包），且**不允许部分恢复**
（失败时不产出任何状态）：

- `missing-parent`：包的 parent 与当前链头摘要不一致（缺父包/断链）。
- `version-conflict`：同一对象版本被重复定义为不同内容（含墓碑与
  put 互斥）；内容完全相同的重复定义是幂等空操作。
- `missing-chunk`：引用的块缺失或内容哈希不符。

## 重排对照

`Reorder` 通过父摘要链接把任意顺序的包重建为链（断链、分叉报错）；
`CrossCheck` 用串行解释器分别跑原始输入顺序与重排后的链并对照结果
（成功时状态摘要一致，失败时失效边的原因与包摘要一致）。

## CLI

```
bvverify -manifest full.json -chunks <dir> [-reorder] pkg1.json pkg2.json ...
```

输出 JSON 报告；退出码：0 链有效，1 链失效，2 用法或 I/O 错误。
`-reorder` 接受乱序包输入：先按父摘要重排再校验，并在 `crossCheck`
字段中给出串行解释器对原始顺序的对照结果。

## 测试

```
go test ./...
```
