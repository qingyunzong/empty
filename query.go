package dataeng

import (
	"errors"
	"fmt"
	"math/big"
	"sort"
)

// 查询状态。
const (
	// StatusOK 表示查询完成，U、Z 与规范化概率均有效。
	StatusOK = "ok"
	// StatusContradiction 表示证据下 Z=0，结果为零，不含任何概率。
	StatusContradiction = "contradiction"
	// StatusNeedsBudget 表示某一步的稠密结合域单元数超过 cellBudget，
	// 结果字段为空，仅返回已执行消元前缀与精确需求。
	StatusNeedsBudget = "needsBudget"
)

// RoundTrace 是一轮变量消元的实际执行轨迹。
type RoundTrace struct {
	// Eliminated 是本轮消去的隐藏变量 ID。
	Eliminated string
	// InvolvedScopes 是参与相乘的因子 scope，按模型次序给出轴。
	InvolvedScopes [][]string
	// CombinedScope 是相乘后、求和前的结合 scope。
	CombinedScope []string
	// ResultScope 是沿消去变量求和后的新因子 scope。
	ResultScope []string
	// FillEdges 是本轮在无向图上新增的填充边，端点按 ASCII 序排列。
	FillEdges [][2]string
	// RequiredCells 是结合 scope 全部域大小之积（公开稠密容量上界）。
	RequiredCells *big.Int
	// Synthetic 为 true 时表示没有因子提及该变量，使用了常数 1 的一元因子。
	Synthetic bool
}

// QueryResult 是一次查询的结果。
type QueryResult struct {
	// Status 取 StatusOK、StatusContradiction 或 StatusNeedsBudget。
	Status string
	// U 是按 Q 轴顺序排列的规范稀疏未规范化势，仅含非零项。
	U []Entry
	// Z 是 U 的总和；矛盾时为 0，预算不足时为 nil。
	Z *big.Rat
	// Probability 是 U/Z 的规范稀疏结果；非 OK 状态为 nil。
	Probability []Entry
	// Trace 是实际执行的消元轨迹（预算不足时为已完成的前缀）。
	Trace []RoundTrace
	// NeedsVariable 是预算不足时对应的变量；最终相乘阶段为 "final"。
	NeedsVariable string
	// RequiredCells 是预算不足那一步精确的稠密单元需求。
	RequiredCells *big.Int
}

// Query 执行带证据的变量消元。cellBudget 必须为正整数。
// 查询不修改模型，也不修改或复用任何历史轨迹；每次都从原因子重新代入证据。
func (m *Model) Query(q []string, evidence map[string]string, cellBudget *big.Int) (*QueryResult, error) {
	if cellBudget == nil || cellBudget.Sign() <= 0 {
		return nil, errors.New("dataeng: cellBudget must be a positive integer")
	}
	qIdx, evIdx, err := m.validateQuery(q, evidence)
	if err != nil {
		return nil, err
	}

	// 每次查询都从原始模型因子重新限制，绝不复用历史残表。
	factors := make([]*ifactor, 0, len(m.factors))
	for _, f := range m.factors {
		factors = append(factors, m.restrict(f, evIdx))
	}

	g := newGraph()
	hidden := make(map[int]bool)
	for i := range m.vars {
		if _, fixed := evIdx[m.vars[i].ID]; fixed {
			continue // 证据变量不入图
		}
		g.addNode(i) // 包含无因子提及的孤立变量
		if !containsInt(qIdx, i) {
			hidden[i] = true
		}
	}
	for _, f := range factors {
		// 每个因子自身的 scope 成团；不同因子仅共享变量，不自动产生跨 scope 的边。
		g.addClique(f.scope)
	}

	res := &QueryResult{}
	trace := make([]RoundTrace, 0)

	for len(hidden) > 0 {
		v := m.pickHidden(g, hidden)
		involved := make([]*ifactor, 0)
		remaining := make([]*ifactor, 0, len(factors))
		synthetic := false
		for _, f := range factors {
			if len(f.scope) > 0 && containsInt(f.scope, v) {
				involved = append(involved, f)
			} else {
				remaining = append(remaining, f)
			}
		}
		if len(involved) == 0 {
			involved = append(involved, m.syntheticUnary(v))
			synthetic = true
		}

		combined := unionScope(involved)
		required := m.domainProduct(combined)
		if required.Cmp(cellBudget) > 0 {
			res.Status = StatusNeedsBudget
			res.NeedsVariable = m.vars[v].ID
			res.RequiredCells = required
			res.Trace = trace
			return res, nil
		}

		fills := m.fillEdges(g, v)
		round := RoundTrace{
			Eliminated:     m.vars[v].ID,
			InvolvedScopes: scopeIDMatrix(m, involved),
			CombinedScope:  (&ifactor{scope: combined}).scopeIDs(m),
			FillEdges:      m.fillEdgeIDs(fills),
			RequiredCells:  new(big.Int).Set(required),
			Synthetic:      synthetic,
		}

		product := m.multiply(involved)
		summed := m.sumOut(product, v)
		round.ResultScope = summed.scopeIDs(m)
		trace = append(trace, round)

		g.applyFills(v, fills)
		g.eliminate(v)
		delete(hidden, v)
		g.addClique(summed.scope)
		// 即使求和后退化为常数因子（孤立变量的域大小、或零因子），也必须保留，
		// 否则隐藏变量的域大小贡献与矛盾信号都会丢失。
		remaining = append(remaining, summed)
		factors = remaining
	}

	// 最终相乘：按 Q 全部域大小的公开稠密上界检查预算。
	finalRequired := m.domainProduct(qIdx)
	if finalRequired.Cmp(cellBudget) > 0 {
		res.Status = StatusNeedsBudget
		res.NeedsVariable = "final"
		res.RequiredCells = finalRequired
		res.Trace = trace
		return res, nil
	}

	final := m.multiply(factors)
	u, z := m.materialize(final, qIdx)
	res.Trace = trace

	if z.Sign() == 0 {
		res.Status = StatusContradiction
		res.Z = big.NewRat(0, 1)
		return res, nil
	}

	prob := make([]Entry, len(u))
	for i, e := range u {
		prob[i] = Entry{
			Assignment: append([]string(nil), e.Assignment...),
			Value:      new(big.Rat).Quo(e.Value, z),
		}
	}
	res.Status = StatusOK
	res.U = u
	res.Z = z
	res.Probability = prob
	return res, nil
}

