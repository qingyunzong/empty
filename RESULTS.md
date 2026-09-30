# pcomp 验收结果（真实运行记录）

运行环境：Python 3.14.4（代码仅使用 Python 3.11 标准库：`argparse`/`os`/`struct`/`sys`/`zlib`/`unittest`），Linux x86_64，日期 2026-10-01。

## 文件格式

- 头（24B）：magic `PCOMPIDX`(8B) + version uint32 + dict_offset uint64 + header CRC32
- posting 块：`count` uint8（1..128，末块不足 128 以 count 标记长度）+ `payload_len` uint32 + LEB128 gap 序列（首值存 docid 本身，之后存差值）+ 块 CRC32
- 字典：term_count + 每词条（term_len/term/offset/length/doc_count）+ 字典 CRC32
- 退出码：0 正常（term 不存在也返回 0、空输出）；4 任何 CRC/magic/长度越界（报 `Corrupt`，无部分输出）；2 用法/IO 错误

## 单元测试（python3 -m unittest test_pcomp）

```
Ran 14 tests in 0.988s
OK
```

覆盖验收项：

- A `TestRandomRoundTrip`：200 个随机 term（含 127/128/129/300/1000 docid 档）与内存 dict 全量对照；另验证损坏 `aaa` 的块后 `lookup zzz` 仍成功（lookup 只读相关块，不解压全库），而 `scan` 报 Corrupt
- B `TestBoundaries`：docid 0 与 2^32-1、单元素、恰 128/129 个；并断言 129 个时第二块 count=1（末块长度标记）
- C `TestCorruption`：分别翻转头部/字典/posting 三处字节，lookup 与 scan 均断言 exit 4、stderr 含 `Corrupt`、stdout 为空；另含截断文件用例
- D `TestDuplicatesAndEmpty`：重复 docid 去重、乱序输入库内排序、空索引可 build/lookup/scan、空 term 被丢弃

## CLI 真实运行

输入 `demo/input.txt`：

```
apple 3 1 2 2
banana 4294967295 0
apple 7
cherry 100 200 300
```

| 命令 | 输出 | 退出码 |
|---|---|---|
| `pcomp.py build input.txt demo.idx` | `built demo.idx: 3 terms, 155 bytes` | 0 |
| `pcomp.py build empty.txt empty.idx` | `built empty.idx: 0 terms, 32 bytes` | 0 |
| `pcomp.py lookup demo.idx apple` | `1 2 3 7`（去重+排序+跨行合并） | 0 |
| `pcomp.py lookup demo.idx banana` | `0 4294967295` | 0 |
| `pcomp.py lookup demo.idx missing` | （空输出） | 0 |
| `pcomp.py lookup empty.idx anything` | （空输出） | 0 |
| `pcomp.py scan demo.idx` | `OK: 3 terms, 9 docids` | 0 |
| `pcomp.py scan empty.idx` | `OK: 0 terms, 0 docids` | 0 |

损坏定位（对 demo.idx 各区域翻转 1 字节，dict_offset=64，文件 155B）：

| 文件 | 翻转位置 | scan / lookup 输出 | 退出码 |
|---|---|---|---|
| `corrupt_header.idx` | 头部 offset 3 | `Corrupt: bad magic` | 4 |
| `corrupt_posting.idx` | posting offset 29 | `Corrupt: block CRC mismatch` | 4 |
| `corrupt_dict.idx` | 字典 offset 70 | `Corrupt: dictionary CRC mismatch` | 4 |

## SHA-256

```
c4ac138eaf65c952a847146464db5d80df0db13f8fb3aa04c6a570f3827989f3  demo/demo.idx
2808ecba64c08e50c2b29f7985e57e2a673cc5f3d0d10005db914560ef0995d1  demo/empty.idx
3d9ec43072c0cbfdc224deb45c4f28233eb5c17e412c243fded2977606c7d5dc  demo/corrupt_header.idx
6d3f1dfa7ed0a18c12e637541c5ddcc66610d2e812eebc823adb5b8875813816  demo/corrupt_posting.idx
b9e29abad9dd4708cc98fb176319b9a788fea3337e2e3871f580ff5b565f2bf2  demo/corrupt_dict.idx
```
