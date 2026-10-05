package seqquery_test

import (
	"math"
	"math/rand"
	"reflect"
	"sort"
	"testing"

	"seqquery"
)

func addAll(l *seqquery.Library, evs ...seqquery.Event) {
	for _, e := range evs {
		l.Add(e)
	}
}

func resultIDs(r *seqquery.Result) []int64 {
	var ids []int64
	for _, e := range r.Events {
		ids = append(ids, e.ID)
	}
	return ids
}

// bruteForce 是独立编写的全区间枚举验收器：不调用库内任何未导出逻辑，
// 逐区间完整重查全部约束，用于小规模核对。
func bruteForce(events []seqquery.Event, q seqquery.Query) (profit int64, ids []int64) {
	evs := append([]seqquery.Event(nil), events...)
	sort.Slice(evs, func(i, j int) bool {
		if evs[i].Time != evs[j].Time {
			return evs[i].Time < evs[j].Time
		}
		return evs[i].ID < evs[j].ID
	})
	limit := q.MaxEvents
	if limit <= 0 || limit > 30 {
		limit = 30
	}
	type cand struct {
		profit int64
		ids    []int64
		start  int64
	}
	best := cand{profit: 0, start: math.MaxInt64} // 空段
	better := func(a, b cand) bool {
		if a.profit != b.profit {
			return a.profit > b.profit
		}
		if len(a.ids) != len(b.ids) {
			return len(a.ids) < len(b.ids)
		}
		if a.start != b.start {
			return a.start < b.start
		}
		for i := range a.ids {
			if a.ids[i] != b.ids[i] {
				return a.ids[i] < b.ids[i]
			}
		}
		return false
	}
	for i := range evs {
		for j := i; j < len(evs); j++ {
			seg := evs[i : j+1]
			if len(seg) > limit || evs[j].Time-evs[i].Time > q.MaxSpan {
				break
			}
			stock := q.InitStock
			ok := true
			sources := map[string]bool{}
			types := map[string]bool{}
			var cost int64
			for _, e := range seg {
				if sources[e.Source] {
					ok = false
					break
				}
				sources[e.Source] = true
				stock += e.Stock
				if stock < 0 {
					ok = false
					break
				}
				types[e.Type] = true
				cost += e.Cost
			}
			if !ok || len(types) < q.MinTypes {
				continue
			}
			c := cand{profit: -cost, start: evs[i].Time}
			for _, e := range seg {
				c.ids = append(c.ids, e.ID)
			}
			if better(c, best) {
				best = c
			}
		}
	}
	return best.profit, best.ids
}

func TestEmptySegmentWhenNoProfit(t *testing.T) {
	l := seqquery.New()
	addAll(l,
		seqquery.Event{ID: 1, Time: 0, Type: "a", Source: "s1", Cost: 5},
		seqquery.Event{ID: 2, Time: 1, Type: "b", Source: "s2", Cost: 3},
	)
	r := l.Best(seqquery.Query{MaxSpan: 10})
	if !r.Empty() || r.Profit != 0 {
		t.Fatalf("期望空段收益 0，得到 profit=%d ids=%v", r.Profit, resultIDs(r))
	}
	if len(r.PrefixStock) != 0 || len(r.Coverage) != 0 {
		t.Fatalf("空段证书应为空，得到 stock=%v coverage=%v", r.PrefixStock, r.Coverage)
	}
}

func TestUnsortedInputSorted(t *testing.T) {
	l := seqquery.New()
	// 乱序录入，查询前应按 (Time, ID) 排序
	addAll(l,
		seqquery.Event{ID: 3, Time: 20, Type: "a", Source: "s3", Cost: -1},
		seqquery.Event{ID: 1, Time: 0, Type: "a", Source: "s1", Cost: -2},
		seqquery.Event{ID: 2, Time: 10, Type: "a", Source: "s2", Cost: -4},
	)
	r := l.Best(seqquery.Query{MaxSpan: 100})
	if got, want := resultIDs(r), []int64{1, 2, 3}; !reflect.DeepEqual(got, want) {
		t.Fatalf("ids=%v, want %v", got, want)
	}
	if r.Profit != 7 {
		t.Fatalf("profit=%d, want 7", r.Profit)
	}
}

