# jsonl-processor

JSONL 记录处理器：原子输出、检查点、崩溃模拟与恢复。仅使用 Python 3.11 标准库。

## 命令

```bash
python -m jsonl_processor process --input in.jsonl --workdir work
python -m jsonl_processor crash --at AFTER_WRITE --seq 3 --input in.jsonl --workdir work
python -m jsonl_processor recover --input in.jsonl --workdir work
python -m jsonl_processor dead-letters --workdir work
python -m jsonl_processor state --workdir work
```

退出码：`0` 成功；`2` 显式错误（路径/状态非法）；`3` 模拟崩溃已触发。

## 语义

- **转换**：每条记录仅提取 `id`、`name` 长度和原始行的 CRC-32 校验和，写入
  `work/outputs/<id>.json`（临时文件 + `os.replace` 原子替换）。
- **检查点**：`work/checkpoint.json` 记录最大已处理序号 `max_seq`，每处理一条原子更新。
- **状态机**：`RUNNING` → `COMPLETED`；恢复期间为 `RECOVERING`；显式错误置 `FAILED`。
  模拟崩溃保持 `RUNNING` 不变（等价于进程被 kill）。
- **崩溃点**：
  - `AFTER_READ`：读入后、处理前崩溃 → 恢复时该记录重跑（`written`）。
  - `AFTER_WRITE`：输出落盘后、检查点更新前崩溃 → 恢复时先扫描已存在输出 id，
    该记录 `skipped_existing`，不重复写（inode 不变），随后核对并推进检查点。
  - `AFTER_CHECKPOINT`：检查点更新后崩溃 → 恢复时按检查点跳过（`skipped_checkpoint`）。
- **坏记录**：缺 `name`、非法 JSON、缺/非法 `id` 等，重试 3 次（共 3 次尝试）后追加到
  `dead_letters.jsonl` 并继续后续记录。
- **重复 id**：仅处理首次出现，后续追加到 `duplicates.jsonl`，不覆盖已有输出。
- **显式错误**：输入缺失、workdir 已初始化、无可恢复状态、检查点与磁盘不一致
  （已检查点记录无任何输出/死信/重复痕迹）等均抛出明确错误并置 `FAILED`。

## 测试

```bash
python -m unittest discover -s tests -v
```

测试使用内联参考枚举逐记录断言状态与输出内容，真实运行结果见 `TEST_RESULTS.md`。
