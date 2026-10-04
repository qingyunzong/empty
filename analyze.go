package main

import (
	"fmt"
	"strings"
)

// Report 汇总一次完整分析的结果。
type Report struct {
	History   *History
	Graph     *Graph
	Acyclic   bool
	SCCs      [][]int
	Cycles    [][]Edge
	Order     []int
	Rounds    []TopoRound
	Checks    []ReadCheck
	ReplayOK  bool
	EnumDone  bool
	EnumTotal int
	EnumValid [][]int
	EnumMatch bool
}

// Analyze 执行完整分析：建图、判环、拓扑排序、重放验证、排列枚举对照。
func Analyze(h *History) *Report {
	r := &Report{History: h}
	r.Graph = BuildGraph(h)
	r.SCCs = r.Graph.SCCs()
	r.Acyclic = len(r.SCCs) == 0
	if r.Acyclic {
		r.Order, r.Rounds, _ = r.Graph.TopoMinID()
		r.Checks, r.ReplayOK = Replay(h, r.Order)
	} else {
		for _, scc := range r.SCCs {
			r.Cycles = append(r.Cycles, r.Graph.CycleIn(scc))
		}
	}
	if len(h.Txns) <= 8 {
		r.EnumDone = true
		r.EnumValid, r.EnumTotal = EnumeratePermutations(h)
		r.EnumMatch = (len(r.EnumValid) > 0) == r.Acyclic
	}
	return r
}

func txnList(ids []int) string {
	parts := make([]string, len(ids))
	for i, t := range ids {
		parts[i] = fmt.Sprintf("T%d", t)
	}
	return strings.Join(parts, " ")
}

func (r *Report) String() string {
	var b strings.Builder
	h := r.History
	fmt.Fprintf(&b, "=== 输入历史 ===\n")
	ops := make([]string, len(h.Ops))
	for i, op := range h.Ops {
		if op.Kind == 'W' {
			ops[i] = fmt.Sprintf("W%d(%s)", op.Txn, op.Item)
		} else {
			ops[i] = fmt.Sprintf("R%d(%s%d)", op.Txn, op.Item, op.Version)
		}
	}
	fmt.Fprintf(&b, "%s\n事务 (%d): %s\n\n", strings.Join(ops, " "), len(h.Txns), txnList(h.Txns))

	fmt.Fprintf(&b, "=== 依赖图 (版本序 = 写操作先后) ===\n")
	if len(r.Graph.Edges) == 0 {
		fmt.Fprintf(&b, "无冲突边\n\n")
	} else {
		fmt.Fprintf(&b, "冲突边 %d 条:\n", len(r.Graph.Edges))
		for _, e := range r.Graph.Edges {
			fmt.Fprintf(&b, "  %-22s %s\n", e.String(), e.Note)
		}
		fmt.Fprintf(&b, "\n")
	}

	if !r.Acyclic {
		fmt.Fprintf(&b, "=== 环检测 ===\n发现 %d 个环 (强连通分量):\n", len(r.SCCs))
		for i, scc := range r.SCCs {
			fmt.Fprintf(&b, "  环 #%d 事务: %s\n", i+1, txnList(scc))
			if i < len(r.Cycles) && len(r.Cycles[i]) > 0 {
				chain := make([]string, len(r.Cycles[i]))
				for j, e := range r.Cycles[i] {
					chain[j] = e.String()
				}
				fmt.Fprintf(&b, "  具体冲突边链: %s\n", strings.Join(chain, "  "))
				for _, e := range r.Cycles[i] {
					fmt.Fprintf(&b, "    - %s: %s\n", e.String(), e.Note)
				}
			}
		}
		fmt.Fprintf(&b, "\n=== 结论 ===\n✗ 不可串行化 (依赖图含环)\n")
	} else {
		fmt.Fprintf(&b, "=== 环检测 ===\n无环\n\n=== 结论 ===\n✓ 可串行化 (无环)\n")
		fmt.Fprintf(&b, "拓扑序 (每轮取候选中 ID 最小):\n")
		for i, rd := range r.Rounds {
			cand := make([]string, len(rd.Candidates))
			for j, c := range rd.Candidates {
				cand[j] = fmt.Sprintf("T%d", c)
			}
			fmt.Fprintf(&b, "  第 %d 轮: 候选 {%s} -> 选 T%d\n", i+1, strings.Join(cand, ", "), rd.Picked)
		}
		seq := make([]string, len(r.Order))
		for i, t := range r.Order {
			seq[i] = fmt.Sprintf("T%d", t)
		}
		fmt.Fprintf(&b, "  最终串行序: %s\n", strings.Join(seq, " -> "))
		okCount := 0
		for _, c := range r.Checks {
			if c.OK {
				okCount++
			}
		}
		if r.ReplayOK {
			fmt.Fprintf(&b, "重放验证: 通过 (%d/%d 读取版本一致)\n", okCount, len(r.Checks))
		} else {
			fmt.Fprintf(&b, "重放验证: 失败 (%d/%d 一致)\n", okCount, len(r.Checks))
		}
		for _, c := range r.Checks {
			fmt.Fprintf(&b, "  %s\n", c.String())
		}
	}

	if r.EnumDone {
		match := "一致"
		if !r.EnumMatch {
			match = "不一致!"
		}
		fmt.Fprintf(&b, "排列枚举对照 (%d 事务, %d 排列): 有效串行序 %d 个 -> 与图判定%s\n",
			len(r.History.Txns), r.EnumTotal, len(r.EnumValid), match)
	} else {
		fmt.Fprintf(&b, "排列枚举对照: 跳过 (事务数 %d > 8, 排列空间过大)\n", len(r.History.Txns))
	}
	return b.String()
}
