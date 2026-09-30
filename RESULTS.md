# pcomp 实现与验收结果

日期：2026-10-01 ｜ 运行环境：Python 3.14.4（仅标准库，语法兼容 3.11）｜ 测试框架：unittest

## 文件格式

```
[0:4]   magic "PCMP"
[4:8]   version u32 LE (=1)
[8:16]  dict_offset u64 LE
[16:20] crc32 u32 LE（覆盖 [20:EOF]，即 postings + 字典）
[20:dict_offset]  postings 区
[dict_offset:EOF] term 字典（num_terms u32；每项：term_len u16, term, offset u64, length u64, num_docs u32）
```

Posting 每 128 个 docid 一块：`count u8`（1..128，末块不足 128 时即真实长度）+ 块首 docid varint + 后续 gap varint（严格为正）。lookup 只读字典与目标 term 的 posting 字节区间，不解压全库。

## 单元测试（A–D 验收）

命令：`python3 -m unittest test_pcomp -v`

真实结果：**Ran 17 tests in 0.724s — OK**（17/17 通过）

- A 随机对照：`TestRandomRoundTrip.test_random_roundtrip` — 30 组随机 term 集合与内存 dict 全量对照，ok
- B 边界：`test_boundary_docids`（docid 0、2^32-1）、`test_block_sizes`（单元素、恰 128/129/256/257）、`test_empty_index`、`test_term_with_empty_postings`，均 ok
- C 损坏定位：`test_flip_header_magic/version/dict_offset/crc`、`test_flip_postings_byte`、`test_flip_dictionary_byte`、`test_truncated_file`、`test_length_out_of_bounds` — 均断言 exit 4、stderr 含 "Corrupt"、stdout 为空（不得部分返回），ok
- D 重复与空表：`test_duplicate_docids_deduped`、`test_unsorted_input_sorted`、`test_empty_term_table_cli`，均 ok

## CLI 实测

输入 `demo/input.txt`（含重复 docid、乱序、空 posting、边界 docid）：

```
apple 3 1 2 2
banana 9
apple 4
cherry
maxid 4294967295 0
```

| 命令 | 退出码 | 输出 |
|---|---|---|
| `build demo/input.txt demo/index.pcf` | 0 | `built demo/index.pcf: terms=4 bytes=148` |
| `lookup demo/index.pcf apple` | 0 | `1 2 3 4`（每行一个，去重并排序） |
| `lookup demo/index.pcf maxid` | 0 | `0`、`4294967295` |
| `lookup demo/index.pcf ghost` | 0 | （空） |
| `scan demo/index.pcf` | 0 | `OK terms=4 docs=7` |

SHA-256：

- `demo/index.pcf` = `e0e13639a362eed6d39c0e53a6fe5e3e79b54deeb632565b5331dd3a53482398`

### 空索引

| 命令 | 退出码 | 输出 |
|---|---|---|
| `build demo/empty.txt demo/empty.pcf` | 0 | `built demo/empty.pcf: terms=0 bytes=24` |
| `lookup demo/empty.pcf ghost` | 0 | （空） |
| `scan demo/empty.pcf` | 0 | `OK terms=0 docs=0` |

- `demo/empty.pcf` SHA-256 = `f7ca44bec84107a9860166af32dbba1c841bc5681c661be99be189603c0f8f82`

### 损坏注入（对 index.pcf 各区域翻转 1 字节，dict_offset=34，文件 148 字节）

| 文件 | 翻转位置 | lookup 退出码 | scan 退出码 | stderr |
|---|---|---|---|---|
| `demo/corrupt_0.pcf` | 0（头部 magic） | 4 | 4 | `Corrupt: bad magic` |
| `demo/corrupt_30.pcf` | 30（posting 区） | 4 | 4 | `Corrupt: CRC32 mismatch` |
| `demo/corrupt_140.pcf` | 140（字典区） | 4 | 4 | `Corrupt: CRC32 mismatch` |

SHA-256：

- `demo/corrupt_0.pcf` = `f3d821ca3b6c859b114d1b69f7bb7e76bb4bb225f30c43afd30bb969e3682860`
- `demo/corrupt_30.pcf` = `ccf1a01e962ae6f537e03a8ba0f6c409a6c249ae5e1374aa66c49d4e716f587f`
- `demo/corrupt_140.pcf` = `5a4c6623d1cad1d32670bc7fb195feac131277b1561c5ba6d8dbbc61d049d61a`

另：`test_length_out_of_bounds` 在修正 CRC 后篡改字典中的 length 为 10^9，验证长度越界同样报 Corrupt/exit 4（覆盖"CRC 通过但结构非法"路径）。
