package main

import (
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"math"
	"os"
	"sort"
	"strings"
)

func main() {
	input := flag.String("input", "", "输入 JSON 文件路径（缺省读标准输入）")
	maxLen := flag.Float64("max-len", 0, "覆盖单列长度上限（0 表示用输入值）")
	maxWeight := flag.Float64("max-weight", 0, "覆盖单列重量上限（0 表示用输入值）")
	dump := flag.Bool("dump", false, "逐条打印全部切分的对照明细")
	flag.Parse()

	if err := run(*input, *maxLen, *maxWeight, *dump, os.Stdout); err != nil {
		fmt.Fprintln(os.Stderr, "错误:", err)
		os.Exit(1)
	}
}

func run(input string, maxLen, maxWeight float64, dump bool, out io.Writer) error {
	var data []byte
	var err error
	if input == "" {
		data, err = io.ReadAll(os.Stdin)
	} else {
		data, err = os.ReadFile(input)
	}
	if err != nil {
		return err
	}
	var p Problem
	if err := json.Unmarshal(data, &p); err != nil {
		return fmt.Errorf("解析输入 JSON 失败: %w", err)
	}
	if maxLen > 0 {
		p.MaxLength = maxLen
	}
	if maxWeight > 0 {
		p.MaxWeight = maxWeight
	}
	if err := p.Validate(); err != nil {
		return err
	}

	cuts, val, ok := p.Solve()
	if !ok {
		return fmt.Errorf("无可行编组：%d 节车厢在给定限制与危险品规则下无法全部编组", len(p.Cars))
	}
	st := p.Exhaustive()

	printCertificate(out, p, cuts, val, st)
	if dump {
		printDump(out, p)
	}
	return nil
}

// printCertificate 输出分段证书与穷举对照结论。
func printCertificate(out io.Writer, p Problem, cuts []int, val Value, st Stats) {
	w := func(format string, args ...any) { fmt.Fprintf(out, format+"\n", args...) }

	w("=== 分段证书 ===")
	w("车厢数: %d (上限 %d)", len(p.Cars), MaxCars)
	w("限制: 单列长度 ≤ %g, 单列重量 ≤ %g", p.MaxLength, p.MaxWeight)
	w("费用: 每列固定 %g, 另按列内每种车型计费 %s", p.TrainBase, formatTypeCost(p))
	w("切分: %s", formatCuts(cuts))
	w("")
	for s := 0; s+1 < len(cuts); s++ {
		i, j := cuts[s], cuts[s+1]
		var length, weight float64
		ids := make([]string, 0, j-i)
		types := map[string]int{}
		for k := i; k < j; k++ {
			c := p.Cars[k]
			length += c.Length
			weight += c.Weight
			types[c.Type]++
			tag := c.ID
			if c.Hazard != 0 {
				tag += fmt.Sprintf("(危%d)", c.Hazard)
			}
			ids = append(ids, tag)
		}
		w("列车 %d: 车厢 %s", s+1, strings.Join(ids, " "))
		w("  长度 %g ≤ %g ✓ | 重量 %g ≤ %g ✓ | 车型 %s | 危险品相邻 ✓ | 费用 %g",
			length, p.MaxLength, weight, p.MaxWeight, formatTypes(types), p.segmentCost(i, j))
	}
	w("")
	w("总费用: %g | 列数: %d", val.Cost, val.Trains)
	w("")
	w("=== 穷举对照 ===")
	w("切分总数: %d | 可行: %d | 不可行: %d", st.Total, st.Feasible, st.Total-st.Feasible)
	w("最小费用: %g (共 %d 种切分达到) | 其中最少列数: %d", st.BestCost, st.BestCount, st.BestTrains)
	if math.Abs(val.Cost-st.BestCost) <= eps && val.Trains == st.BestTrains {
		w("结论: 本证书达到最小费用且列数最少，经全部 %d 种切分穷举验证为最优。", st.Total)
	} else {
		w("结论: 警告——DP 结果与穷举最优不一致！")
	}
}

// printDump 逐条打印全部切分的可行性与费用明细。
func printDump(out io.Writer, p Problem) {
	n := len(p.Cars)
	total := 1 << (n - 1)
	fmt.Fprintf(out, "\n=== 全部切分明细 (%d 条) ===\n", total)
	for mask := 0; mask < total; mask++ {
		cuts := []int{0}
		for k := 0; k < n-1; k++ {
			if mask>>k&1 == 1 {
				cuts = append(cuts, k+1)
			}
		}
		cuts = append(cuts, n)
		if v, ok := p.splitValue(cuts); ok {
			fmt.Fprintf(out, "#%0*d %s 可行 费用=%g 列数=%d\n", len(fmt.Sprint(total-1)), mask, formatCuts(cuts), v.Cost, v.Trains)
		} else {
			fmt.Fprintf(out, "#%0*d %s 不可行\n", len(fmt.Sprint(total-1)), mask, formatCuts(cuts))
		}
	}
}

func formatTypeCost(p Problem) string {
	if len(p.TypeCost) == 0 {
		return "(缺省每种 1)"
	}
	keys := make([]string, 0, len(p.TypeCost))
	for k := range p.TypeCost {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	parts := make([]string, 0, len(keys))
	for _, k := range keys {
		parts = append(parts, fmt.Sprintf("%s:%g", k, p.TypeCost[k]))
	}
	return "{" + strings.Join(parts, " ") + "}"
}

func formatTypes(m map[string]int) string {
	keys := make([]string, 0, len(m))
	for k := range m {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	parts := make([]string, 0, len(keys))
	for _, k := range keys {
		parts = append(parts, fmt.Sprintf("%s×%d", k, m[k]))
	}
	return strings.Join(parts, " ")
}
