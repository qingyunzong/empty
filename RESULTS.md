# colbit 测试结果

运行环境：Python 3.14.4（代码仅使用 3.11 标准库语法与 unittest）
运行命令：`python -m unittest discover -s tests -v`
运行时间：2026-10-01

## 真实结果

- 总测试数：24
- 通过：24
- 失败：0
- 错误：0
- 最终状态：**OK**

## 覆盖点

- `tests/test_roundtrip.py`（15 项）
  - w=1 / 7 / 9 / 32 边界往返（含 0 与 2^w-1 极值、非字节对齐行数）
  - w=0 全零列：不存数据（校验文件字节数），解码恒为 0
  - R=0；batch 大于 R；batch<1 报错
  - 列子集选择解码（`columns=[2,0]` 保序）
  - 坏魔数、声明位长超出实际容量（截尾）抛 FormatError
  - 头部 w=33 非法抛 FormatError；字符串列写读均禁止
  - 越界值（如 w=1 写 2、w=32 写 2^32、负数）抛 ValueError
- `tests/test_crc.py`（4 项）
  - 翻转第 2 列数据一位，`iter_rows` 抛 CrcError 且列号准确为 2
  - 翻转第 0 列报列 0
  - 惰性校验：select 未损坏列子集不触发第 2 列校验；select 含第 2 列才报错
  - 干净文件正常通过
- `tests/test_reference.py`（3 项）
  - 60 组随机用例（R<=200 含 R=0，w∈{0,1,2,3,5,7,9,13,17,31,32}）
    与独立逐位参考打包器字节级对照，覆盖非字节对齐总位数
  - 显式非字节对齐组合：(1,3) (3,5) (7,9) (9,7) (5,3) (13,11)
  - 30 组随机整文件往返（随机列数/行数/位宽/batch）
- `tests/test_cli.py`（2 项）
  - CLI `pack` → `select --cols 2,0 --batch 2` → `info` 冒烟
  - select 缺省解码全部列
