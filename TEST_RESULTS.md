# 测试结果记录

命令：`go test ./...`（另以 `-count=1` 避免缓存，环境变量 `GOCACHE=/tmp/gocache`）

实际输出：

```
ok  	provq	29.831s
```

退出码：0（全部通过）。

## 用例

- `TestDeleteKeepsAlternatives`：删除一事实仅撤掉含它的见证，仍有替代者保留；替代者耗尽后元组消失。
- `TestSupersetWitnessRemoved`：单事实见证存在时，作为其超集的多事实见证被去掉。
- `TestDerivedChainProvenance`：见证沿派生链（中间派生关系）传递；删除中间事实撤掉下游见证。
- `TestRecursiveAndUnsafeRulesRejected`：自递归、互递归规则及未绑定头变量规则被拒绝。
- `TestBruteForceMinimalWitnesses`：20 个事实、5 条非递归规则；
  枚举全部 2^20 = 1,048,576 个事实子集（实测约 15s），
  从头求值并汇总每个输出元组的最小（按包含关系）来源集合，与库的输出逐一核对一致；
  随后逐一删除 20 个事实中的每一个，核对增量撤掉后的见证与枚举结果一致；
  再对 2 个事实分别独立重枚举 2^19 = 524,288 个子集交叉验证删除路径。
