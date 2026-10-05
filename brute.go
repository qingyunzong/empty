package seqquery

import "fmt"

// BruteForce 独立地枚举全部区间并从头检查每条约束，返回最优结果。
// 它与 Library.Query 不共享可行性代码，用于小规模核对与验收。
// 输入允许乱序；version 仅原样写入结果。
func BruteForce(events []Event, q Query, version int) Result {
	sorted := sortEvents(events)
	best := candidate{} // 空段，收益 0
	n := len(sorted)
	for i := 0; i <= n; i++ {
		for j := i; j <= n; j++ {
			seg := sorted[i:j]
			if !feasible(seg, q) {
				continue
			}
			var profit int64
			for _, e := range seg {
				profit += e.Value
			}
			cand := candidate{i, j, profit}
			if better(sorted, cand, best) {
				best = cand
			}
		}
	}
	return buildResult(sorted, best, version)
}

// feasible 从头检查一个段是否满足全部约束。空段恒合法（收益 0 的兜底）。
func feasible(seg []Event, q Query) bool {
	if len(seg) == 0 {
		return true
	}
	if seg[len(seg)-1].Time-seg[0].Time > q.MaxSpan {
		return false
	}
	types := make(map[string]struct{})
	sources := make(map[string]struct{})
	var inv int64
	for _, e := range seg {
		if _, dup := sources[e.Source]; dup {
			return false
		}
		sources[e.Source] = struct{}{}
		types[e.Type] = struct{}{}
		inv += e.Inv
		if inv < 0 {
			return false
		}
	}
	return len(types) >= q.MinTypes
}

// CheckCertificate 独立验收结果 r：重排输入、定位段、复核全部约束、
// 逐前缀库存与覆盖证书。任何不一致都返回错误。
func CheckCertificate(events []Event, q Query, r Result) error {
	sorted := sortEvents(events)

	// 段必须是排序后序列的连续区间。
	start := -1
	if len(r.Events) == 0 {
		start = 0
	} else {
		for i := 0; i+len(r.Events) <= len(sorted); i++ {
			if eventsEqual(sorted[i:i+len(r.Events)], r.Events) {
				start = i
				break
			}
		}
		if start < 0 {
			return fmt.Errorf("result events are not a contiguous segment of the sorted input")
		}
	}

	if !feasible(r.Events, q) {
		return fmt.Errorf("segment violates query constraints")
	}

	// 复核收益与逐前缀库存。
	var profit, inv int64
	if len(r.PrefixInv) != len(r.Events) {
		return fmt.Errorf("prefix inventory length %d, want %d", len(r.PrefixInv), len(r.Events))
	}
	for i, e := range r.Events {
		inv += e.Inv
		profit += e.Value
		if r.PrefixInv[i] != inv {
			return fmt.Errorf("prefix inventory at %d = %d, want %d", i, r.PrefixInv[i], inv)
		}
		if inv < 0 {
			return fmt.Errorf("prefix inventory negative at %d", i)
		}
	}
	if r.Profit != profit {
		return fmt.Errorf("profit = %d, want %d", r.Profit, profit)
	}

	// 复核覆盖证书。
	want := make(map[string][]int)
	for _, e := range r.Events {
		want[e.Type] = append(want[e.Type], e.ID)
	}
	if len(r.Coverage) != len(want) {
		return fmt.Errorf("coverage has %d types, want %d", len(r.Coverage), len(want))
	}
	for typ, ids := range want {
		got := r.Coverage[typ]
		if len(got) != len(ids) {
			return fmt.Errorf("coverage[%q] has %d ids, want %d", typ, len(got), len(ids))
		}
		for i := range ids {
			if got[i] != ids[i] {
				return fmt.Errorf("coverage[%q][%d] = %d, want %d", typ, i, got[i], ids[i])
			}
		}
	}
	if len(r.Events) > 0 && len(want) < q.MinTypes {
		return fmt.Errorf("covers %d types, want at least %d", len(want), q.MinTypes)
	}
	return nil
}

func eventsEqual(a, b []Event) bool {
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