func TestTieBreakShorterThenEarlierThenIDs(t *testing.T) {
	// 收益并列时先段短：[1] 与 [1,2] 收益同为 3，短段优先。
	l := seqquery.New()
	addAll(l,
		seqquery.Event{ID: 1, Time: 0, Type: "a", Source: "s1", Cost: -3},
		seqquery.Event{ID: 2, Time: 1, Type: "a", Source: "s2", Cost: 0},
	)
	r := l.Best(seqquery.Query{MaxSpan: 2})
	if got, want := resultIDs(r), []int64{1}; !reflect.DeepEqual(got, want) {
		t.Fatalf("ids=%v, want %v（段短优先）", got, want)
	}

	// 段长相同时开始早优先。
	l1 := seqquery.New()
	addAll(l1,
		seqquery.Event{ID: 5, Time: 5, Type: "a", Source: "s3", Cost: -3},
		seqquery.Event{ID: 7, Time: 9, Type: "a", Source: "s4", Cost: -3},
	)
	r1 := l1.Best(seqquery.Query{MaxSpan: 2})
	if got, want := resultIDs(r1), []int64{5}; !reflect.DeepEqual(got, want) {
		t.Fatalf("ids=%v, want %v（开始早优先）", got, want)
	}

	// 同开始时间、同收益、同长度（段长限 1）：ID 序小优先。
	l2 := seqquery.New()
	addAll(l2,
		seqquery.Event{ID: 4, Time: 0, Type: "a", Source: "s1", Cost: -2},
		seqquery.Event{ID: 2, Time: 0, Type: "a", Source: "s2", Cost: -2},
		seqquery.Event{ID: 6, Time: 0, Type: "a", Source: "s3", Cost: 1},
	)
	r2 := l2.Best(seqquery.Query{MaxSpan: 0, MaxEvents: 1})
	if got, want := resultIDs(r2), []int64{2}; !reflect.DeepEqual(got, want) {
		t.Fatalf("ids=%v, want %v（ID 序小优先）", got, want)
	}
}

func TestMinTypesConstraint(t *testing.T) {
	l := seqquery.New()
	addAll(l,
		seqquery.Event{ID: 1, Time: 0, Type: "a", Source: "s1", Cost: -10},
		seqquery.Event{ID: 2, Time: 1, Type: "a", Source: "s2", Cost: -10},
		seqquery.Event{ID: 3, Time: 2, Type: "b", Source: "s3", Cost: 15},
	)
	// k=2 时最优为 [1,2,3]（收益 5），不能选 [1,2]（收益 20 但只覆盖 1 类）
	r := l.Best(seqquery.Query{MaxSpan: 10, MinTypes: 2})
	if got, want := resultIDs(r), []int64{1, 2, 3}; !reflect.DeepEqual(got, want) {
		t.Fatalf("ids=%v, want %v", got, want)
	}
	if r.Profit != 5 {
		t.Fatalf("profit=%d, want 5", r.Profit)
	}
	if got := r.Types(); !reflect.DeepEqual(got, []string{"a", "b"}) {
		t.Fatalf("types=%v, want [a b]", got)
	}
}

func TestSourceMutualExclusion(t *testing.T) {
	l := seqquery.New()
	addAll(l,
		seqquery.Event{ID: 1, Time: 0, Type: "a", Source: "s1", Cost: -5},
		seqquery.Event{ID: 2, Time: 1, Type: "a", Source: "s1", Cost: -5}, // 与 s1 互斥，不能同段
		seqquery.Event{ID: 3, Time: 2, Type: "a", Source: "s2", Cost: -4},
	)
	r := l.Best(seqquery.Query{MaxSpan: 10})
	// 含 1 和 3 的连续区间必含 2，而 1、2 来源互斥，故最优为 [2,3]（收益 9）。
	if got, want := resultIDs(r), []int64{2, 3}; !reflect.DeepEqual(got, want) {
		t.Fatalf("ids=%v, want %v", got, want)
	}
}

func TestStockNeverNegative(t *testing.T) {
	l := seqquery.New()
	addAll(l,
		seqquery.Event{ID: 1, Time: 0, Type: "a", Source: "s1", Cost: -1, Stock: -2}, // 初始库存 1 时立即为负
		seqquery.Event{ID: 2, Time: 1, Type: "a", Source: "s2", Cost: -9, Stock: 5},
	)
	r := l.Best(seqquery.Query{MaxSpan: 10, InitStock: 1})
	if got, want := resultIDs(r), []int64{2}; !reflect.DeepEqual(got, want) {
		t.Fatalf("ids=%v, want %v（含负库存前缀的段不可行）", got, want)
	}
	if got, want := r.PrefixStock, []int64{6}; !reflect.DeepEqual(got, want) {
		t.Fatalf("prefixStock=%v, want %v", got, want)
	}
}

