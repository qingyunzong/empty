"""运行样例：本地合成 UTF-8 文档 -> 建索引 -> 交/并/差查询 -> advance 与解码统计 -> 损坏差分拒绝。

运行：python3.11 demo.py
"""

from inverted_index import InvertedIndex
from posting_list import CorruptedDeltaError, PostingList, intersect
from tokenizer import tokenize

DOCS = [
    (1, "Apple banana apple pie. 苹果 派"),
    (2, "Banana split with apple, 香蕉 船"),
    (3, "压缩 文档 ID 差分 列表 跳跃块"),
    (4, "Apple 压缩 列表 UTF-8 文本 差分"),
    (5, "Cherry banana 压缩 樱桃"),
    (6, "差分 编码 与 跳跃块 advance 查询"),
]


def section(title):
    print(f"\n=== {title} ===")


def main():
    section("分词样例（规则见 tokenizer.py 文档字符串）")
    sample = "Hello, World! 压缩Posting列表v2"
    print(f"{sample!r} -> {tokenize(sample)}")

    section("构建倒排索引（本地合成文档，块大小=2）")
    index = InvertedIndex(block_size=2)
    for doc_id, text in DOCS:
        index.add_document(doc_id, text)
    index.build()
    for doc_id, text in DOCS:
        print(f"  doc {doc_id}: {text}")

    section("交 / 并 / 差 查询")
    print("apple AND banana      ->", index.query_and("apple", "banana"))
    print("压缩 AND 列表          ->", index.query_and("压缩", "列表"))
    print("cherry OR pie         ->", index.query_or("cherry", "pie"))
    print("banana NOT apple      ->", index.query_not("banana", "apple"))
    print("apple AND 不存在词     ->", index.query_and("apple", "不存在词"))

    section("advance(target) 与跳跃块统计")
    pl = PostingList(range(1, 1001), block_size=8)  # 125 块
    cursor = pl.cursor()
    print("advance(1)   ->", cursor.advance(1), "（advance 到当前ID不跳过）")
    print("advance(1)   ->", cursor.advance(1), "（再次调用仍不移动）")
    print("advance(997) ->", cursor.advance(997))
    print(f"实际解码块数={pl.stats.decoded_blocks}，跳跃块数={pl.stats.skipped_blocks}")
    pl.reset_stats()
    pl.decode_all()
    print(f"完整顺序解码的实际解码块数={pl.stats.decoded_blocks}")

    section("交集中的 advance 跳跃")
    a = PostingList(range(1, 3001, 3), block_size=16)
    b = PostingList(range(1, 3001, 5), block_size=16)
    result = intersect(a, b)
    print(f"交集大小={len(result)}，前 5 项={result[:5]}")
    print(f"a: 解码 {a.stats.decoded_blocks} 块 / 跳过 {a.stats.skipped_blocks} 块")
    print(f"b: 解码 {b.stats.decoded_blocks} 块 / 跳过 {b.stats.skipped_blocks} 块")

    section("损坏差分拒绝（倒退检测）")
    good = PostingList([5, 9, 12], block_size=4)
    raw = bytearray(good.to_bytes())
    raw[-1] = 0x01  # 把最后一个差分篡改为 zigzag(-1)，解码将使ID倒退
    try:
        PostingList.from_bytes(bytes(raw)).decode_all()
        print("未被拒绝（不应发生）")
    except CorruptedDeltaError as exc:
        print(f"已拒绝损坏数据: {exc}")


if __name__ == "__main__":
    main()
