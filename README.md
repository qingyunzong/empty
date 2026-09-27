# syncmap

本地两目录差异/同步工具（Python 3.11+，仅标准库）。

## 模型

- 文件按固定 **64 KiB** 分块，每块计算弱校验 **adler32** 与强校验 **sha256**。
- 清单 `.manifest`（JSON）记录每个文件的 POSIX 相对 UTF-8 路径、大小、
  `mtime_ns` 与块表；空文件块表为空（零块）。
- `diff` 输出 `ADD` / `DEL` / `MOD`；`MOD` 只列变化块号（目标块在整个源目录
  中找不到强校验匹配的块）。

## 匹配语义

1. 目标块先按 adler32 过滤源块，再按 sha256 确认；弱校验相同而强校验不同
   时判定为不匹配（adler32 碰撞不会误判）。
2. 多个源块强校验相同时，选路径字典序最小者；同路径再选块号最小者。
3. 路径必须是合法 POSIX 相对 UTF-8 路径；绝对路径、空段、`.`/`..` 越界段
   一律抛 `PathError`。

## apply 语义

- 只依据源目录的 `.manifest` 与源目录数据，逐块校验后写入目标侧临时目录；
- 源文件缺失或与清单不符时报 `ApplyError`，目标目录完全不变；
- 全部构建成功后通过 `os.rename` 原子替换目标目录。

## CLI

```
python -m syncmap manifest DIR              # 生成 DIR/.manifest
python -m syncmap diff SRC TGT [--exit-code]
python -m syncmap apply SRC TGT [-m MANIFEST]
```

## 测试

```
python -m unittest discover -s tests -v
```

包含：手工构造的 64 KiB adler32 碰撞块（sha256 不同）、并列最优匹配
tie-break、DEL + 原子 apply、apply 失败不留痕，以及 30 个随机场景
（≤20 文件、每文件 ≤5 块）与暴力全量哈希参考实现的逐项对照。
