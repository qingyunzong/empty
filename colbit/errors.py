"""colbit 错误类型。"""


class FormatError(Exception):
    """文件格式非法（魔数/类型/位宽/声明位长超出实际容量等）。"""


class CrcError(FormatError):
    """列数据 CRC32 校验失败；column 属性给出出错列号（0 基）。"""

    def __init__(self, column: int, expected: int, actual: int):
        self.column = column
        self.expected = expected
        self.actual = actual
        super().__init__(
            f"column {column}: crc32 mismatch "
            f"(expected 0x{expected:08x}, got 0x{actual:08x})"
        )
