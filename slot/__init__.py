"""slot: 多人共同空闲槽查找库。

语义:
- 公共空闲 = 所有人忙时并集的补集, 与搜索窗 [s, e) 相交, 半开区间。
- 可行槽 = 长度 >= d 的最大公共空闲区间。
- 评分 = 槽与 prefer 并集的交集时长 (prefer 可重叠, 只计一次)。
- 排序: 评分降序, start 升序, end 升序; 最高分并列时返回全部 (canonical 去重)。
- 无可行槽返回 status="none"; 非法输入抛出 BadSlotError (code=BAD_SLOT)。
"""

from .core import BadSlotError, find_slots

__all__ = ["BadSlotError", "find_slots"]
