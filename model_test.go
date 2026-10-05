package resultdb

import (
	"fmt"
	"math/rand"
	"reflect"
	"sort"
	"testing"
)

// 全历史规则模型：独立于 Store 实现的参考模型。
// 输入为完整操作集，输出与 Store 快照同构的结果，用于对照乱序导入。

type modelSnapshot struct {
	history   []HistoryEntry
	decisions []Decision
	summary   []SourceStat
}

func runModel(runs []Run, baselines []Baseline, revoked [][2]interface{}) modelSnapshot {
	// 同（用例, 轮次）组：最小 Seq 定结果，相左者拒绝。
	type key struct {
		caseID string
		round  uint64
	}
	groups := map[key][]Run{}
	for _, r := range runs {
		k := key{r.Case, r.Round}
		groups[k] = append(groups[k], r)
	}
	status := map[uint64]RunStatus{} // by seq
	for _, g := range groups {
		winner := g[0]
		for _, r := range g[1:] {
			if r.Seq < winner.Seq {
				winner = r
			}
		}
		for _, r := range g {
			if r.Outcome == winner.Outcome {
				status[r.Seq] = Accepted
			} else {
				status[r.Seq] = RejectedConflict
			}
		}
	}

	hist := make([]HistoryEntry, 0, len(runs))
	for _, r := range runs {
		hist = append(hist, HistoryEntry{Run: r, Status: status[r.Seq]})
	}
	sort.Slice(hist, func(i, j int) bool {
		a, b := hist[i].Run, hist[j].Run
		if a.Case != b.Case {
			return a.Case < b.Case
		}
		if a.Round != b.Round {
			return a.Round < b.Round
		}
		return a.Seq < b.Seq
	})

	revokedSet := map[key]bool{}
	for _, rv := range revoked {
		revokedSet[key{rv[0].(string), rv[1].(uint64)}] = true
	}

	caseSet := map[string]bool{}
	for _, r := range runs {
		caseSet[r.Case] = true
	}
	for _, b := range baselines {
		caseSet[b.Case] = true
	}
	var cases []string
	for c := range caseSet {
		cases = append(cases, c)
	}
	sort.Strings(cases)

	var decisions []Decision
	for _, c := range cases {
		d := Decision{Case: c, Kind: Undecided}
		have := false
		var bestRound uint64
		var bestOutcome Outcome
		for _, r := range runs {
			if r.Case != c || status[r.Seq] != Accepted {
				continue
			}
			if !have || r.Round > bestRound {
				bestRound, bestOutcome, have = r.Round, r.Outcome, true
			}
		}
		if have {
			d.Round, d.Actual = bestRound, bestOutcome
			// 公开最新有效基线。
			byRound := map[uint64]Baseline{}
			for _, b := range baselines {
				if b.Case != c || !b.Public || revokedSet[key{b.Case, b.Round}] {
					continue
				}
				if cur, ok := byRound[b.Round]; !ok || b.Seq > cur.Seq {
					byRound[b.Round] = b
				}
			}
			var best *Baseline
			for _, b := range byRound {
				if best == nil || b.Round > best.Round {
					cp := b
					best = &cp
				}
			}
			if best == nil {
				d.Kind = NoBaseline
			} else {
				d.Baseline = best
				if best.Expected == bestOutcome {
					d.Kind = Match
				} else {
					d.Kind = Mismatch
				}
			}
		}
		decisions = append(decisions, d)
	}

	bySource := map[string]*SourceStat{}
	var sources []string
	for _, r := range runs {
		st, ok := bySource[r.Source]
		if !ok {
			st = &SourceStat{Source: r.Source}
			bySource[r.Source] = st
			sources = append(sources, r.Source)
		}
		st.Total++
		if status[r.Seq] == Accepted {
			st.Accepted++
		} else {
			st.Rejected++
		}
		if r.Outcome == Pass {
			st.Pass++
		} else {
			st.Fail++
		}
	}
	sort.Strings(sources)
	var summary []SourceStat
	for _, src := range sources {
		summary = append(summary, *bySource[src])
	}

	return modelSnapshot{history: hist, decisions: decisions, summary: summary}
}

type op struct {
	run      *Run
	baseline *Baseline
	revoke   *[2]interface{}
}

