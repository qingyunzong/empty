# rollsync

rsync 风格的二进制增量补丁库与 CLI（仅依赖 Python 3.11 标准库）。

## 用法

```sh
python -m rollsync delta OLD NEW --out PATCH   # 生成补丁
python -m rollsync apply OLD PATCH --out OUT   # 应用补丁，stdout 输出 copy=N literal=M
```

## 语义

- 块大小由 `len(OLD)` 与 `seed=17` 决定：`max(1, min(65536, len(OLD)//17))`，弱校验窗口上限 64 KB。
- NEW 上以块长为窗口滚动 Adler-32；弱命中必须经 SHA-256 强校验确认，否则拒绝（杜绝假命中）。
- 重叠匹配按起点升序、同起点长度降序取首个（整块窗口优先于尾块窗口）。
- PATCH 段（copy/literal）自带输出偏移，应用顺序无关、结果确定；重复应用幂等。
- 应用时逐 copy 段校验 SHA-256，并最终校验整体输出 SHA-256；任一不匹配退出码 6，且不写目标文件。
- 补丁损坏/截断退出码 5，IO 错误退出码 2；失败时目标文件保持原字节。

## 测试

```sh
python -m unittest discover -s tests -v
```
