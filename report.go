package markov

import (
	"fmt"
	"math/big"
	"strings"
)

// ratStr formats a rational without a denominator of 1 ("3/2", "2").
func ratStr(r *big.Rat) string { return r.RatString() }

// Report renders the full analysis as text: the model, finite-step
// expectations, the hitting-reward equations with their solution, the
// closed-class evidence and classification, and the independent
// cross-checks (residual, Bareiss vs Gauss, short-step expansion).
func (c *Chain) Report(start int, targets []int, steps int) (string, error) {
	n := c.NumStates()
	if start < 0 || start >= n {
		return "", fmt.Errorf("start index %d out of range [0,%d)", start, n)
	}
	inTarget := make([]bool, n)
	for _, t := range targets {
		if t < 0 || t >= n {
			return "", fmt.Errorf("target index %d out of range [0,%d)", t, n)
		}
		inTarget[t] = true
	}
	var sb strings.Builder

	sb.WriteString("== 模型 ==\n")
	var desc []string
	for i := 0; i < n; i++ {
		desc = append(desc, fmt.Sprintf("%s(收益%s)", c.Names[i], c.R[i]))
	}
	sb.WriteString("状态: " + strings.Join(desc, ", ") + "\n转移:\n")
	for i := 0; i < n; i++ {
		var parts []string
		for j := 0; j < n; j++ {
			if c.P[i][j].Sign() != 0 {
				parts = append(parts, fmt.Sprintf("→%s %s", c.Names[j], ratStr(c.P[i][j])))
			}
		}
		sb.WriteString(fmt.Sprintf("  %s: %s\n", c.Names[i], strings.Join(parts, ", ")))
	}

	sb.WriteString(fmt.Sprintf("\n== 有限步期望（起点 %s）==\n", c.Names[start]))
	for k, e := range c.FiniteStepRewards(start, steps) {
		sb.WriteString(fmt.Sprintf("E_%d = %s\n", k, ratStr(e)))
	}

	var tnames []string
	for _, t := range targets {
		tnames = append(tnames, c.Names[t])
	}
	sb.WriteString(fmt.Sprintf("\n== 达到目标 {%s} 前的累计收益 ==\n",
		strings.Join(tnames, ", ")))
	ha, err := c.analyzeHit(targets)
	if err != nil {
		return "", err
	}
	if len(ha.vars) == 0 {
		sb.WriteString("（无需求解的方程组）\n")
	} else {
		sb.WriteString("方程组 x(i) = 常数项 + Σ p(i,j)·x(j)（目标边界 x=0）:\n")
		for row, i := range ha.vars {
			var terms []string
			for _, j := range ha.vars {
				if p := c.P[i][j]; p.Sign() != 0 {
					terms = append(terms, fmt.Sprintf("%s·x(%s)", ratStr(p), c.Names[j]))
				}
			}
			line := fmt.Sprintf("  x(%s) = %s", c.Names[i], ratStr(ha.b[row]))
			if len(terms) > 0 {
				line += " + " + strings.Join(terms, " + ")
			}
			if ha.boundary[row].Sign() != 0 {
				line += fmt.Sprintf("（常数项含零收益闭类进入贡献 %s）", ratStr(ha.boundary[row]))
			}
			sb.WriteString(line + "\n")
		}
	}
	sb.WriteString("解:\n")
	for i := 0; i < n; i++ {
		r := ha.results[i]
		switch {
		case inTarget[i]:
			sb.WriteString(fmt.Sprintf("  x(%s) = 0（目标边界）\n", c.Names[i]))
		case r.Status == Finite:
			sb.WriteString(fmt.Sprintf("  x(%s) = %s\n", c.Names[i], ratStr(r.Value)))
		default:
			sb.WriteString(fmt.Sprintf("  x(%s) = %s\n", c.Names[i], r.Status))
		}
	}

	sb.WriteString("\n== 封闭类证据 ==\n")
	for _, cl := range c.Classes() {
		var names []string
		hasTarget := false
		for _, s := range cl.States {
			names = append(names, c.Names[s])
			if inTarget[s] {
				hasTarget = true
			}
		}
		label := cl.Kind.String()
		if cl.Closed {
			if hasTarget {
				label += "（含目标）"
			} else {
				label += "（非目标闭类）"
			}
		}
		sb.WriteString(fmt.Sprintf("类 {%s}: %s\n", strings.Join(names, ", "), label))
		for _, ev := range c.classEvidence(cl) {
			sb.WriteString("  " + ev + "\n")
		}
		if cl.Closed {
			var pis []string
			for k, s := range cl.States {
				pis = append(pis, fmt.Sprintf("π(%s)=%s", c.Names[s], ratStr(cl.Stationary[k])))
			}
			sb.WriteString("  平稳分布: " + strings.Join(pis, ", ") + "\n")
			sb.WriteString(fmt.Sprintf("  平稳平均收益率 μ = %s\n", ratStr(cl.MeanReward)))
			if cl.Kind == ClosedDivergent {
				sb.WriteString("  结论: μ ≠ 0，类内累计收益以速率 μ 线性发散\n")
			} else {
				sb.WriteString("  结论: μ = 0，类内累计收益有界（零收益）\n")
			}
		}
	}

	sb.WriteString("\n== 独立核对 ==\n")
	shortN := steps
	if shortN > 6 {
		shortN = 6
	}
	v, err := c.verifyHit(ha, start, shortN)
	if err != nil {
		return "", err
	}
	sb.WriteString(fmt.Sprintf("分数消元残差 max|A·x − b| = %s（精确有理）\n", ratStr(v.Residual)))
	sb.WriteString("Bareiss 无分数消元 vs Gauss 分数消元: " + yesNo(v.BareissOK) + "\n")
	sb.WriteString(fmt.Sprintf("短步展开 n=%d: 矩阵迭代 E = %s, 路径枚举 E = %s（%s）\n",
		v.ShortN, ratStr(v.ShortIter), ratStr(v.ShortEnum), yesNo(v.ShortOK)))
	return sb.String(), nil
}

func yesNo(ok bool) string {
	if ok {
		return "一致"
	}
	return "不一致"
}
