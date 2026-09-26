# 压缩文档ID差分列表与跳跃块

纯标准库（Python 3.11）实现的压缩倒排列表：差分编码 + zigzag/varint 压缩 +
跳跃块（skip blocks），支持交 / 并 / 差集合运算与 `advance(target)` 跳跃定位，
并统计实际解码块数。文档为本地合成的 UTF-8 文本，不使用任何搜索服务或全文检索库。

## 文件结构

- `posting_list.py` — 差分编码、跳跃块、游标（`next` / `advance`）、交并差、解码统计
- `tokenizer.py` — UTF-8 分词器（规则见下）
- `inverted_index.py` — 迷你倒排索引（演示用）
- `demo.py` — 运行样例
- `test_posting_list.py` / `test_index.py` — unittest 测试

## 编码格式

- 文档ID必须是**严格递增**的正整数，构建时校验，违反抛 `ValueError`。
- 相邻ID的差分 `delta = id[i] - id[i-1]`（约定 `id[-1] = 0`），正常数据恒有 `delta >= 1`。
- delta 先经 **zigzag** 变换再做 **varint（LEB128）** 编码。zigzag 让负差分也能被
  解码出来，因此损坏数据一旦产生 `delta <= 0`（ID 倒退或重复）即抛出
  `CorruptedDeltaError` 被明确拒绝。
- 列表按固定块大小切分，头部跳跃表记录每块 `(块内最大ID, 负载字节数)`；
  `advance(target)` 据此整块跳过，被跳过的块不解码、不计入实际解码块数。

字节布局：

```
varint(block_size) varint(count) varint(num_blocks)
重复 num_blocks 次: varint(block_last_id) varint(block_payload_len)
各块负载（varint 编码的 zigzag 差分）顺序拼接
```

## 分词规则

1. 输入为已解码的 UTF-8 文本（`str`）。
2. 连续的 ASCII 字母或数字 `[A-Za-z0-9]+` 构成一个词元，统一转小写。
3. 每个 CJK 统一表意文字（U+4E00..U+9FFF）单独成为一个词元。
4. 其余字符（空白、标点、符号）一律视为分隔符，不产生词元。

查询串按相同规则分词；多词元查询串（如中文词“压缩”）取各词元列表的交集。

## 语义要点

- `advance(target)` 移动到第一个 `>= target` 的ID；`target <= 当前ID` 时不跳过、不额外解码。
- 空列表参与交 / 并 / 差均正确（空∩x=∅，空∪x=x，x−∅=x，空−x=∅）。
- 损坏差分（倒退 / 重复 / 截断 / 跳跃表不一致）在解码时抛 `CorruptedDeltaError`。
- `PostingList.stats` 记录 `decoded_blocks`（实际解码块数）与 `skipped_blocks`（跳跃块数）。

## 运行

```
python3.11 demo.py              # 运行样例
python3.11 -m unittest discover -v   # 运行测试
```

## 运行样例输出

```
=== 分词样例（规则见 tokenizer.py 文档字符串） ===
'Hello, World! 压缩Posting列表v2' -> ['hello', 'world', '压', '缩', 'posting', '列', '表', 'v2']

=== 交 / 并 / 差 查询 ===
apple AND banana      -> [1, 2]
压缩 AND 列表          -> [3, 4]
cherry OR pie         -> [1, 5]
banana NOT apple      -> [5]
apple AND 不存在词     -> []

=== advance(target) 与跳跃块统计 ===
advance(1)   -> 1 （advance 到当前ID不跳过）
advance(1)   -> 1 （再次调用仍不移动）
advance(997) -> 997
实际解码块数=2，跳跃块数=124
完整顺序解码的实际解码块数=125

=== 交集中的 advance 跳跃 ===
交集大小=200，前 5 项=[1, 16, 31, 46, 61]
a: 解码 63 块 / 跳过 49 块
b: 解码 38 块 / 跳过 25 块

=== 损坏差分拒绝（倒退检测） ===
已拒绝损坏数据: 块 0 解码出非正差分 -1：文档ID倒退/重复，数据损坏
```

## 测试结果

```
$ python3.11 -m unittest discover
Ran 32 tests in 0.005s
OK
```

覆盖：编码往返、严格递增校验、`advance` 各语义（到当前ID不跳过、块内定位、
整块跳跃、越界耗尽、空列表）、交并差与 Python 集合对照（含空列表组合）、
实际解码块数统计、五类损坏数据拒绝、分词规则、端到端索引查询。
