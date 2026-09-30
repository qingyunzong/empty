# idem — 幂等任务收件箱 CLI

任务为 JSON（含 `idemkey` 与 `payload`），状态机：`RECEIVED → PROCESSING → SUCCEEDED | FAILED`。

## 用法

```bash
python3 idem.py --store ./store enqueue '{"idemkey":"k1","payload":"hello"}'
python3 idem.py --store ./store run-once [--idemkey k1]
python3 idem.py --store ./store crash --after CLAIM --idemkey k1   # 崩溃注入
python3 idem.py --store ./store recover
python3 idem.py --store ./store get --idemkey k1
```

## 持久化（store 目录）

- `inbox.json`：收件箱，idemkey → 任务记录（原子 tmp+rename 写入）
- `results.json`：结果文件，idemkey → 结果
- `events.jsonl`：事件日志（RECEIVED / CLAIM / RESULT，append+fsync）
- `effects.json`：已生效副作用，按效果键（idemkey）保证处理器幂等
- `compute_log.jsonl`：每次真实计算的记录（供测试断言副作用只发生一次）

## 语义

1. 首次 `enqueue` 返回受理；同 idemkey 重复 `enqueue` 返回原任务记录且不新增。
2. 处理前先原子写 CLAIM 事件，处理完成后写结果。
3. CLAIM 后崩溃时，`recover` 用同一 idemkey 重跑；内置处理器按效果键幂等，副作用不重复。
4. `payload` 为 `BAD` 时永久失败（FAILED），不无限重试。
5. `get` 返回状态、结果和尝试次数。

## 退出码

| 码 | 含义 |
|----|------|
| 0  | 成功 |
| 2  | 处理中重复（任务处于 PROCESSING） |
| 4  | 输入非法 / 存储文件损坏 |
| 10 | 永久失败（payload 为 BAD） |

## 测试

```bash
python3 -m unittest discover -s tests -v
```

真实运行输出见 `result.txt`。`tests/test_idem.py` 中的 `TestReferenceModel`
使用参考映射枚举每个 key 的最终状态与副作用（计算次数、效果条数），
并用真实 CLI 输出对照校验。
