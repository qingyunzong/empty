# pipeline — 可崩溃恢复的 JSONL 记录处理器

仅依赖 Python 3.11 标准库。逐条读取 JSONL 记录，按记录 `id` 在输出目录
写入原子 JSON 文件（临时文件 + `os.replace`），并维护检查点（已处理的最大
序号）与状态机：`RUNNING -> RECOVERING -> COMPLETED / FAILED`。

## 命令

```sh
python3 pipeline.py process  --input in.jsonl --outdir out
python3 pipeline.py crash    --input in.jsonl --outdir out --at AFTER_WRITE [--seq N]
python3 pipeline.py recover  --input in.jsonl --outdir out
python3 pipeline.py dead-letters --outdir out
python3 pipeline.py state        --outdir out
```

退出码：`0` 成功，`1` 显式错误（状态置为 `FAILED`），`2` 模拟崩溃。

## 语义

- **转换**：每条记录仅提取 `id`、`name_length`、`checksum`（CRC32），外加
  `seq` 便于校验处理顺序；输出为 `out/<id>.json`。
- **崩溃点**：`AFTER_READ`（读入后未写出，恢复时重跑该记录）、
  `AFTER_WRITE`（输出已提交但检查点未推进，恢复时扫描到已存在输出则直接
  采纳、不重复写入）、`AFTER_CHECKPOINT`（检查点已推进，恢复时跳过）。
- **恢复**：先扫描输出目录中已存在的输出 id，再核对检查点，从
  `checkpoint + 1` 继续。
- **坏记录**：缺失 `name`（或非法 JSON / 非法 id）的记录重试 3 次后写入
  `dead_letters.jsonl`，随后继续处理后续记录。
- **重复 id**：首次出现生效，后续不覆盖输出，记入状态的 `duplicates` 列表。
- **显式错误**：输入缺失、输出路径非目录、状态文件损坏、重复初始化、
  无可恢复状态等均返回退出码 1 并将状态置为 `FAILED`（含错误信息）。

## 测试

```sh
python3 -m unittest -v test_pipeline
```

测试使用内联参考枚举逐记录校验状态；最近一次真实运行结果见
`test_results.txt`。
