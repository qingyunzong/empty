package main

import (
	"fmt"
	"math/rand"
	"reflect"
	"testing"
)

func mustParse(t *testing.T, in string) []Op {
	t.Helper()
	ops, err := Parse(in)
	if err != nil {
		t.Fatalf("Parse(%q) 出错: %v", in, err)
	}
	return ops
}

func TestParseCompact(t *testing.T) {
	ops := mustParse(t, "r1(A) w1(A) r2(A) # 注释\nw2(B)")
	want := []Op{
		{1, 'R', "A"}, {1, 'W', "A"}, {2, 'R', "A"}, {2, 'W', "B"},
	}
	if !reflect.DeepEqual(ops, want) {
		t.Fatalf("got %+v want %+v", ops, want)
	}
}

func TestParseTriple(t *testing.T) {
	ops := mustParse(t, "1 R A\n1 W A\n2 R A")
	want := []Op{{1, 'R', "A"}, {1, 'W', "A"}, {2, 'R', "A"}}
	if !reflect.DeepEqual(ops, want) {
		t.Fatalf("got %+v want %+v", ops, want)
	}
}

func TestParseTooManyTxns(t *testing.T) {
	in := ""
	for i := 1; i <= 13; i++ {
		in += fmt.Sprintf("r%d(X) ", i)
	}
	if _, err := Parse(in); err == nil {
		t.Fatal("13 个事务应被拒绝")
	}
}

func TestBuildEdges(t *testing.T) {
	ops := mustParse(t, "r1(A) w2(A) r3(A) w1(B) r2(B)")
	edges := BuildEdges(ops)
	var kinds []string
	for _, e := range edges {
		kinds = append(kinds, fmt.Sprintf("%d-%s->%d", e.From, e.Kind, e.To))
	}
	want := []string{"1-RW->2", "2-WR->3", "1-WR->2"}
	if !reflect.DeepEqual(kinds, want) {
		t.Fatalf("got %v want %v", kinds, want)
	}
}

// 经典可串行化调度: r1(A) w1(A) r2(A) w1(B) r2(B)，等效串行 T1->T2
func TestSerializableTopo(t *testing.T) {
	ops := mustParse(t, "r1(A) w1(A) r2(A) w1(B) r2(B)")
	ids := TxnIDs(ops)
	edges := BuildEdges(ops)
	if cyc := FindCycle(ids, edges); cyc != nil {
		t.Fatalf("不应有环: %v", cyc)
	}
	order, ok := TopoMinID(ids, edges)
	if !ok {
		t.Fatal("应可拓扑排序")
	}
	if !reflect.DeepEqual(order, []int{1, 2}) {
		t.Fatalf("got %v want [1 2]", order)
	}
	if !ReplayEquivalent(ops, order) {
		t.Fatal("重放验证应通过")
	}
}

// 经典不可串行化调度: r1(A) r2(B) w1(B) w2(A)，环 T1 -RW(B)-> T2 -RW(A)-> T1
func TestCycleDetection(t *testing.T) {
	ops := mustParse(t, "r1(A) r2(B) w1(B) w2(A)")
	ids := TxnIDs(ops)
	edges := BuildEdges(ops)
	cyc := FindCycle(ids, edges)
	if cyc == nil {
		t.Fatal("应检测到环")
	}
	if len(cyc) != 2 {
		t.Fatalf("环应有 2 条边, got %v", cyc)
	}
	// 环边必须首尾相接
	for i := 0; i < len(cyc); i++ {
		if cyc[i].To != cyc[(i+1)%len(cyc)].From {
			t.Fatalf("环边不相接: %v", cyc)
		}
	}
	if _, ok := TopoMinID(ids, edges); ok {
		t.Fatal("有环时不应给出拓扑序")
	}
}

// 自环事务对: w1(A) r2(A) w2(A) r1(A) -> 1->2 且 2->1
func TestTwoNodeCycleKinds(t *testing.T) {
	ops := mustParse(t, "w1(A) r2(A) w2(A) r1(A)")
	ids := TxnIDs(ops)
	edges := BuildEdges(ops)
	cyc := FindCycle(ids, edges)
	if cyc == nil {
		t.Fatal("应检测到环")
	}
	kinds := map[string]bool{}
	for _, e := range cyc {
		kinds[e.Kind] = true
	}
	if !kinds["WR"] && !kinds["WW"] {
		t.Fatalf("环边类型异常: %v", cyc)
	}
}

// 最小 ID 拓扑序: 无依赖时严格升序；有依赖时满足约束下每轮取最小。
func TestTopoMinIDOrder(t *testing.T) {
	ops := mustParse(t, "r3(X) w2(X) r1(Y)")
	ids := TxnIDs(ops)
	edges := BuildEdges(ops)
	order, ok := TopoMinID(ids, edges)
	if !ok {
		t.Fatal("应可拓扑排序")
	}
	// 约束: T3 -> T2；T1 无约束。每轮取最小: T1, T3, T2
	if !reflect.DeepEqual(order, []int{1, 3, 2}) {
		t.Fatalf("got %v want [1 3 2]", order)
	}
}

