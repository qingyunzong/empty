package statlabels

import (
	"fmt"
	"sort"
)

// Stats 在标签树上记录事件并提供去重汇总。
type Stats struct {
	tree   *Tree
	labels map[string]map[string]struct{} // eventID -> 原始标签集合
	order  []string                       // 事件加入顺序，保证输出稳定
}

// NewStats 基于给定标签树创建统计器。树被后续修改（如删边）时，
// 统计结果随树的当前结构变化，事件标签本身保持不变。
func NewStats(t *Tree) *Stats {
	return &Stats{tree: t, labels: make(map[string]map[string]struct{})}
}

// AddEvent 记录一条事件及其标签。同一事件重复调用会合并标签。
// 标签必须是树中已存在的节点。
func (s *Stats) AddEvent(id string, labels ...string) error {
	set, ok := s.labels[id]
	if !ok {
		set = make(map[string]struct{})
		s.labels[id] = set
		s.order = append(s.order, id)
	}
	for _, l := range labels {
		if !s.tree.Has(l) {
			return fmt.Errorf("statlabels: unknown label %q", l)
		}
		set[l] = struct{}{}
	}
	return nil
}

// Labels 返回事件的原始标签集合（排序后），不受删边影响。
func (s *Stats) Labels(eventID string) []string {
	return sorted(s.labels[eventID])
}

// Contribution 是一条事件对某次祖先汇总的贡献证据。
type Contribution struct {
	EventID       string   // 贡献事件的 ID
	MatchedLabels []string // 该事件落在被汇总子树内的标签（排序后）
}

// Contributions 返回 node 子树汇总的事件贡献证据：每条命中事件
// 恰好出现一次（每事件只计一次），并列出其命中子树的标签。
// 结果按事件加入顺序排列。
func (s *Stats) Contributions(node string) []Contribution {
	if !s.tree.Has(node) {
		return nil
	}
	sub := s.tree.Descendants(node)
	var out []Contribution
	for _, id := range s.order {
		var matched []string
		for l := range s.labels[id] {
			if _, ok := sub[l]; ok {
				matched = append(matched, l)
			}
		}
		if len(matched) > 0 {
			sort.Strings(matched)
			out = append(out, Contribution{EventID: id, MatchedLabels: matched})
		}
	}
	return out
}

// Count 返回 node 子树汇总的去重事件数：一条事件无论命中多少
// 个标签，只计一次。
func (s *Stats) Count(node string) int {
	return len(s.Contributions(node))
}

// Verify 用独立的“逐事件可达性重算”路径核对 Count 与 Contributions：
// 对每条事件、每个标签沿父指针向上爬，检查 node 是否可达，
// 结果必须与基于子树集合的主计算路径完全一致。适用于小树核对。
func (s *Stats) Verify(node string) error {
	if !s.tree.Has(node) {
		return fmt.Errorf("statlabels: unknown node %q", node)
	}
	main := s.Contributions(node)
	var recalc []Contribution
	for _, id := range s.order {
		var matched []string
		for l := range s.labels[id] {
			if s.tree.IsAncestor(node, l) {
				matched = append(matched, l)
			}
		}
		if len(matched) > 0 {
			sort.Strings(matched)
			recalc = append(recalc, Contribution{EventID: id, MatchedLabels: matched})
		}
	}
	if len(main) != len(recalc) {
		return fmt.Errorf("statlabels: count mismatch at %q: subtree=%d reachability=%d",
			node, len(main), len(recalc))
	}
	for i := range main {
		if main[i].EventID != recalc[i].EventID {
			return fmt.Errorf("statlabels: event mismatch at %q[%d]: %q vs %q",
				node, i, main[i].EventID, recalc[i].EventID)
		}
		if !equalStrings(main[i].MatchedLabels, recalc[i].MatchedLabels) {
			return fmt.Errorf("statlabels: evidence mismatch at %q event %q: %v vs %v",
				node, main[i].EventID, main[i].MatchedLabels, recalc[i].MatchedLabels)
		}
	}
	return nil
}

func sorted(set map[string]struct{}) []string {
	out := make([]string, 0, len(set))
	for k := range set {
		out = append(out, k)
	}
	sort.Strings(out)
	return out
}

func equalStrings(a, b []string) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i] != b[i] {
			return false
		}
	}
	return true
}
