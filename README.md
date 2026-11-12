# 合取查询包含与反例

供采集查询规划器导入的 Go 包。输入是已经解析的查询结构与关系模式，不解析
SQL。数据库和查询均为集合语义，无 NULL、算术、否定、聚合或隐含键约束。

## 语义

`Check(problem, budget)` 判断 `problem.A` 是否包含于 `problem.B`，即对所有
有限数据库 `D` 都有 `A(D) ⊆ B(D)`。证明搜索的是从 **B 的每个变量** 到
`A` 体变量或两查询常量的完整映射；常量固定，映射后 B 的每个体原子必须在
A 体中，B 头必须逐项等于 A 头。反方向映射不是本方向的证明。

- 关系名和正整数元数由 `Schema` 给出；同名关系元数必须一致。
- 项用 `Var` / `Const` 构造。变量作用域只在所属查询内；常量按 UTF-8 字节
  相等。
- 允许重复头项、重复原子、自连接和零元头。头变量必须出现在体内。
- 空体查询只允许常量头，并且恰好产生一个头元组。数据库中未列出的关系为空。
- 每查询最多 12 个变量、20 个体原子，超出会返回校验错误。
- `A`/`B` 头长度不一致会返回校验错误。

## 快速使用

```go
import (
    "fmt"

    dq "example.org/dataeng/q0294"
)

schema := dq.NewSchema(map[string]int{"R": 1, "S": 1})

// A(x) :- R(x), S(x)
a := dq.NewQuery(
    []dq.Term{dq.Var("x")},
    dq.NewAtom("R", dq.Var("x")),
    dq.NewAtom("S", dq.Var("x")),
)
// B(x) :- R(x)
b := dq.NewQuery(
    []dq.Term{dq.Var("x")},
    dq.NewAtom("R", dq.Var("x")),
)

result, err := dq.Check(dq.Problem{Schema: schema, A: a, B: b}, 1000)
if err != nil {
    panic(err)
}
switch result.Status {
case dq.Contained:
    for _, binding := range result.Mapping {
        fmt.Printf("%s -> %s\n", binding.Variable, binding.Target)
    }
case dq.NotContained:
    fmt.Println(result.Counterexample.Database)
    fmt.Println(result.Counterexample.Head)
case dq.Undecided:
    fmt.Println("continue with result.Cursor")
}
```

`Result.Mapping` 在包含时非空，按 B 变量 UTF-8 字节序给出每个变量的绑定，
因此是完整映射。`Result.Steps` 是本次调用的候选尝试数，`TotalSteps` 是从
最初调用起的累计数。

## 预算与恢复

预算只限制“为下一个变量试一个候选”的次数；被已知头约束或部分原子检查立即
剪掉的候选也算一次尝试。搜索顺序固定：

1. B 变量按 UTF-8 名字节序；
2. 每个变量的候选先常量、后 A 体变量；
3. 常量与变量各自按 UTF-8 字节序。

因此始终返回该顺序下的首个成功映射。预算耗尽返回 `Undecided` 和游标，绝不
返回 `NotContained`。同一输入连续恢复与一次使用足够大的预算等价：

```go
result, _ := dq.Check(problem, 1)
for result.Status == dq.Undecided {
    result, _ = dq.Resume(problem, result.Cursor, 1)
}
```

游标持有校验后输入的私有快照和精确 DFS 状态，不引用调用方的切片、map 或
`Progress` 返回值；恢复时会核对输入的标准编码，输入不一致会报错。
`dq.Unlimited` 可用于一次性运行。

## 反例与解释器

搜索空间穷尽且不存在映射时，包会把 A 的每个变量替换成 `Value` 类型中的
`ValueFresh` 新符号，A 体实例化为数据库，A 头实例化为返回元组。新符号与
用户常量是不同的 kind，即使文本相同也不相等，不靠拼接普通字符串。

反例不是只填证书字段：生成过程中会用 `ContainsTuple` 重新执行 A（必须包含
头元组）和 B（必须不包含头元组）。调用方也可用完整解释器复核：

```go
aAnswers, _ := dq.Evaluate(a, ce.Database)
bAnswers, _ := dq.Evaluate(b, ce.Database)
// aAnswers 必须含 ce.Head，bAnswers 必须不含 ce.Head。
```

`Evaluate` 是独立的集合语义解释器；`ContainsTuple` 是带目标头约束的成员
检查。它们不参与“用样例数据证明包含”的推断。

## 等价

`CheckEquivalence(problem, budget)` 分别检查 A ⊆ B 与 B ⊆ A。只有两个方向都
为 `Contained` 才报告 `Equal=true`；任一方向 `NotContained` 即可报告不相等。
任一方向未决时，结果保留对应 `Result.Cursor`，可用原问题或
`problem.Reverse()` 继续恢复。预算按方向独立计算。

## 示例与测试

```bash
go test ./...
go run ./examples/planner
```

`examples/planner` 展示规划器调用、完整映射输出、反向失败反例和解释器复核。
测试包括：

- `A(x):-R(x),S(x)` 与 `B(x):-R(x)` 的正向包含，以及反向失败的最小单事实
  反例；
- 自连接变量合并、常量固定、重复头位置一致性、重复原子、空体与零元头；
- 首个成功映射的变量/候选字节序，以及常量先于变量；
- 分段预算恢复与一次大预算的结果、步骤数、映射/反例一致性；
- 游标快照不被调用方后续修改影响；
- 小域上**枚举全部数据库**的独立语义测试，逐个用解释器比较 A(D)/B(D)；
- 每个反例都由 `Evaluate` 和 `ContainsTuple` 重新计算，而不是只检查状态。
