"""基于压缩差分列表的迷你倒排索引，仅用于演示与测试。

文档为本地合成的 UTF-8 文本，不依赖任何搜索服务或全文检索库。
"""

from __future__ import annotations

from posting_list import DEFAULT_BLOCK_SIZE, PostingList, difference, intersect, union
from tokenizer import tokenize


class InvertedIndex:
    """term -> PostingList 的倒排索引。先 add_document，再 build，最后查询。"""

    def __init__(self, block_size: int = DEFAULT_BLOCK_SIZE):
        self.block_size = block_size
        self._term_to_ids: dict[str, list[int]] = {}
        self._postings: dict[str, PostingList] = {}
        self._built = False

    def add_document(self, doc_id: int, text: str) -> None:
        if self._built:
            raise RuntimeError("索引已构建，不能再添加文档")
        for token in set(tokenize(text)):
            self._term_to_ids.setdefault(token, []).append(doc_id)

    def build(self) -> None:
        self._postings = {
            term: PostingList(sorted(ids), self.block_size)
            for term, ids in self._term_to_ids.items()
        }
        self._built = True

    def posting(self, term: str) -> PostingList:
        """返回词项的压缩列表；词项不存在时返回空列表（空列表组合仍正确）。

        查询串会按与建索引相同的规则分词；若产生多个词元（如中文词“压缩”
        被切成“压”“缩”），则返回各词元列表的交集。
        """
        if not self._built:
            raise RuntimeError("请先调用 build()")
        tokens = tokenize(term)
        if not tokens:
            return PostingList(block_size=self.block_size)
        ids = list(self._postings.get(tokens[0], PostingList()))
        for token in tokens[1:]:
            ids = intersect(PostingList(ids), self._postings.get(token, PostingList()))
        return PostingList(ids, self.block_size)

    def query_and(self, *terms: str) -> list[int]:
        result = self.posting(terms[0]) if terms else PostingList()
        ids = list(result)
        for term in terms[1:]:
            ids = intersect(PostingList(ids), self.posting(term))
        return ids

    def query_or(self, *terms: str) -> list[int]:
        ids: list[int] = []
        for term in terms:
            ids = union(PostingList(ids), self.posting(term))
        return ids

    def query_not(self, include: str, exclude: str) -> list[int]:
        return difference(self.posting(include), self.posting(exclude))
