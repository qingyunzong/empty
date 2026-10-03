# symdfa — 符号 DFA 等价与包含判定

字符域为 `0..65535` 的符号 DFA：每个状态的迁移由**不相交闭区间** `[lo, hi] -> target`
表示，未覆盖的字符进入**隐式拒绝汇点**（内部表示为 `null`）。仅依赖 Python 3.11
标准库。

## 功能

- **等价 / 包含判定**：按需探索乘积状态，通过区间交叠划分把 `[0, 65535]` 切成
  最大均匀段（每段即一条乘积边），从不枚举单个字符。
- **结果证书**：等价时给出关系证明（每个乘积状态对的出边完整覆盖字母表）；
  不等时给出按（长度， 字典序）最小的反例。
- **逐边预算**：预算按*新*乘积边计；耗尽返回 `unknown` 和可序列化、可恢复的
  前沿（frontier），恢复后从断点逐边继续。
- **增量更新**：单条迁移更正（`add` / `remove` / `replace`）原子生效——非法
  （重叠、越界、未知状态）更新抛异常且原机器不变。机器带版本号，证明绑定
  `version_a` / `version_b`，旧证明无法直接移用；`invalidate_proof` 把受更新
  影响的条目标为失效，其余条目经局部重验后作为 `reuse` 复用（复用边不计预算）。
- **独立验证器**：`verify_proof` 逐项检查关系覆盖（初始对覆盖、接受条件、
  边覆盖无空隙/重叠、与两台机器逐边一致、后继闭合）；`verify_counterexample`
  逐字符重放反例。

## 库用法

```python
from symdfa import Machine, check, verify_proof, invalidate_proof, build_reuse

a = Machine.create(["q0", "q1"], "q0", ["q1"], {"q0": [[0, 10, "q1"]]})
b = Machine.create(["r0", "r1"], "r0", ["r1"],
                   {"r0": [[0, 5, "r1"], [6, 10, "r1"]]})

res = check(a, b)                      # res.status == "equivalent"
assert verify_proof(a, b, res.proof) == []

res = check(a, b, budget=2)            # 逐边预算
if res.status == "unknown":
    res = check(a, b, frontier=res.frontier)   # 从断点恢复

a2 = a.replace_transition("q0", 0, 10, 0, 10, "q1")   # 原子更正，版本 +1
valid, stale = invalidate_proof(res.proof, a2, b)     # 失效划分
res2 = check(a2, b, reuse=build_reuse(valid, a2, b))  # 复用仍有效部分
```

## JSON CLI

```bash
# 判定（--mode equivalence|inclusion，--budget N，--resume F，--reuse PROOF）
python3.11 -m symdfa check --a a.json --b b.json [--budget 100]

# 验证证明或反例证书
python3.11 -m symdfa verify --a a.json --b b.json --certificate proof.json

# 原子更新单条迁移（重叠/越界即拒绝，退出码 1）
python3.11 -m symdfa update --machine a.json --state q0 --lo 20 --hi 30 \
    --target q0 --out a2.json
python3.11 -m symdfa update --machine a.json --state q0 --replace 0 10 \
    --lo 0 --hi 10 --target q1 --out a2.json
```

机器 JSON 格式：

```json
{
  "states": ["q0", "q1"],
  "initial": "q0",
  "accepting": ["q1"],
  "transitions": {"q0": [[0, 10, "q1"]]},
  "version": 0
}
```

## 测试

```bash
python3.11 -m unittest discover -s tests -v
```

覆盖：小字母表穷举单词与完整乘积参考算法交叉核对（含包含模式）、隐式汇点、
空串差异、区间端点分裂、多个同长见证取字典序最小、更新影响已访问状态后的
失效/复用、逐边预算耗尽与恢复、前沿版本绑定、篡改证明/反例、非法重叠更新
原子拒绝、CLI 端到端。

最近一次运行结果：**51 个测试全部通过（OK，约 4 秒）**。
