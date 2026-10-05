package main

import (
	"fmt"
	"math"
	"strings"
)

// Certificate 生成最优编组的分段证书，并用穷举结果交叉验证。
func Certificate(p *Problem, sol *Solution, enum *Enumeration) string {
	var b strings.Builder
	s := newSolver(p)

	fmt.Fprintf(&b, "编组证书\n")
	fmt.Fprintf(&b, "========\n")
	fmt.Fprintf(&b, "车厢数: %d（原序 %s）\n", len(p.Cars), carIDList(p))
	fmt.Fprintf(&b, "目标: 总费用最小；费用相同时列车数最少\n\n")

	fmt.Fprintf(&b, "最优方案: 总费用 %.2f，列车数 %d\n\n", sol.Cost, sol.Trains)
	for idx, seg := range sol.Segments {
		ids := make([]string, 0, seg.End-seg.Start)
		for i := seg.Start; i < seg.End; i++ {
			ids = append(ids, p.Cars[i].ID)
		}
		fmt.Fprintf(&b, "第 %d 列: 车厢 %s（%d 节）\n", idx+1, strings.Join(ids, ","), seg.End-seg.Start)
		fmt.Fprintf(&b, "  长度 %.2f m，重量 %.2f t，费用 %.2f，车型 %s\n",
			seg.Length, seg.Weight, seg.Cost, seg.Type.Name)
		fmt.Fprintf(&b, "  车型对照:\n")
		for _, t := range p.Types {
			ok, reason := s.feasible(seg.Start, seg.End, t)
			mark := "  "
			if t.Name == seg.Type.Name {
				mark = "* "
			}
			if ok {
				fmt.Fprintf(&b, "    %s%-10s 可行，费用 %.2f\n", mark, t.Name, t.Cost)
			} else {
				fmt.Fprintf(&b, "    %s%-10s 不可行（%s）\n", mark, t.Name, reason)
			}
		}
		fmt.Fprintf(&b, "\n")
	}

	fmt.Fprintf(&b, "穷举验证\n")
	fmt.Fprintf(&b, "--------\n")
	fmt.Fprintf(&b, "切分总数: %d，可行切分: %d\n", enum.Total, enum.Feasible)
	if enum.Best == nil {
		fmt.Fprintf(&b, "穷举未找到可行方案\n")
		return b.String()
	}
	fmt.Fprintf(&b, "穷举最优: 总费用 %.2f，列车数 %d（%s）\n",
		enum.Best.Cost, enum.Best.Trains, p.splitString(enum.Best))
	if math.Abs(enum.Best.Cost-sol.Cost) <= eps && enum.Best.Trains == sol.Trains {
		fmt.Fprintf(&b, "结论: 动态规划结果与穷举一致，证书有效。\n")
	} else {
		fmt.Fprintf(&b, "结论: 警告——动态规划与穷举不一致！\n")
	}
	return b.String()
}

// EnumTable 列出全部切分的对照表（可行切分给出最优车型指派与费用）。
func EnumTable(p *Problem, enum *Enumeration) string {
	var b strings.Builder
	fmt.Fprintf(&b, "全部切分对照（共 %d 种）\n", enum.Total)
	for i, e := range enum.Entries {
		if !e.Feasible {
			fmt.Fprintf(&b, "#%0*d  无可行车型指派\n", len(fmt.Sprint(enum.Total)), i+1)
			continue
		}
		parts := make([]string, 0, len(e.Solution.Segments))
		for _, seg := range e.Solution.Segments {
			ids := make([]string, 0, seg.End-seg.Start)
			for k := seg.Start; k < seg.End; k++ {
				ids = append(ids, p.Cars[k].ID)
			}
			parts = append(parts, fmt.Sprintf("%s[%s]", strings.Join(ids, ","), seg.Type.Name))
		}
		fmt.Fprintf(&b, "#%0*d  费用 %.2f，%d 列: %s\n",
			len(fmt.Sprint(enum.Total)), i+1, e.Solution.Cost, e.Solution.Trains,
			strings.Join(parts, " | "))
	}
	return b.String()
}

func carIDList(p *Problem) string {
	ids := make([]string, len(p.Cars))
	for i, c := range p.Cars {
		ids[i] = c.ID
	}
	return strings.Join(ids, ",")
}
