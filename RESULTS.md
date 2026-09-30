# bitsetix 验收结果（真实运行记录）

日期：2026-09-30；解释器：Python 3.14.4（仅标准库）；测试框架：unittest。

## 单元测试（A/B/C/D 全部通过）

```
$ python3 -m unittest -v
Ran 17 tests in ~4s
OK
```

- A 随机集合对照：`TestARandomVsPythonSet`（N=200000，11 个随机/稠密集合，seed=20260930）
  and/or/andnot 及嵌套表达式与 Python set 全量对照，重复查询无副作用 — 4 tests OK
- B 边界：`TestBEdgeCases`（全空、全集、单元素、docid 0/65535/65536/131071/131072/N-1 跨块，
  并断言文件同时含 list(0x01) 与 bitmap(0x02) 两种编码且 load 后不可区分）— 5 tests OK
- C 篡改：`TestCTamper`（CRC 字节、payload 字节、头部长度字段、截断、追加、magic、version）
  全部 exit 4 且原文件 sha256 不变 — 5 tests OK
- D 一致性：`TestDSaveLoadConsistency`（7 个表达式在 save→load 前后 CLI 输出逐行相同）— 1 test OK
- 退出码：`TestExitCodes`（越界 add exit 2，8 种括号/语法错误 exit 3）— 2 tests OK

## CLI 演示（N=200000）

集合：sparse={1,2,3,65535,65536,131072,199999}，dense={0..10,65536,65537,199998,199999}，
ghost 为未知 term（按空集参与）。脚本含 save→load，之后重复前三个查询。

退出码：`exit=0`；load 前后三行查询输出逐字节一致。

| 表达式 | 结果 | 结果集 sha256（每行一个 docid） |
|---|---|---|
| and(sparse, dense) | 1 2 3 65536 199999 | bec3c7ef7038ff6b6a969c00256af35716bc88861c21b540bb3dbecba78941f2 |
| or(sparse, dense) | 0..10,65535,65536,65537,131072,199998,199999（17 个） | f321dfac887bf4fe8aff445e77420e136d414710585022cb9cdb68c8a5cdef62 |
| andnot(sparse, dense) | 65535 131072 | f120b5d05a22d7f6afbd2863a26be26c16cff9d90171776c02d22e15ede78c23 |
| andnot(sparse, ghost) | = sparse（未知 term 按空集） | 2e60783f44bf3e3ff5378534f0640f02b15f3a8327503d8ef807ee099e403933 |
| or(sparse, ghost) | = sparse | 2e60783f44bf3e3ff5378534f0640f02b15f3a8327503d8ef807ee099e403933 |
| and(ghost, sparse) | 空（合法，输出空行） | e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855 |
| andnot(sparse, sparse) | 空 | e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855 |

保存文件 `idx.bsx`：141 字节，sha256 =
`f63f2e31ffbef0ad50d72e4df35e0aaaf361afd30f4e09cd5845ecaa5ea1a36a`

## 退出码实测（CLI 子进程真实返回值）

| 用例 | 退出码 | stderr |
|---|---|---|
| 正常脚本（含 save/load） | 0 | — |
| `add t 10`（maxdoc 10，越界） | 2 | range error: docid 10 out of range [0, 10) |
| `query and(a, b`（括号不配对） | 3 | expression error: expected ')', got None |
| 篡改：最后一字节 CRC 翻转 | 4 | corrupt file: CRC mismatch for term 'sparse' |
| 篡改：payload 中间字节翻转 | 4 | corrupt file: CRC mismatch for term 'dense' |
| 篡改：头部 term-count 字段 | 4 | corrupt file: unexpected end of file |
| 篡改：截断 10 字节 | 4 | corrupt file: unexpected end of file |
| 篡改：追加 junk | 4 | corrupt file: trailing bytes |
| 篡改：version 字段 | 4 | corrupt file: unsupported version 238 |

篡改用例恢复原始文件后再次 `load`：exit=0，且 load 前后文件 sha256 相同
（`file_unchanged=True`），即校验失败/成功均不修改原文件；save 通过临时文件加
`os.replace` 原子写入。