func TestPrefixStockAndCoverageCertificate(t *testing.T) {
	l := seqquery.New()
	addAll(l,
		seqquery.Event{ID: 1, Time: 0, Type: "b", Source: "s1", Cost: -2, Stock: 3},
		seqquery.Event{ID: 2, Time: 1, Type: "a", Source: "s2", Cost: -1, Stock: -1},
		seqquery.Event{ID: 3, Time: 2, Type: "b", Source: "s3", Cost: -1, Stock: -2},
	)
	r := l.Best(seqquery.Query{MaxSpan: 10, MinTypes: 2, InitStock: 2})
	if got, want := r.PrefixStock, []int64{5, 4, 2}; !reflect.DeepEqual(got, want) {
		t.Fatalf("prefixStock=%v, want %v", got, want)
	}
	wantCov := map[string]int{"a": 1, "b": 2}
	if !reflect.DeepEqual(r.Coverage, wantCov) {
		t.Fatalf("coverage=%v, want %v", r.Coverage, wantCov)
	}
	if r.Span() != 2 {
		t.Fatalf("span=%d, want 2", r.Span())
	}
}

func TestMaxEventsCappedAt30(t *testing.T) {
	l := seqquery.New()
	for i := 0; i < 40; i++ {
		l.Add(seqquery.Event{ID: int64(i), Time: int64(i), Type: "a", Source: string(rune('A' + i)), Cost: -1})
	}
	r := l.Best(seqquery.Query{MaxSpan: 1000, MaxEvents: 100}) // 上限被钳到 30
	if len(r.Events) != 30 {
		t.Fatalf("段长=%d, want 30", len(r.Events))
	}
	if r.Profit != 30 {
		t.Fatalf("profit=%d, want 30", r.Profit)
	}
}

func TestCorrectionRevokesOldResult(t *testing.T) {
	l := seqquery.New()
	addAll(l,
		seqquery.Event{ID: 1, Time: 0, Type: "a", Source: "s1", Cost: -5},
		seqquery.Event{ID: 2, Time: 1, Type: "a", Source: "s2", Cost: -1},
	)
	old := l.Best(seqquery.Query{MaxSpan: 10})
	if old.Revoked() {
		t.Fatal("新结果不应被作废")
	}
	l.Correct(seqquery.Event{ID: 2, Time: 1, Type: "a", Source: "s2", Cost: 10}) // 更正：收益变差
	if !old.Revoked() {
		t.Fatal("更正后旧结果应被作废")
	}
	fresh := l.Best(seqquery.Query{MaxSpan: 10})
	if fresh.Revoked() {
		t.Fatal("更正后的新结果不应被作废")
	}
	if got, want := resultIDs(fresh), []int64{1}; !reflect.DeepEqual(got, want) {
		t.Fatalf("ids=%v, want %v（更正后结果应更新）", got, want)
	}
}

func TestExhaustiveAgreementRandomized(t *testing.T) {
	rng := rand.New(rand.NewSource(20261006))
	for trial := 0; trial < 500; trial++ {
		n := rng.Intn(13) // 0..12 事件，小规模全区间枚举
		var evs []seqquery.Event
		for i := 0; i < n; i++ {
			evs = append(evs, seqquery.Event{
				ID:     int64(i),
				Time:   int64(rng.Intn(8)), // 允许时间重复
				Type:   string(rune('a' + rng.Intn(3))),
				Source: string(rune('x' + rng.Intn(4))), // 允许来源重复
				Cost:   int64(rng.Intn(11) - 5),         // 费用可负
				Stock:  int64(rng.Intn(7) - 3),
			})
		}
		q := seqquery.Query{
			MaxSpan:   int64(rng.Intn(8)),
			MinTypes:  rng.Intn(4),
			InitStock: int64(rng.Intn(4)),
			MaxEvents: rng.Intn(35),
		}
		l := seqquery.New()
		addAll(l, evs...)
		got := l.Best(q)
		wantProfit, wantIDs := bruteForce(evs, q)
		if got.Profit != wantProfit {
			t.Fatalf("trial %d: profit=%d, want %d\nevents=%+v\nquery=%+v", trial, got.Profit, wantProfit, evs, q)
		}
		if !reflect.DeepEqual(resultIDs(got), wantIDs) {
			t.Fatalf("trial %d: ids=%v, want %v\nevents=%+v\nquery=%+v", trial, resultIDs(got), wantIDs, evs, q)
		}
		// 证书自洽：逐前缀库存不为负，覆盖类型数满足 k
		if len(got.PrefixStock) != len(got.Events) {
			t.Fatalf("trial %d: 前缀库存长度 %d != 段长 %d", trial, len(got.PrefixStock), len(got.Events))
		}
		for _, s := range got.PrefixStock {
			if s < 0 {
				t.Fatalf("trial %d: 前缀库存为负 %v", trial, got.PrefixStock)
			}
		}
		if len(got.Coverage) < q.MinTypes && !got.Empty() {
			t.Fatalf("trial %d: 覆盖类型数 %d < k=%d", trial, len(got.Coverage), q.MinTypes)
		}
	}
}
