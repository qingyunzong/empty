# midx 测试结果

环境：Python 3.14.4（仅标准库），Linux。所有命令在仓库根目录执行。

## 单元测试

命令：

    python3 -m unittest discover -s tests -v

结果：**Ran 7 tests, OK**（全部通过，约 2s）

| 测试 | 覆盖的验收点 |
|---|---|
| `test_4mib_build_and_full_verify` | 4MiB 随机文件建索引后全量 verify，CLI exit 0，`root` 输出一致 |
| `test_corrupt_block_17_local_verify` | 改第 17 块一字节，局部 verify 报块 17；未覆盖区间不误报；多坏块取最小块号 |
| `test_tail_block_actual_length` | 非 2 幂块长（1000），尾块按实际长度哈希 |
| `test_truncated_index_cli_exit_4` | 截断索引最后一字节，CLI exit 4 |
| `test_crc_mismatch_raises_indexerror` | 层 crc32 损坏抛 IndexError |
| `test_bad_magic_raises_indexerror` | 魔数错误抛 IndexError |
| `test_leaf_counts_1_to_40_against_brute_force` | 叶数 1..40 与暴力重算的全部 sha256 树逐层对照（含序列化往返） |

## CLI 实测（4MiB 随机文件，块长 65536，共 64 块）

    python3 -m midx build /tmp/midxdemo/d.bin --block-size 65536
    # root: c820eeb1760f95a39f93b418ab731f14af7124494b012adca6539f63063aefee

    python3 -m midx verify /tmp/midxdemo/d.bin
    # OK, exit=0

    # 翻转第 17 块一个字节后：
    python3 -m midx verify /tmp/midxdemo/d.bin --offset 1114112 --length 65536
    # BAD first bad block: 17 (all bad: [17]), exit=1

    # 截断索引最后一字节后：
    python3 -m midx verify /tmp/midxdemo/d.bin
    # index error: truncated or trailing bytes around root, exit=4

    python3 -m midx root /tmp/midxdemo/d.bin.index
    # 输出 32 字节根哈希 hex

## 索引格式

`MIDX` 魔数 | u32 块长 | u64 文件大小 | u32 叶数 | 各层（除根）哈希序列 + u32 crc32 | 32 字节根。
整数均为小端。完全二叉树自底向上，奇数节点复制自身，父哈希 = sha256(left+right)。
