# 采集词汇映射的存在约束分类与反模型

`example.org/dataeng/q0318` 提供一个可导入的 Go 包，用于判断不同采集词汇之间的概念包含关系。不同来源的概念通过包含公理和存在关系约束对齐；分类器不会把“对象有某类关联对象”误当成“当前对象属于该类”。

## 输入与语义

词汇最多包含 128 个普通概念名和 32 个关系名；公理最多 5000 条，每条带唯一 ID。`Top` 与 `Bottom` 是保留概念，无需声明。

支持且仅支持四类规范化公理：

```go
dataeng.Include(id, "A", "B")                  // A <= B
dataeng.Intersect(id, "A1", "A2", "B")         // A1 and A2 <= B
dataeng.Exists(id, "A", "r", "B")              // A <= exists r.B
dataeng.ExistsSubsumed(id, "r", "A", "B")      // exists r.A <= B
```

语义是任意非空论域上的一元概念集合与二元关系。`Top` 是整个论域，`Bottom` 是空集，交集是集合交，`exists r.B` 表示至少有一个 `r` 后继属于 `B` 的对象。没有否定、个体常量、逆关系或文本语法。未声明的概念/关系、重复公理 ID、空 ID、未知公理种类和超出上限的批次都会导致整批拒绝。

## 快速使用

```go
v := dataeng.Vocabulary{
    Concepts:  []string{"Visit", "Encounter", "Patient", "Person"},
    Relations: []string{"subject"},
}
axioms := []dataeng.Axiom{
    dataeng.Include("align-1", "Visit", "Encounter"),
    dataeng.Exists("align-2", "Encounter", "subject", "Patient"),
    dataeng.Include("align-3", "Patient", "Person"),
}

snapshot, err := dataeng.NewSnapshot(v, axioms)
if err != nil {
    // 整批输入被拒绝。
}
classification := snapshot.Classify()

holds, err := classification.Subsumes("Visit", "Encounter")
proof, err := classification.ProofFor("Visit", "Encounter")
model, err := classification.Countermodel("Visit", "Person")

// 两者都可从输入独立核验。
_ = snapshot.VerifyProof(proof)
_ = snapshot.VerifyCountermodel(model, "Visit", "Person")
```

`classification.Explain(a, b)` 一次返回判定结果，并在正面判定时附带 `Proof`，在反面判定时附带已验证的 `Countermodel`。`IsEmpty(c)` 判断概念是否在所有模型中必为空；`EmptyProof(c)` 返回可重放的 `c <= Bottom` 推导。

`VocabularyAlignmentExample()` 是一个完整宿主调用例，展示词汇对齐、正面证明和反模型。

## 完成图算法

每个概念节点 `X` 的标签集合从 `{X, Top}` 开始，关系边 `R(X, r, Y)` 表示 `X` 对象要求的 `r` 后继。工作队列只在新标签或新边真正出现时登记：

- `A <= B`：`A` 在 `S(X)` 中加入 `B`。
- `A1 and A2 <= B`：同一节点同时有 `A1`、`A2` 时加入 `B`。
- `A <= exists r.B`：创建边 `R(X, r, B)`，不把 `B` 加入 `S(X)`。
- `exists r.A <= B`：对边 `R(X, r, Y)`，若 `A` 在 `S(Y)` 则把 `B` 加入 `S(X)`。
- 若 `Bottom` 在 `S(Y)`，边 `R(X, r, Y)` 把 `Bottom` 传播到 `S(X)`。

不同存在见证保持为不同节点，因此 `A <= exists r.B` 与 `A <= exists r.C` 不会错误合并 `B`、`C` 的概念成员。

`A <= B` 在分类中成立当且仅当 `Bottom` 在 `S(A)` 或 `B` 在 `S(A)`；全局不一致仅当 `Bottom` 在 `S(Top)`，此时所有包含成立、所有概念为空。某个普通概念必为空不会自动使全局不一致。

`Classification.Statistics()` 报告节点数、初始事实数、实际新增标签/边事实数以及处理的工作项数；重复触发不会增加计数。

## 证明与反模型

正面结论附带的 `Proof` 是有限推导 DAG。`ProofStep` 列明规则、前提步骤 ID 和可选公理 ID；公理叶与初始事实叶都可从快照独立重放。步骤按拓扑顺序存放，不能引用尚未建立的前提，因此循环互相引用不能充当证明。

反面结论附带的 `Model` 明确列出每个对象的 ID、概念成员和出边；`Root` 对象属于左侧概念而不属于右侧概念。`VerifyModel` 用直接集合语义逐条核验四类公理、`Top` 覆盖整个非空论域以及 `Bottom` 为空，不依赖完成图算法。

分类、证明和反模型都绑定到同一个不可变 `Snapshot`。`WithAxioms` 创建新快照，旧快照和旧分类结果不会被修改。

## 测试

```bash
go test ./...
```

测试覆盖：

- 仅普通概念必为空但 `Top` 可满足；
- `Top <= Bottom` 的全局不一致；
- `A <= exists r.A` 的有限循环模型；
- 两个存在见证不被错误合并；
- 后继被推为空后前驱随之为空；
- 交集条件不被拆成两个独立包含；
- 100 级链和 80 节点带存在边的环；
- 证明独立重放、反模型大小上界、快照不可变性、输入整批校验；
- 最多两个普通概念、一个关系的随机公理，在论域大小 1 到 3 上穷举全部集合与关系解释，逐项对照包含、空性和全局一致性。