// 重放验证能拒绝错误的串行顺序。
func TestReplayRejectsBadOrder(t *testing.T) {
	ops := mustParse(t, "w1(A) r2(A)")
	if ReplayEquivalent(ops, []int{2, 1}) {
		t.Fatal("T2->T1 时 r2(A) 读到版本 0 而非 1，应判不一致")
	}
	if !ReplayEquivalent(ops, []int{1, 2}) {
		t.Fatal("T1->T2 应一致")
	}
}

// 初始版本: 无写入时读版本 0。
func TestInitialVersion(t *testing.T) {
	ops := mustParse(t, "r1(A) r2(A)")
	read := OriginalReads(ops)
	if read[0] != 0 || read[1] != 0 {
		t.Fatalf("初始版本应为 0, got %v", read)
	}
}

// 小规模随机历史：排列枚举对照。
// 对 2~4 个事务的随机历史，验证：
//  1. 依赖图无环 <=> 枚举存在至少一个有效串行顺序；
//  2. 无环时最小 ID 拓扑序必在枚举出的有效顺序集合中。
func TestEnumerationCrossCheck(t *testing.T) {
	rng := rand.New(rand.NewSource(42))
	items := []string{"A", "B"}
	for trial := 0; trial < 300; trial++ {
		n := 2 + rng.Intn(3) // 2..4 个事务
		// 每个事务 1~3 个操作，保持事务内顺序，随机交错合并
		var perTxn [][]Op
		for tx := 1; tx <= n; tx++ {
			m := 1 + rng.Intn(3)
			var list []Op
			for k := 0; k < m; k++ {
				kind := byte('R')
				if rng.Intn(2) == 0 {
					kind = 'W'
				}
				list = append(list, Op{Txn: tx, Kind: kind, Item: items[rng.Intn(len(items))]})
			}
			perTxn = append(perTxn, list)
		}
		var ops []Op
		pos := make([]int, n)
		for left := true; left; {
			left = false
			for tx := 0; tx < n; tx++ {
				if pos[tx] < len(perTxn[tx]) {
					left = true
				}
			}
			if !left {
				break
			}
			var avail []int
			for tx := 0; tx < n; tx++ {
				if pos[tx] < len(perTxn[tx]) {
					avail = append(avail, tx)
				}
			}
			tx := avail[rng.Intn(len(avail))]
			ops = append(ops, perTxn[tx][pos[tx]])
			pos[tx]++
		}

		ids := TxnIDs(ops)
		edges := BuildEdges(ops)
		acyclic := FindCycle(ids, edges) == nil
		valid := EnumerateValidOrders(ids, ops)

		// 冲突可串行 => 视图可串行，反之不然；故只断言单向蕴含。
		if acyclic && len(valid) == 0 {
			t.Fatalf("trial %d: 无环但枚举无有效顺序, ops=%v", trial, ops)
		}
		if acyclic {
			order, ok := TopoMinID(ids, edges)
			if !ok {
				t.Fatalf("trial %d: 无环但拓扑排序失败", trial)
			}
			found := false
			for _, v := range valid {
				if reflect.DeepEqual(v, order) {
					found = true
					break
				}
			}
			if !found {
				t.Fatalf("trial %d: 拓扑序 %v 不在枚举有效顺序 %v 中, ops=%v", trial, order, valid, ops)
			}
			if !ReplayEquivalent(ops, order) {
				t.Fatalf("trial %d: 拓扑序 %v 重放不一致", trial, order)
			}
		}
	}
}

// 枚举对照的具体小例子: w1(A) r2(A) 只有 T1->T2 有效。
func TestEnumerationConcrete(t *testing.T) {
	ops := mustParse(t, "w1(A) r2(A)")
	valid := EnumerateValidOrders([]int{1, 2}, ops)
	if len(valid) != 1 || !reflect.DeepEqual(valid[0], []int{1, 2}) {
		t.Fatalf("got %v want [[1 2]]", valid)
	}
}

// 冲突图有环但视图可串行的经典反例: w1(B) w1(A) r2(A) w1(A)。
// 环: w1(A) -WR-> r2(A) 且 r2(A) -RW-> w1(A)；但串行 T1->T2 视图等效。
func TestViewSerializableButConflictCyclic(t *testing.T) {
	ops := mustParse(t, "w1(B) w1(A) r2(A) w1(A)")
	ids := TxnIDs(ops)
	edges := BuildEdges(ops)
	if FindCycle(ids, edges) == nil {
		t.Fatal("冲突图应有环")
	}
	valid := EnumerateValidOrders(ids, ops)
	if len(valid) != 1 || !reflect.DeepEqual(valid[0], []int{1, 2}) {
		t.Fatalf("视图等效顺序应为 [[1 2]], got %v", valid)
	}
}
