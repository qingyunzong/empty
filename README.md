# algroots — 有理系数多项式的精确实根隔离

纯 Python 3.11 标准库实现（仅使用 `fractions.Fraction` 精确算术，不使用任何数值求根库）。

## 功能

- **平方自由分解**（Yun 算法）：`P = c · ∏ f_i^i`，`f_i` 首一、平方自由、两两互素，重数 `i` 严格递增。
- **Sturm 序列**：符号余式序列与任意有理点处的变号数 `V(x)`；约定跳过零项，故对平方自由 `f` 恒有 `V(a) − V(b) = (a, b]` 内不同实根数。
- **根隔离**：从严格 Cauchy 界 `(-B, B)` 起二分，每个根返回重数与有理端点。
- **按误差细化**：`refine_to(f, root, epsilon)` 二分至区间宽 ≤ 指定有理误差。
- **代数数比较**：来自不同多项式的两个根，通过 `gcd(f₁, f₂)` 的平方自由部分的**联合隔离**判定相等或大小（绝不比较区间中点）。
- **预算与断点续算**：见下。
- **证书与独立验证器**：见下。

## 根的开闭表示规则

- **点根**：二分中点恰为根时，表示为 `{"type": "point", "value": "p/q"}`，值为精确有理数。
- **区间根**：其余根表示为**开区间** `{"type": "interval", "interval": "open", "lower": "a", "upper": "b"}`，满足 `a < b`、`f(a) ≠ 0`、`f(b) ≠ 0`，且 `(a, b)` 内恰含该平方自由因子的一个根。
- 隔离完成后所有根（跨所有平方自由因子）两两不重叠并按升序排列；每个根带 `multiplicity`（对应因子在回原多项式中的重数）。

## 预算模型

预算按两类操作计数（`stats` 中分别累计）：

- `remainders`：构建 Sturm 序列时每计算一个符号余式计 1；
- `bisections`：隔离或细化中每次二分计 1。

预算耗尽时隔离器干净地停止：已完成的根保存在 `roots`，未决工作保存在 `frontier`，`status` 标为 `"pending"`。Sturm 链的构建也是可断点的（部分链存在 frontier 项中），因此即使单条链的开销超过单次预算切片也能保证推进。状态可 JSON 序列化（`state`），恢复后不重复、不遗漏任何根；分段运行与一次性连续运行产生完全相同的根集合。

## 证书与验证

`build_certificate(session)` 产出 JSON 证书：

- `polynomial` / `content` / `factors[].factor` / `factors[].multiplicity`：平方自由因子关系；
- `factors[].sturm`：完整 Sturm 链；
- `factors[].bound` 与 `factors[].variations.{at_lower_bound, at_upper_bound}`：端点变号数；
- `factors[].roots`：隔离结果（覆盖性由变号差保证）。

`verify_certificate(cert)` 是独立验证器，仅用精确算术从头核验：因子关系 `content·∏f_i^i == P`、各因子首一/平方自由/两两互素、Sturm 链递推与终止、界严格覆盖所有实根、变号数、每个区间恰含一根、点根精确、根有序且互不重叠、根数等于变号差（隔离覆盖）。

## JSON CLI

多项式为升幂系数数组，有理数用整数或 `"p/q"` 字符串。输入经 `--input` 或 stdin，输出为 JSON。

```bash
# 隔离（可带 budget；pending 时返回 state 供恢复）
python3.11 -m algroots isolate --input '{"poly": ["-2","0","1"]}'
python3.11 -m algroots isolate --input '{"state": <state>, "budget": 10}'

# 细化第 index 个根（升序）至宽度 <= epsilon
python3.11 -m algroots refine --input '{"poly": ["-2","0","1"], "index": 1, "epsilon": "1/1000000"}'

# 比较两个多项式的根：relation ∈ {lt, eq, gt}
python3.11 -m algroots compare --input '{"poly1": ["-2","0","1"], "index1": 1,
                                         "poly2": ["-3","0","1"], "index2": 1}'

# 验证证书
python3.11 -m algroots verify --input '{"certificate": {...}}'
```

零多项式（每个实数都是根）被明确拒绝；常数多项式返回空根列表。

## 库 API

```python
from algroots import (Poly, IsolationSession, isolate, refine_to,
                      compare_roots, build_certificate, verify_certificate)

session = IsolationSession(Poly(["-2", "0", "1"])).run()   # x^2 - 2
root = session.roots[1]                                     # sqrt(2) 所在开区间
root, done = refine_to(session.factors[root.factor][0], root, "1/10^6")
cert = build_certificate(session)
ok, errors = verify_certificate(cert)
```

## 测试

```bash
python3.11 -m unittest discover -s tests -v
```

覆盖：高重数根、相距极近的根（2^-30 量级）、两多项式共有根、常数与零多项式、端点恰为根（点根表示）、巨大系数（10^40 量级）、分段预算与连续运行一致性、证书篡改检测、CLI 端到端。
