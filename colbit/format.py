"""colbit 文件格式常量。

布局（全部小端）：
  magic      : 4 字节  b"CLB1"
  C          : u8      列数
  R          : u32     行数
  列头 * C   : u8 type | u8 width w | u32 crc32（对该列存储字节）
  列数据 * C : ceil(R*w/8) 字节，w=0 时 0 字节（全零列，不存数据）

类型：0 = 整数；1 = 字符串（本格式禁止，读写均报错）。
位流：小端位序，第 i 个值的第 b 位写入全局位位置 i*w+b，
字节内低位在前；末尾不足一字节补零。
"""

MAGIC = b"CLB1"
TYPE_INT = 0
TYPE_STRING = 1
MAX_WIDTH = 32
COL_HEADER_SIZE = 6  # u8 type + u8 w + u32 crc32
HEADER_SIZE = 4 + 1 + 4  # magic + C + R


def column_data_size(rows: int, width: int) -> int:
    """单列存储字节数；w=0 不存数据。"""
    if width == 0:
        return 0
    return (rows * width + 7) // 8
