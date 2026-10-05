# denydiag

诊断 CLI：给定至多 18 条整数区间规则和一个被拒绝的请求，找出仍能证明
该请求被拒绝的**最少规则子集**；子集大小相同时按 **ID 序**（排序后 ID 序列
字典序最小）取胜。仅使用 Go 标准库。

## 公开语义（继承层 + 拒绝优先，默认放行）

每条规则形如 `ID LAYER ACTION LO HI`：

- `ID`：规则标识，输入内唯一；`LAYER`：继承层（非负整数）；
- `ACTION`：`allow` 或 `deny`；区间 `[LO, HI]` 闭区间。
- 规则匹配请求 `q` 当且仅当 `LO <= q <= HI`。

求值规则：

1. **继承**：`allow` 在第 `L` 层授予访问权，该授予向上继承到所有更高层，
   除非被撤销。
2. **拒绝优先**：第 `L` 层的 `deny` 撤销所有来自 `<= L` 层的授予；同层
   `deny` 胜过 `allow`。
3. **默认放行**：没有任何匹配 `allow` 时 `deny` 无效（无可撤销）；无任何
   匹配规则时请求被接受。

设 `A` = 匹配 allow 的层集合，`D` = 匹配 deny 的层集合，则：

```
REJECT(q)  <=>  A != {} 且 D != {} 且 max(D) >= max(A)
```

## 输入 / 输出

```
行 1:     N Q                 N 条规则 (0..18)，被拒绝的请求 Q
随后 N 行: ID LAYER ACTION LO HI
```

输出：全集判定、最小证明子集（大小 + ID + 规则明细）、文字解释，以及
独立验证结论。若全集并不拒绝该请求（前提不成立），退出码为 1；输入非法
退出码为 2。`denydiag -semantics` 打印上述语义说明。

## 算法与验收

- **穷举验收**：`Solve` 对全部 `2^N`（N ≤ 18，最多 262144）个子集逐一
  求值，取基数最小者，同量按排序后 ID 序列字典序最小者胜出。
- **独立检查更小子集不够**：`VerifyMinimality` 使用与 `Solve` 不同的代码
  路径（递归组合生成器 + 独立求值器 `RejectedIndependent`，后者按层
  自顶向下走查而非聚合 max 层）逐一确认所有基数 `< k` 的子集都不拒绝。
- 测试中另有第三份朴素实现（按大小递归枚举组合）与 `Solve` 在随机输入
  上交叉验证，以及两个求值器在 20000 组随机输入上的一致性模糊测试。

## 示例

输入：

    4 7
    10 0 allow 1 10
    11 1 deny 5 9
    12 0 allow 3 4
    13 2 deny 7 7

输出：

    verdict: request 7 REJECTED by full rule set (4 rules)
    minimal proof: 2 rule(s)
    rule ids: [10 11]
      id=10 layer=0 allow [1,10]
      id=11 layer=1 deny [5,9]
    explanation: request 7 is granted by allow id=10 at layer 0, and the grant is revoked by deny id=11 at layer 1 (deny-priority: layer 1 >= layer 0)
    verification: exhaustive acceptance evaluated all 16 subsets; independent check confirmed no subset of size < 2 rejects (5 subset(s) checked)

## 测试结果（实际运行记录）

```
$ go test ./...
ok  	denydiag	0.450s
```

`go test -v ./...`：全部 9 个测试（含全部子用例）PASS——语义表驱动测试、
双求值器 20000 组随机一致性、解析及 9 类非法输入、求解器已知用例
（含 ID 序平局）、求解器对朴素穷举 3000 组随机交叉验证、最小性独立验证、
18 条规则上限用例、CLI 端到端 / 前提不成立 / 非法输入。
