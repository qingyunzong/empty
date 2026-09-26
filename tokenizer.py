"""UTF-8 文本分词器，纯标准库实现，不使用任何搜索服务或全文检索库。

分词规则
--------
1. 输入为已解码的 UTF-8 文本（Python str）。
2. 连续的 ASCII 字母或数字（[A-Za-z0-9]+）构成一个词元，统一转为小写。
3. 每个 CJK 统一表意文字（U+4E00..U+9FFF）单独成为一个词元。
4. 其余所有字符（空白、标点、符号等）一律视为分隔符，不产生词元。

示例
----
>>> tokenize("Hello, World! 压缩Posting列表v2")
['hello', 'world', '压', '缩', 'posting', '列', '表', 'v2']
"""

from __future__ import annotations

import re

_TOKEN_RE = re.compile(r"[A-Za-z0-9]+|[一-鿿]")


def tokenize(text: str) -> list[str]:
    """按上述规则把 UTF-8 文本切分为词元列表（ASCII 部分已小写化）。"""
    return [match.group(0).lower() for match in _TOKEN_RE.finditer(text)]
