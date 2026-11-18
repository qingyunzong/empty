# policy — 准入控制策略求值库

供 admission webhook 调用的 Go 策略求值库：把声明式规则（标签选择器、
资源量词、嵌套字段谓词、逻辑连接）编译成可重复求值的不可变计划，支持
规则热替换。

## 规则模型

规则是**拒绝规则**：`When` 表达式命中对象即拒绝并产生一条 `Reason`；
全部规则都未命中才允许（任一拒绝即整体拒绝）。

```go
rules := []policy.Rule{
    {ID: "no-big-deploy",
     When: policy.Pred{Path: []string{"spec", "replicas"}, Op: policy.OpGt, Value: 3},
     Reason: "replicas 超过 3"},
    {ID: "no-latest",
     When: policy.Quantifier{Kind: policy.Exists, Path: []string{"spec", "containers"},
         Item: policy.Pred{Path: []string{"image"}, Op: policy.OpMatches, Value: ":latest$"}},
     Reason: "禁止使用 latest 镜像"},
    {ID: "prod-labels",
     When: policy.And{Args: []policy.Expr{
         policy.Selector{MatchLabels: map[string]string{"env": "prod"}},
         policy.Not{Arg: policy.Pred{Path: []string{"metadata", "labels", "owner"}, Op: policy.OpExists}},
     }},
     Reason: "prod 对象必须带 owner 标签"},
}
```

表达式节点：`And` / `Or` / `Not`、`Pred`（嵌套字段谓词）、`Selector`
（K8s 风格标签选择器：`MatchLabels` + `In/NotIn/Exists/DoesNotExist`）、
`Quantifier`（`ForAll` / `Exists`，对集合逐元素求子表达式）。

## 求值

```go
plan, err := policy.Compile(rules)   // 编译期校验 + 冻结，计划不可变
short := plan.Evaluate(obj)          // 短路：首个命中规则即拒绝，无副作用
full := plan.EvaluateAll(obj)        // 合并：按稳定规则顺序输出全部命中原因
```

求值是纯函数：不修改对象、不修改计划，短路不会留下可观察的副作用。

## 语义要点

- **三态字段解析**：路径可能是「缺失 / 显式 null / 有值」。
  `Exists`/`NotExists`/`IsNull`/`IsNotNull` 区分三者；`Eq nil` 命中显式
  null 但不命中缺失字段；其余值谓词对缺失与 null 均为假。
- **量词空集合**：`ForAll` 对空集合 vacuously 为真，`Exists` 为假；
  对缺失、null 或非列表路径，两种量词均为假（区别于空集合）。
- **空逻辑**：`And{}` 为真，`Or{}` 为假。

## 热替换

```go
engine, _ := policy.NewEngine(rulesV1)
go serve(engine)              // webhook 并发求值
engine.Update(rulesV2)        // 完整编译后原子换入；编译失败则旧计划继续服务
```

`Update` 先完整编译再做单次原子指针交换，并发求值只会看到完整的旧计划
或完整的新计划；编译时深拷贝规则数据，调用方事后修改规则不会污染已编译
计划。

## 测试

```sh
go test -race ./...
```

- `policy/exhaustive_test.go`：小规模对象空间（标签 × 副本数 × 容器列表
  × 嵌套字段的笛卡尔积，含缺失/null/空集合/类型错误变体）与规则空间
  （全部谓词算子、选择器、量词、逻辑组合）穷举，逐条对照朴素解释器
  重算每个允许/拒绝决定与原因集合；多规则取代表性子集的全部 1–3 规则
  组合核对合并语义。
- `policy/engine_test.go`：热替换与求值交错的一致性（结果必等于旧或新
  规则集的朴素重算之一）、编译后调用方数据污染防护、失败更新保留旧计划。
- `policy/policy_test.go`：量词空集合、缺失 vs null、短路/合并、编译期
  校验的定向单测。
