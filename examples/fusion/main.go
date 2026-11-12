// 融合宿主示例：两个候选匹配因子共享实体变量，演示精确变量消元、
// 证据代入、规范化概率与容量预算，而不是把局部置信度当作独立后验相乘。
package main

import (
	"fmt"
	"math/big"

	dataeng "example.org/dataeng/q0307"
)

func main() {
	// 实体 E 的身份域、两个数据源各自的候选匹配域。
	variables := []dataeng.Variable{
		{ID: "E", Domain: []string{"alice", "bob", "carol"}},
		{ID: "src1", Domain: []string{"match", "miss"}},
		{ID: "src2", Domain: []string{"match", "miss"}},
	}

	// 先验（1/2、1/3、1/6）与两个重叠的候选匹配势，均为精确有理数。
	factors := []dataeng.Factor{
		{Scope: []string{"E"}, Entries: []dataeng.Entry{
			{Assignment: []string{"alice"}, Value: big.NewRat(1, 2)},
			{Assignment: []string{"bob"}, Value: big.NewRat(1, 3)},
			{Assignment: []string{"carol"}, Value: big.NewRat(1, 6)},
		}},
		{Scope: []string{"E", "src1"}, Entries: []dataeng.Entry{
			{Assignment: []string{"alice", "match"}, Value: big.NewRat(4, 5)},
			{Assignment: []string{"alice", "miss"}, Value: big.NewRat(1, 5)},
			{Assignment: []string{"bob", "match"}, Value: big.NewRat(1, 4)},
			{Assignment: []string{"bob", "miss"}, Value: big.NewRat(3, 4)},
			{Assignment: []string{"carol", "match"}, Value: big.NewRat(1, 2)},
			{Assignment: []string{"carol", "miss"}, Value: big.NewRat(1, 2)},
		}},
		{Scope: []string{"src2", "E"}, Entries: []dataeng.Entry{
			{Assignment: []string{"match", "alice"}, Value: big.NewRat(2, 3)},
			{Assignment: []string{"miss", "alice"}, Value: big.NewRat(1, 3)},
			{Assignment: []string{"match", "bob"}, Value: big.NewRat(3, 5)},
			{Assignment: []string{"miss", "bob"}, Value: big.NewRat(2, 5)},
			{Assignment: []string{"match", "carol"}, Value: big.NewRat(1, 6)},
			{Assignment: []string{"miss", "carol"}, Value: big.NewRat(5, 6)},
		}},
	}

	model, err := dataeng.NewModel(variables, factors)
	if err != nil {
		panic(err)
	}

	// 两个数据源都报告匹配，查询实体身份的后验；预算给得很小。
	evidence := map[string]string{"src1": "match", "src2": "match"}
	result, err := model.Query([]string{"E"}, evidence, big.NewInt(12))
	if err != nil {
		panic(err)
	}

	switch result.Status {
	case dataeng.StatusNeedsBudget:
		fmt.Printf("needsBudget at %q, required cells=%s; executed %d rounds\n",
			result.NeedsVariable, result.RequiredCells.String(), len(result.Trace))
		return
	case dataeng.StatusContradiction:
		fmt.Println("evidence is contradictory: Z=0, no posterior fabricated")
		return
	case dataeng.StatusOK:
	}

	fmt.Printf("Z = %s\n", result.Z.RatString())
	for i, e := range result.Probability {
		fmt.Printf("P(E=%s | evidence) = %s  (U=%s)\n",
			e.Assignment[0], e.Value.RatString(), result.U[i].Value.RatString())
	}
	for _, round := range result.Trace {
		fmt.Printf("elimination trace: drop %s, combined=%v, result=%v, cells=%s, fills=%v\n",
			round.Eliminated, round.CombinedScope, round.ResultScope,
			round.RequiredCells.String(), round.FillEdges)
	}
}
