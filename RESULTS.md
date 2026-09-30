# bitsetix — 验收结果

实现：`bitsetix.py`（Python 3.11 标准库，`struct`/`zlib`/`unittest`），CLI 命令：
`maxdoc N` / `add TERM d...` / `query EXPR` / `save PATH` / `load PATH`（stdin 或文件参数）。
表达式中缀语法，`and`/`andnot` 优先级高于 `or`，左结合，支持括号；未知 term 一律按空集。

- 编码：每 term 按体积自动选择 sorted list（uint32）或 65536 块位图（ceil(N/8) 字节），load 后外部不可区分（TestD 断言两种编码同时出现且结果一致）。
- 文件格式：`BTSX` magic + version=1 + maxdoc + 每 term 记录（name/encoding/payload/CRC32）。
- 退出码：0 正常；2 add 越界；3 表达式括号/语法错误；4 文件校验失败（magic/version/长度/CRC），load 全程只读、校验全部通过后才提交状态，失败不修改原文件。

## 测试运行（真实输出）

```
$ python3 -m unittest test_bitsetix
Ran 14 tests in 5.026s
OK
```

覆盖：A 随机集合 vs Python set（7 组随机集合两两 and/or/andnot + 200 个随机嵌套表达式全量对照）；
B 全空/全集/单元素/跨 65536 块边界（0,1,65535,65536,65537,131071,131072,N-1）；
C 篡改 CRC 末字节、payload 中间字节、name 长度字段、截断、version、magic → 均 exit 4 且文件字节不变；
D save/load 前后 5 个表达式结果逐一相等（库内与 CLI 双路径），输出升序。

## CLI 运行记录（N=200000，种子 42；alpha/beta 各 30000 随机 docid，gamma 80000，boundary 8 个边界值，full 全集，empty 空集）

| 查询 | 结果大小 | sha256(升序输出) 前16位 |
|---|---|---|
| `alpha and beta` | 4559 | `b51598b38dee3da6` |
| `alpha or beta` | 55441 | `817c9168cd051a8b` |
| `alpha andnot beta` | 25441 | `24bd67712522c62f` |
| `(alpha or beta) andnot gamma` | 33397 | `ec2d2dce13724143` |
| `alpha and (beta or gamma)` | 14771 | `acd688096f77260b` |
| `nosuch or alpha` | 30000 | `c6827c84838212f0` |
| `nosuch and alpha` | 0 | `e3b0c44298fc1c14` |
| `alpha andnot nosuch` | 30000 | `c6827c84838212f0` |
| `boundary and full` | 8 | `458416d97c9b262b` |
| `full andnot boundary` | 199992 | `5da0359532f38026` |
| `empty or empty` | 0 | `e3b0c44298fc1c14` |

save（exit 0，文件 100165 字节）→ load → 同样 11 条查询输出与 save 前逐字节一致（`diff` 为空）。

## 退出码实测

| 场景 | 命令 | 退出码 |
|---|---|---|
| 正常批量执行 | `python3 bitsetix.py script.txt` | 0 |
| add 越界（N=10, add 10） | `add t 5 10` | 2 |
| 括号不配对 | `query (a and a` | 3 |
| CRC 篡改（末字节翻转） | `load tampered.bsx` | 4 |
| 长度字段篡改（name_len 翻转） | `load tampered_len.bsx` | 4 |