func (m *Model) validateQuery(q []string, evidence map[string]string) ([]int, map[string]int, error) {
	qIdx := make([]int, 0, len(q))
	qSeen := make(map[int]bool, len(q))
	for _, id := range q {
		idx, ok := m.index[id]
		if !ok {
			return nil, nil, fmt.Errorf("dataeng: query references unknown variable %q", id)
		}
		if qSeen[idx] {
			return nil, nil, fmt.Errorf("dataeng: query variable %q repeated", id)
		}
		qSeen[idx] = true
		qIdx = append(qIdx, idx)
	}
	evIdx := make(map[string]int, len(evidence))
	for id, val := range evidence {
		idx, ok := m.index[id]
		if !ok {
			return nil, nil, fmt.Errorf("dataeng: evidence references unknown variable %q", id)
		}
		dIdx, ok := m.domVal[idx][val]
		if !ok {
			return nil, nil, fmt.Errorf("dataeng: evidence value %q is out of domain for %q", val, id)
		}
		if qSeen[idx] {
			return nil, nil, fmt.Errorf("dataeng: variable %q appears in both query and evidence", id)
		}
		evIdx[id] = dIdx
	}
	return qIdx, evIdx, nil
}

func (m *Model) domainProduct(scope []int) *big.Int {
	prod := big.NewInt(1)
	for _, v := range scope {
		prod.Mul(prod, big.NewInt(int64(m.domSize[v])))
	}
	return prod
}

func unionScope(factors []*ifactor) []int {
	set := make(map[int]bool)
	union := make([]int, 0)
	for _, f := range factors {
		for _, v := range f.scope {
			if !set[v] {
				set[v] = true
				union = append(union, v)
			}
		}
	}
	sort.Ints(union)
	return union
}

func scopeIDMatrix(m *Model, factors []*ifactor) [][]string {
	out := make([][]string, len(factors))
	for i, f := range factors {
		out[i] = f.scopeIDs(m)
	}
	return out
}

func (m *Model) fillEdgeIDs(fills [][2]int) [][2]string {
	out := make([][2]string, len(fills))
	for i, e := range fills {
		out[i] = [2]string{m.vars[e[0]].ID, m.vars[e[1]].ID}
	}
	return out
}

// materialize 将最终因子补齐到 Q 的轴顺序，并保证按元组字典序输出稀疏非零项。
func (m *Model) materialize(f *ifactor, qIdx []int) ([]Entry, *big.Rat) {
	posInFactor := make(map[int]int, len(f.scope))
	for p, v := range f.scope {
		posInFactor[v] = p
	}
	z := big.NewRat(0, 1)
	entries := make([]Entry, 0)

	var walk func(pos int, tuple []byte, assignment []string)
	walk = func(pos int, tuple []byte, assignment []string) {
		if pos == len(qIdx) {
			key := make([]byte, len(f.scope))
			for qp, v := range qIdx {
				if fp, ok := posInFactor[v]; ok {
					key[fp] = tuple[qp]
				}
			}
			val, ok := f.table[string(key)]
			if ok && val.Sign() != 0 {
				entry := Entry{Assignment: append([]string(nil), assignment...), Value: new(big.Rat).Set(val)}
				entries = append(entries, entry)
				z.Add(z, val)
			}
			return
		}
		v := qIdx[pos]
		for d := 0; d < m.domSize[v]; d++ {
			tuple[pos] = byte(d)
			assignment[pos] = m.vars[v].Domain[d]
			walk(pos+1, tuple, assignment)
		}
	}

	if len(qIdx) > 0 {
		walk(0, make([]byte, len(qIdx)), make([]string, len(qIdx)))
	} else {
		val, ok := f.table[""]
		if ok && val.Sign() != 0 {
			entries = append(entries, Entry{Assignment: []string{}, Value: new(big.Rat).Set(val)})
			z.Set(val)
		}
	}
	return entries, z
}

func containsInt(s []int, x int) bool {
	for _, v := range s {
		if v == x {
			return true
		}
	}
	return false
}