// 乱序导入与全历史规则模型对照：随机操作集以随机顺序导入 Store，
// 最终快照必须与模型及顺序导入的 Store 完全一致。
func TestOutOfOrderImportMatchesFullHistoryModel(t *testing.T) {
	for seed := int64(0); seed < 200; seed++ {
		rng := rand.New(rand.NewSource(seed))
		cases := []string{"alpha", "beta", "gamma", "delta"}
		sources := []string{"ci", "nightly", "manual"}

		var ops []op
		seq := uint64(1)
		nextSeq := func() uint64 { s := seq; seq++; return s }
		n := 20 + rng.Intn(40)
		for i := 0; i < n; i++ {
			switch rng.Intn(4) {
			case 0, 1: // run
				r := Run{
					Case:    cases[rng.Intn(len(cases))],
					Round:   uint64(rng.Intn(6)),
					Outcome: Outcome(rng.Intn(2)),
					Source:  sources[rng.Intn(len(sources))],
					Seq:     nextSeq(),
				}
				ops = append(ops, op{run: &r})
			case 2: // baseline
				b := Baseline{
					Case:     cases[rng.Intn(len(cases))],
					Round:    uint64(rng.Intn(6)),
					Expected: Outcome(rng.Intn(2)),
					Public:   rng.Intn(4) != 0, // 75% 公开
					Seq:      nextSeq(),
				}
				ops = append(ops, op{baseline: &b})
			case 3: // revoke
				rv := [2]interface{}{cases[rng.Intn(len(cases))], uint64(rng.Intn(6))}
				ops = append(ops, op{revoke: &rv})
			}
		}

		apply := func(s *Store, ops []op) {
			for _, o := range ops {
				switch {
				case o.run != nil:
					s.ImportRun(*o.run) // 冲突拒绝属预期，错误不影响最终快照
				case o.baseline != nil:
					s.ImportBaseline(*o.baseline)
				case o.revoke != nil:
					s.RevokeBaseline(o.revoke[0].(string), o.revoke[1].(uint64))
				}
			}
		}

		// 乱序导入。
		shuffled := make([]op, len(ops))
		copy(shuffled, ops)
		rng.Shuffle(len(shuffled), func(i, j int) { shuffled[i], shuffled[j] = shuffled[j], shuffled[i] })
		got := NewStore()
		apply(got, shuffled)

		// 顺序导入（按 Seq 升序）作为第二对照。
		ordered := make([]op, len(ops))
		copy(ordered, ops)
		sort.SliceStable(ordered, func(i, j int) bool {
			seqOf := func(o op) uint64 {
				if o.run != nil {
					return o.run.Seq
				}
				if o.baseline != nil {
					return o.baseline.Seq
				}
				return ^uint64(0) // revoke 无 Seq，排最后
			}
			return seqOf(ordered[i]) < seqOf(ordered[j])
		})
		want := NewStore()
		apply(want, ordered)

		// 模型输入。
		var runs []Run
		var baselines []Baseline
		var revoked [][2]interface{}
		for _, o := range ops {
			switch {
			case o.run != nil:
				runs = append(runs, *o.run)
			case o.baseline != nil:
				baselines = append(baselines, *o.baseline)
			case o.revoke != nil:
				revoked = append(revoked, *o.revoke)
			}
		}
		model := runModel(runs, baselines, revoked)

		check := func(name string, s *Store) {
			t.Helper()
			if !reflect.DeepEqual(s.History(), model.history) {
				t.Fatalf("seed %d %s: history mismatch\ngot:  %+v\nwant: %+v", seed, name, s.History(), model.history)
			}
			if !reflect.DeepEqual(s.Decisions(), model.decisions) {
				t.Fatalf("seed %d %s: decisions mismatch\ngot:  %+v\nwant: %+v", seed, name, s.Decisions(), model.decisions)
			}
			if !reflect.DeepEqual(s.SourceSummary(), model.summary) {
				t.Fatalf("seed %d %s: summary mismatch\ngot:  %+v\nwant: %+v", seed, name, s.SourceSummary(), model.summary)
			}
			var wantMM []Decision
			for _, d := range model.decisions {
				if d.Kind == Mismatch {
					wantMM = append(wantMM, d)
				}
			}
			if !reflect.DeepEqual(s.Mismatches(), wantMM) {
				t.Fatalf("seed %d %s: mismatches mismatch\ngot:  %+v\nwant: %+v", seed, name, s.Mismatches(), wantMM)
			}
		}
		check("shuffled", got)
		check("ordered", want)

		if !reflect.DeepEqual(got.History(), want.History()) {
			t.Fatalf("seed %d: shuffled vs ordered history differ", seed)
		}
	}
}

// 模型自身的健全性示例：固定场景核对一次，防止模型与实现共同出错。
func TestModelSanity(t *testing.T) {
	runs := []Run{
		{Case: "a", Round: 1, Outcome: Pass, Source: "ci", Seq: 1},
		{Case: "a", Round: 1, Outcome: Fail, Source: "ci", Seq: 2}, // 冲突被拒
		{Case: "a", Round: 2, Outcome: Fail, Source: "ci", Seq: 3},
	}
	baselines := []Baseline{{Case: "a", Round: 1, Expected: Pass, Public: true, Seq: 4}}
	snap := runModel(runs, baselines, nil)
	if snap.history[1].Status != RejectedConflict {
		t.Fatalf("model history = %+v", snap.history)
	}
	d := snap.decisions[0]
	if d.Kind != Mismatch || d.Round != 2 || d.Actual != Fail {
		t.Fatalf("model decision = %+v, want Mismatch round 2 fail", d)
	}
	if fmt.Sprint(snap.summary[0]) == "" {
		t.Fatal("empty summary")
	}
}
