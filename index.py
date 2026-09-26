"""本地 UTF-8 文本的分词与倒排索引（不使用搜索服务或全文检索库）。

分词规则（明确约定）：
  1. 先对文本做 str.casefold() 大小写折叠；
  2. 词元 = 连续的 Unicode 字母/数字串（正则 [^\\W_]+，即 \\w 去掉下划线），
     空白、标点、下划线、符号均为分隔符，不产生词元；
  3. 对长度 > 1 的连续 CJK 串（中文/日文假名/韩文音节），额外产出：
       - 全部单字词元（unigram）
       - 全部相邻二字词元（bigram）
     例如 "苹果手机" 额外产出 苹/果/手/机 与 苹果/果手/手机；
  4. 文档ID = add_document 的调用序号，从 0 开始，天然严格递增。

查询规则：postings(term) 先精确查找；若未命中且 term 为长度 > 2 的纯 CJK
串，则对其全部 bigram 的列表求交（CJK 无空格分词的常规近似）。
"""
from __future__ import annotations

import re

from postings import PostingsList, difference, intersect, union

_WORD_RE = re.compile(r"[^\W_]+", re.UNICODE)
_CJK_RE = re.compile(r"[一-鿿぀-ヿ가-힯]+")


def tokenize(text: str) -> list[str]:
    """按上述规则把 UTF-8 文本切成词元列表。"""
    tokens: list[str] = []
    for word in _WORD_RE.findall(text.casefold()):
        tokens.append(word)
        if len(word) > 1 and _CJK_RE.fullmatch(word):
            tokens.extend(word)  # 单字
            tokens.extend(word[i:i + 2] for i in range(len(word) - 1))  # 二字
    return tokens


class InvertedIndex:
    """词元 -> 压缩文档ID列表 的倒排索引。"""

    def __init__(self, block_size: int = 8):
        self._block_size = block_size
        self.documents: list[str] = []
        self._raw: dict[str, list[int]] = {}
        self._postings: dict[str, PostingsList] = {}

    def add_document(self, text: str) -> int:
        doc_id = len(self.documents)
        self.documents.append(text)
        for token in set(tokenize(text)):
            self._raw.setdefault(token, []).append(doc_id)
        return doc_id

    def build(self) -> None:
        self._postings = {
            term: PostingsList(ids, self._block_size)
            for term, ids in self._raw.items()
        }

    def postings(self, term: str) -> PostingsList:
        """查询词元的压缩列表；未出现的词元返回空列表。

        长度 > 2 的纯 CJK 词未精确命中时，退化为 bigram 列表求交。
        """
        folded = term.casefold()
        hit = self._postings.get(folded)
        if hit is not None:
            return hit
        if len(folded) > 2 and _CJK_RE.fullmatch(folded):
            result: PostingsList | None = None
            for i in range(len(folded) - 1):
                bigram = self._postings.get(folded[i:i + 2], PostingsList())
                result = bigram if result is None else intersect(result, bigram)
            return result if result is not None else PostingsList()
        return PostingsList()

    @staticmethod
    def and_(a: PostingsList, b: PostingsList) -> PostingsList:
        return intersect(a, b)

    @staticmethod
    def or_(a: PostingsList, b: PostingsList) -> PostingsList:
        return union(a, b)

    @staticmethod
    def not_(a: PostingsList, b: PostingsList) -> PostingsList:
        return difference(a, b)
