package dataeng

import (
	"fmt"
	"strings"
)

// CycleError 表示规则依赖中存在环，Path 为找到的最小环，
// 首尾为同一规则，例如 [a b c a]。
type CycleError struct {
	Path []string
}

func (e *CycleError) Error() string {
	return fmt.Sprintf("rule dependency cycle detected: %s", strings.Join(e.Path, " -> "))
}

// ValidationError 表示规则声明不合法。
type ValidationError struct {
	Kind  string
	Rule  string
	Extra string
}

func (e *ValidationError) Error() string {
	if e.Extra == "" {
		return fmt.Sprintf("invalid rule %q: %s", e.Rule, e.Kind)
	}
	return fmt.Sprintf("invalid rule %q: %s: %s", e.Rule, e.Kind, e.Extra)
}

// Plan 是已校验的规则执行计划，按拓扑层级分批。
type Plan struct {
	// batches 按拓扑层级分组，同组内规则相互独立可并行。
	batches [][]*node
	// order 按声明顺序排列的全部节点，用于稳定发布结果。
	order []*node
}

type node struct {
	rule  Rule
	index int // 声明顺序
}

// Batches 返回每个批次包含的规则 ID，供调用方查看调度结构。
func (p *Plan) Batches() [][]string {
	out := make([][]string, len(p.batches))
	for i, b := range p.batches {
		for _, n := range b {
			out[i] = append(out[i], n.rule.ID)
		}
	}
	return out
}

// Build 校验规则集合并构建依赖 DAG。
// baseColumns 为数据集已有的基础列；规则的 Inputs 必须来自
// 基础列或其他规则的 Produces，且派生列的产出方必须经 DependsOn 可达。
// 依赖成环时返回包含最小环的 *CycleError。
func Build(rules []Rule, baseColumns []string) (*Plan, error) {
	byID := make(map[string]*node, len(rules))
	order := make([]*node, 0, len(rules))
	producer := make(map[string]string) // 派生列 -> 产出规则 ID

	for i := range rules {
		r := rules[i]
		if r.ID == "" {
			return nil, &ValidationError{Kind: "empty rule id", Extra: fmt.Sprintf("index %d", i)}
		}
		if r.Run == nil {
			return nil, &ValidationError{Kind: "nil Run func", Rule: r.ID}
		}
		if _, dup := byID[r.ID]; dup {
			return nil, &ValidationError{Kind: "duplicate rule id", Rule: r.ID}
		}
		n := &node{rule: r, index: i}
		byID[r.ID] = n
		order = append(order, n)
		for _, col := range r.Produces {
			if prev, dup := producer[col]; dup {
				return nil, &ValidationError{
					Kind:  "derived column produced by multiple rules",
					Rule:  r.ID,
					Extra: fmt.Sprintf("column %q also produced by %q", col, prev),
				}
			}
			producer[col] = r.ID
		}
	}

	// 依赖与输入列校验。
	avail := make(map[string]bool, len(baseColumns))
	for _, c := range baseColumns {
		avail[c] = true
	}
	for _, n := range order {
		seen := make(map[string]bool, len(n.rule.DependsOn))
		for _, dep := range n.rule.DependsOn {
			if _, ok := byID[dep]; !ok {
				return nil, &ValidationError{Kind: "unknown dependency", Rule: n.rule.ID, Extra: dep}
			}
			if seen[dep] {
				return nil, &ValidationError{Kind: "duplicate dependency", Rule: n.rule.ID, Extra: dep}
			}
			seen[dep] = true
		}
		for _, col := range n.rule.Inputs {
			if avail[col] {
				continue
			}
			src, ok := producer[col]
			if !ok {
				return nil, &ValidationError{Kind: "unavailable input column", Rule: n.rule.ID, Extra: col}
			}
			if src == n.rule.ID {
				return nil, &ValidationError{Kind: "rule reads its own derived column", Rule: n.rule.ID, Extra: col}
			}
			if !reachable(byID, n.rule.ID, src) {
				return nil, &ValidationError{
					Kind:  "input column producer is not a transitive dependency",
					Rule:  n.rule.ID,
					Extra: fmt.Sprintf("column %q produced by %q", col, src),
				}
			}
		}
	}

	// 环检测：返回最小环。
	if cycle := shortestCycle(order, byID); cycle != nil {
		return nil, &CycleError{Path: cycle}
	}

	// 拓扑分层（Kahn），同层规则相互独立。
	indeg := make(map[string]int, len(order))
	for _, n := range order {
		indeg[n.rule.ID] = len(n.rule.DependsOn)
	}
	dependents := make(map[string][]string, len(order))
	for _, n := range order {
		for _, dep := range n.rule.DependsOn {
			dependents[dep] = append(dependents[dep], n.rule.ID)
		}
	}

	var batches [][]*node
	current := make([]*node, 0)
	for _, n := range order { // 按声明顺序入层，保证确定性
		if indeg[n.rule.ID] == 0 {
			current = append(current, n)
		}
	}
	for len(current) > 0 {
		batches = append(batches, current)
		var next []*node
		for _, n := range current {
			for _, id := range dependents[n.rule.ID] {
				indeg[id]--
				if indeg[id] == 0 {
					next = append(next, byID[id])
				}
			}
		}
		current = next
	}

	return &Plan{batches: batches, order: order}, nil
}

// reachable 报告从 from 出发沿依赖边能否到达 target。
func reachable(byID map[string]*node, from, target string) bool {
	visited := map[string]bool{from: true}
	stack := []string{from}
	for len(stack) > 0 {
		cur := stack[len(stack)-1]
		stack = stack[:len(stack)-1]
		for _, dep := range byID[cur].rule.DependsOn {
			if dep == target {
				return true
			}
			if !visited[dep] {
				visited[dep] = true
				stack = append(stack, dep)
			}
		}
	}
	return false
}

// shortestCycle 用 BFS 求有向图的最小环，返回 nil 表示无环。
// 返回路径首尾相同，如 [a b a]。
func shortestCycle(order []*node, byID map[string]*node) []string {
	var best []string
	for _, start := range order {
		sid := start.rule.ID
		prev := map[string]string{}
		dist := map[string]int{sid: 0}
		queue := []string{sid}
		for len(queue) > 0 {
			cur := queue[0]
			queue = queue[1:]
			if best != nil && dist[cur]+1 >= len(best)-1 {
				continue // 不可能得到更短的环
			}
			for _, next := range byID[cur].rule.DependsOn {
				if next == sid {
					// 找到环，边数为 dist[cur]+1；best 的边数为 len(best)-1。
					if best == nil || dist[cur]+1 < len(best)-1 {
						var rev []string
						for x := cur; x != sid; x = prev[x] {
							rev = append(rev, x)
						}
						path := []string{sid}
						for i := len(rev) - 1; i >= 0; i-- {
							path = append(path, rev[i])
						}
						best = append(path, sid)
					}
					continue
				}
				if _, ok := dist[next]; !ok {
					dist[next] = dist[cur] + 1
					prev[next] = cur
					queue = append(queue, next)
				}
			}
		}
	}
	return best
}
