// faultplan：故障测试规划 CLI。
// 每个测试用例覆盖一个持久点子集（受容量限制），要求覆盖全部单故障
// 与指定双故障对，用例数不超过上限（默认 22），最小化总执行费用。
// 输出覆盖方案、对偶下界证书，并可在小规模下用掩码 DP 全量核对。
package main

import (
	"flag"
	"fmt"
	"os"
	"sort"
	"strconv"
	"strings"
	"time"
)

func parsePairs(spec string, n int) ([][2]int, error) {
	spec = strings.TrimSpace(spec)
	if spec == "" || spec == "all" {
		return AllPairs(n), nil
	}
	if spec == "none" {
		return nil, nil
	}
	var pairs [][2]int
	for _, tok := range strings.Split(spec, ",") {
		parts := strings.Split(strings.TrimSpace(tok), "-")
		if len(parts) != 2 {
			return nil, fmt.Errorf("无法解析点对 %q（格式如 0-1,2-3 或 all/none）", tok)
		}
		a, err1 := strconv.Atoi(strings.TrimSpace(parts[0]))
		b, err2 := strconv.Atoi(strings.TrimSpace(parts[1]))
		if err1 != nil || err2 != nil {
			return nil, fmt.Errorf("无法解析点对 %q", tok)
		}
		pairs = append(pairs, [2]int{a, b})
	}
	return NormalizePairs(n, pairs)
}

func maskPoints(m uint64, n int) []int {
	var pts []int
	for i := 0; i < n; i++ {
		if m>>uint(i)&1 == 1 {
			pts = append(pts, i)
		}
	}
	return pts
}

func main() {
	n := flag.Int("n", 6, "持久点数量")
	pairsSpec := flag.String("pairs", "all", `双故障对："all"、"none" 或 "0-1,2-3"`)
	maxCases := flag.Int("max-cases", 22, "用例数上限")
	setup := flag.Int("setup", 10, "每用例固定费用")
	perPoint := flag.Int("per-point", 1, "用例中每个故障点的费用")
	maxCaseSize := flag.Int("max-case-size", 3, "每用例最多同时注入的点数")
	verify := flag.Bool("verify", false, "小规模下用掩码 DP 全量核对最优值")
	showCert := flag.Bool("cert", false, "打印对偶下界证书的完整权重")
	timeout := flag.Float64("timeout", 60, "分支定界时限（秒），0 表示不限时")
	flag.Parse()

	if *n < 1 || *n > 24 {
		fmt.Fprintln(os.Stderr, "错误：n 须在 [1,24] 内")
		os.Exit(2)
	}
	pairs, err := parsePairs(*pairsSpec, *n)
	if err != nil {
		fmt.Fprintln(os.Stderr, "错误：", err)
		os.Exit(2)
	}
	p := &Problem{
		N: *n, Pairs: pairs, Setup: *setup, PerPoint: *perPoint,
		MaxCases: *maxCases, MaxCaseSize: *maxCaseSize,
	}
	if p.MaxCaseSize < 1 || p.MaxCaseSize > p.N {
		fmt.Fprintln(os.Stderr, "错误：max-case-size 须在 [1,n] 内")
		os.Exit(2)
	}

	fmt.Printf("故障测试规划：n=%d，需求=%d 单故障 + %d 双故障对，用例容量≤%d，费用=%d+%d×点数，用例数≤%d\n",
		p.N, p.N, len(p.Pairs), p.MaxCaseSize, p.Setup, p.PerPoint, p.MaxCases)

	cands := p.Candidates()
	var to time.Duration
	if *timeout > 0 {
		to = time.Duration(*timeout * float64(time.Second))
	}
	sol := SolveWithTimeout(p, to)
	if !sol.OK {
		fmt.Println("结果：在给定限制下不可行（用例数上限或容量不足以覆盖全部需求）")
		os.Exit(1)
	}

	if sol.Proven {
		fmt.Printf("\n最优方案（已证明最优）：总费用 %d，共 %d 个用例\n", sol.Cost, len(sol.Cases))
	} else {
		fmt.Printf("\n当前最优方案（超时，最优性未证明）：总费用 %d，共 %d 个用例\n", sol.Cost, len(sol.Cases))
	}
	sorted := append([]uint64(nil), sol.Cases...)
	sort.Slice(sorted, func(i, j int) bool { return sorted[i] < sorted[j] })
	for i, m := range sorted {
		fmt.Printf("  用例 %2d: 点 %v，费用 %d\n", i+1, maskPoints(m, p.N), p.CaseCost(len(maskPoints(m, p.N))))
	}

	cost, uncovered, err := p.Validate(sol.Cases)
	switch {
	case err != nil:
		fmt.Println("覆盖校验：失败 —", err)
		os.Exit(1)
	case len(uncovered) > 0:
		fmt.Printf("覆盖校验：失败 — 未覆盖需求 %v\n", uncovered)
		os.Exit(1)
	default:
		fmt.Printf("覆盖校验：全部 %d 项需求（%d 单故障 + %d 双故障对）已覆盖，费用复核 %d ✓\n",
			p.NumReqs(), p.N, len(p.Pairs), cost)
	}

	lb, y := DualLowerBound(p, cands)
	minSlack, ok := VerifyDual(p, cands, y)
	if !ok {
		fmt.Println("下界证书：验证失败（内部错误）")
		os.Exit(1)
	}
	fmt.Printf("下界证书：对偶可行解 LB=%.4f，最优费用 %d，间隙 %.4f，全部候选约束已验证（最小剩余 %.2e）✓\n",
		lb, sol.Cost, float64(sol.Cost)-lb, minSlack)
	if *showCert {
		fmt.Println("  对偶权重 y：")
		for r, v := range y {
			name := fmt.Sprintf("单故障#%d", r)
			if r >= p.N {
				pr := p.Pairs[r-p.N]
				name = fmt.Sprintf("双故障#%d-%d", pr[0], pr[1])
			}
			fmt.Printf("    %-14s %.6f\n", name, v)
		}
	}

	if *verify {
		if !sol.Proven {
			fmt.Println("小规模核对：跳过 — 分支定界未在时限内完成")
		} else {
			dpCost, dpOK, err := DPSolve(p)
			if err != nil {
				fmt.Println("小规模核对：跳过 —", err)
			} else if !dpOK {
				fmt.Println("小规模核对：DP 判定不可行，与分支定界不一致 ✗")
				os.Exit(1)
			} else if dpCost != sol.Cost {
				fmt.Printf("小规模核对：DP 最优 %d ≠ 分支定界 %d ✗\n", dpCost, sol.Cost)
				os.Exit(1)
			} else {
				fmt.Printf("小规模核对：掩码 DP 全量枚举最优 %d，与分支定界一致 ✓\n", dpCost)
			}
		}
	}
}
