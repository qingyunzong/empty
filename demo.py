"""运行样例：本地合成 UTF-8 文档 -> 建索引 -> 交并差查询 + advance 演示。"""
from index import InvertedIndex
from postings import PostingsList

DOCS = [
    "苹果发布了新款手机，搭载更强的芯片。",          # 0
    "香蕉和苹果都是常见水果。",                      # 1
    "新款手机的芯片由自研团队设计，性能大幅提升。",  # 2
    "水果店里香蕉、橙子和苹果都很新鲜。",            # 3
    "新款手机发布会吸引了大量关注。",                # 4
    "橙子富含维生素，是冬季常见水果。",              # 5
    "自研芯片成为手机厂商竞争的焦点。",              # 6
    "苹果公司的手机芯片再升级，性能领先。",          # 7
]


def show(title, plist, index):
    ids = plist.to_list()
    print(f"{title}\n  文档ID: {ids}")
    for doc_id in ids:
        print(f"    [{doc_id}] {index.documents[doc_id]}")


def main():
    index = InvertedIndex(block_size=3)  # 小块以便演示跳跃
    for doc in DOCS:
        index.add_document(doc)
    index.build()

    print("== 分词样例 ==")
    from index import tokenize
    print(f"  {DOCS[1]!r} -> {tokenize(DOCS[1])}\n")

    apple = index.postings("苹果")
    phone = index.postings("手机")
    chip = index.postings("芯片")
    print(f"苹果: {apple.to_list()}  手机: {phone.to_list()}  芯片: {chip.to_list()}\n")

    show("== 交集：苹果 AND 手机 ==", index.and_(apple, phone), index)
    show("\n== 并集：苹果 OR 芯片 ==", index.or_(apple, chip), index)
    show("\n== 差集：手机 NOT 芯片 ==", index.not_(phone, chip), index)

    print("\n== advance 演示（block_size=3）==")
    plist = PostingsList([2, 5, 7, 11, 13, 17, 19, 23, 29, 31], block_size=3)
    reader = plist.reader()
    print(f"  列表: {plist.to_list()}")
    print(f"  next()        -> {reader.next()}  (解码块数={reader.blocks_decoded})")
    print(f"  advance(2)    -> {reader.advance(2)}   # 到当前ID不跳过 (解码块数={reader.blocks_decoded})")
    print(f"  advance(18)   -> {reader.advance(18)}  # 整块跳过 (解码块数={reader.blocks_decoded})")
    print(f"  advance(100)  -> {reader.advance(100)}  # 越过末尾 (解码块数={reader.blocks_decoded})")

    print("\n== 损坏差分拒绝演示 ==")
    from postings import CorruptPostingsError, encode
    data = bytearray(encode([10, 20, 30], block_size=3))
    data[-2] = 0  # 把第二个差分篡改为 0（文档ID不再递增）
    try:
        PostingsList.from_bytes(bytes(data)).to_list()
    except CorruptPostingsError as exc:
        print(f"  已拒绝: {type(exc).__name__}: {exc}")


if __name__ == "__main__":
    main()
