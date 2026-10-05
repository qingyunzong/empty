package resultstore

import (
	"errors"
	"reflect"
	"testing"
	"time"
)

var t0 = time.Date(2026, 10, 5, 10, 0, 0, 0, time.UTC)

func run(caseID string, round int, outcome Outcome, source string, min int) Run {
	return Run{CaseID: caseID, Round: round, Outcome: outcome, Source: source, At: t0.Add(time.Duration(min) * time.Minute)}
}

// 同用例多次实际运行不可只选成功: every actual run is kept, including
// failures and skips; the store never filters to successes only.
func TestAllRunsKeptNotOnlySuccesses(t *testing.T) {
	var s Store
	runs := []Run{
		run("case-a", 1, OutcomeFail, "ci", 0),
		run("case-a", 2, OutcomePass, "ci", 1),
		run("case-a", 3, OutcomeSkip, "ci", 2),
		run("case-a", 4, OutcomeFail, "nightly", 3),
		run("case-a", 5, OutcomePass, "nightly", 4),
	}
	for _, r := range runs {
		if err := s.AddRun(r); err != nil {
			t.Fatalf("AddRun(%+v): %v", r, err)
		}
	}
	if got := s.RunCount(); got != len(runs) {
		t.Fatalf("RunCount = %d, want %d (all outcomes must be stored)", got, len(runs))
	}
	hist := s.History()
	counts := map[Outcome]int{}
	for _, h := range hist {
		counts[h.Outcome]++
	}
	if counts[OutcomeFail] != 2 || counts[OutcomeSkip] != 1 || counts[OutcomePass] != 2 {
		t.Fatalf("history outcome counts = %v, want fail=2 skip=1 pass=2", counts)
	}
	if o, ok := s.LatestOutcome("case-a"); !ok || o != OutcomePass {
		t.Fatalf("LatestOutcome = %q,%v want pass,true (highest round wins)", o, ok)
	}
}

// 同轮冲突拒绝: a different outcome for the same case+round is rejected,
// whichever order the conflicting runs arrive in.
func TestSameRoundConflictRejected(t *testing.T) {
	for _, tc := range []struct {
		name       string
		first      Outcome
		second     Outcome
		wantKept   Outcome
		wantReject bool
	}{
		{"pass then fail", OutcomePass, OutcomeFail, OutcomePass, true},
		{"fail then pass", OutcomeFail, OutcomePass, OutcomeFail, true},
		{"identical duplicate", OutcomePass, OutcomePass, OutcomePass, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			var s Store
			if err := s.AddRun(run("case-a", 1, tc.first, "ci", 0)); err != nil {
				t.Fatalf("first AddRun: %v", err)
			}
			err := s.AddRun(run("case-a", 1, tc.second, "nightly", 1))
			if tc.wantReject {
				if !IsConflict(err) {
					t.Fatalf("second AddRun err = %v, want ConflictError", err)
				}
				var ce *ConflictError
				if !errors.As(err, &ce) || ce.CaseID != "case-a" || ce.Round != 1 {
					t.Fatalf("conflict detail = %+v", ce)
				}
				if s.RunCount() != 1 {
					t.Fatalf("RunCount = %d, want 1 (conflict rejected)", s.RunCount())
				}
			} else if err != nil {
				t.Fatalf("identical duplicate must be idempotent, got %v", err)
			}
			if o, _ := s.LatestOutcome("case-a"); o != tc.wantKept {
				t.Fatalf("kept outcome = %q, want %q", o, tc.wantKept)
			}
		})
	}
}

// 按公开最新有效基线决策: only the latest published AND valid baseline
// drives decisions; unpublished or invalid baselines are ignored.
func TestDecisionUsesLatestPublishedValidBaseline(t *testing.T) {
	var s Store
	for _, r := range []Run{
		run("case-a", 1, OutcomePass, "ci", 0),
		run("case-b", 1, OutcomeFail, "ci", 1),
	} {
		if err := s.AddRun(r); err != nil {
			t.Fatal(err)
		}
	}
	baselines := []Baseline{
		{Version: 1, Published: true, Valid: true, Expect: map[string]Outcome{"case-a": OutcomePass, "case-b": OutcomePass}},
		{Version: 2, Published: false, Valid: true, Expect: map[string]Outcome{"case-a": OutcomeFail}}, // not public
		{Version: 3, Published: true, Valid: false, Expect: map[string]Outcome{"case-a": OutcomeFail}}, // invalid
		{Version: 4, Published: true, Valid: true, Expect: map[string]Outcome{"case-a": OutcomePass, "case-b": OutcomeFail}},
	}
	for _, b := range baselines {
		if err := s.AddBaseline(b); err != nil {
			t.Fatal(err)
		}
	}
	eb, ok := s.EffectiveBaseline()
	if !ok || eb.Version != 4 {
		t.Fatalf("EffectiveBaseline version = %d,%v want 4,true", eb.Version, ok)
	}
	d, ok := s.Decide()
	if !ok {
		t.Fatal("Decide: no effective baseline")
	}
	if d.BaselineVersion != 4 {
		t.Fatalf("Decision baseline = %d, want 4", d.BaselineVersion)
	}
	if len(d.Mismatched) != 0 || len(d.Matched) != 2 {
		t.Fatalf("decision = %+v, want both matched under v4", d)
	}
	// Full baseline history is retained.
	if got := len(s.Baselines()); got != 4 {
		t.Fatalf("baseline history len = %d, want 4", got)
	}
}

// 基线不匹配单列: mismatches are listed separately from matches, missing
// and extra cases.
func TestBaselineMismatchListedSeparately(t *testing.T) {
	var s Store
	for _, r := range []Run{
		run("match-1", 1, OutcomePass, "ci", 0),
		run("mismatch-1", 1, OutcomeFail, "ci", 1),
		run("mismatch-2", 1, OutcomePass, "ci", 2),
		run("extra-1", 1, OutcomePass, "ci", 3),
	} {
		if err := s.AddRun(r); err != nil {
			t.Fatal(err)
		}
	}
	if err := s.AddBaseline(Baseline{Version: 1, Published: true, Valid: true, Expect: map[string]Outcome{
		"match-1":    OutcomePass,
		"mismatch-1": OutcomePass,
		"mismatch-2": OutcomeFail,
		"absent-1":   OutcomePass,
	}}); err != nil {
		t.Fatal(err)
	}
	d, ok := s.Decide()
	if !ok {
		t.Fatal("no effective baseline")
	}
	if !reflect.DeepEqual(d.Matched, []string{"match-1"}) {
		t.Fatalf("Matched = %v", d.Matched)
	}
	wantMis := []CaseMismatch{
		{CaseID: "mismatch-1", Expected: OutcomePass, Actual: OutcomeFail},
		{CaseID: "mismatch-2", Expected: OutcomeFail, Actual: OutcomePass},
	}
	if !reflect.DeepEqual(d.Mismatched, wantMis) {
		t.Fatalf("Mismatched = %+v, want %+v", d.Mismatched, wantMis)
	}
	if !reflect.DeepEqual(d.Missing, []string{"absent-1"}) {
		t.Fatalf("Missing = %v", d.Missing)
	}
	if !reflect.DeepEqual(d.Extra, []string{"extra-1"}) {
		t.Fatalf("Extra = %v", d.Extra)
	}
}

// Decide without any published+valid baseline reports no decision.
func TestDecideWithoutEffectiveBaseline(t *testing.T) {
	var s Store
	if err := s.AddBaseline(Baseline{Version: 1, Published: false, Valid: true, Expect: map[string]Outcome{}}); err != nil {
		t.Fatal(err)
	}
	if _, ok := s.Decide(); ok {
		t.Fatal("Decide ok with no published+valid baseline")
	}
}

// 记录来源摘要和完整历史: per-source aggregation over the full history.
func TestSourceSummaryAndFullHistory(t *testing.T) {
	var s Store
	for _, r := range []Run{
		run("case-a", 1, OutcomePass, "ci", 0),
		run("case-a", 2, OutcomeFail, "ci", 1),
		run("case-b", 1, OutcomeSkip, "nightly", 2),
		run("case-b", 2, OutcomePass, "nightly", 3),
		run("case-b", 3, OutcomeFail, "nightly", 4),
	} {
		if err := s.AddRun(r); err != nil {
			t.Fatal(err)
		}
	}
	got := s.SourceSummary()
	want := []SourceStat{
		{Source: "ci", Total: 2, Pass: 1, Fail: 1, Skip: 0, Rounds: []int{1, 2}},
		{Source: "nightly", Total: 3, Pass: 1, Fail: 1, Skip: 1, Rounds: []int{1, 2, 3}},
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("SourceSummary = %+v, want %+v", got, want)
	}
	if len(s.History()) != 5 {
		t.Fatalf("history len = %d, want 5", len(s.History()))
	}
	// Mutating the returned history must not affect the store.
	h := s.History()
	h[0].Outcome = OutcomeSkip
	if s.History()[0].Outcome != OutcomePass {
		t.Fatal("History must return a copy")
	}
}

// 乱序导入与全历史规则模型对照: every permutation of a conflict-free run
// set converges to the same state as the canonical full-history model.
func TestOutOfOrderImportMatchesFullHistoryModel(t *testing.T) {
	runs := []Run{
		run("case-a", 1, OutcomeFail, "ci", 0),
		run("case-a", 2, OutcomePass, "ci", 1),
		run("case-b", 1, OutcomeSkip, "nightly", 2),
		run("case-b", 2, OutcomeFail, "nightly", 3),
		run("case-c", 1, OutcomePass, "ci", 4),
		run("case-c", 3, OutcomePass, "manual", 5),
	}
	model, err := Replay(runs)
	if err != nil {
		t.Fatalf("Replay: %v", err)
	}
	wantDecision, ok := model.Decide()
	if ok {
		t.Fatal("model without baselines must not decide")
	}
	if err := model.AddBaseline(Baseline{Version: 1, Published: true, Valid: true, Expect: map[string]Outcome{
		"case-a": OutcomePass, "case-b": OutcomeFail, "case-c": OutcomePass,
	}}); err != nil {
		t.Fatal(err)
	}
	wantDecision, _ = model.Decide()
	wantSummary := model.SourceSummary()

	perm := make([]int, len(runs))
	for i := range perm {
		perm[i] = i
	}
	n := 0
	var permute func(k int)
	permute = func(k int) {
		if k == len(perm) {
			n++
			var s Store
			for _, i := range perm {
				if err := s.AddRun(runs[i]); err != nil {
					t.Fatalf("permutation %v: AddRun: %v", perm, err)
				}
			}
			if !s.ConsistentWithModel() {
				t.Fatalf("permutation %v: inconsistent with full-history model", perm)
			}
			if err := s.AddBaseline(model.Baselines()[0]); err != nil {
				t.Fatal(err)
			}
			d, _ := s.Decide()
			if !reflect.DeepEqual(d, wantDecision) {
				t.Fatalf("permutation %v: decision = %+v, want %+v", perm, d, wantDecision)
			}
			if !reflect.DeepEqual(s.SourceSummary(), wantSummary) {
				t.Fatalf("permutation %v: source summary mismatch", perm)
			}
			return
		}
		for i := k; i < len(perm); i++ {
			perm[k], perm[i] = perm[i], perm[k]
			permute(k + 1)
			perm[k], perm[i] = perm[i], perm[k]
		}
	}
	permute(0)
	if n != 720 {
		t.Fatalf("checked %d permutations, want 720", n)
	}
}

// Conflicting runs are rejected during replay too, and the store remains
// consistent with the model over the accepted history.
func TestModelRejectsConflict(t *testing.T) {
	runs := []Run{
		run("case-a", 1, OutcomePass, "ci", 0),
		run("case-a", 1, OutcomeFail, "nightly", 1),
	}
	if _, err := Replay(runs); !IsConflict(err) {
		t.Fatalf("Replay err = %v, want ConflictError", err)
	}
	var s Store
	if err := s.AddRun(runs[0]); err != nil {
		t.Fatal(err)
	}
	if err := s.AddRun(runs[1]); !IsConflict(err) {
		t.Fatalf("AddRun err = %v, want ConflictError", err)
	}
	if !s.ConsistentWithModel() {
		t.Fatal("store after rejected conflict must still match the model of its accepted history")
	}
}

// Invalid input is rejected with ValidationError.
func TestValidation(t *testing.T) {
	var s Store
	cases := []Run{
		{CaseID: "", Round: 1, Outcome: OutcomePass, Source: "ci"},
		{CaseID: "case-a", Round: 1, Outcome: OutcomePass, Source: ""},
		{CaseID: "case-a", Round: 1, Outcome: Outcome("bogus"), Source: "ci"},
	}
	for i, r := range cases {
		var ve *ValidationError
		if err := s.AddRun(r); !errors.As(err, &ve) {
			t.Fatalf("case %d: err = %v, want ValidationError", i, err)
		}
	}
	var ve *ValidationError
	if err := s.AddBaseline(Baseline{Version: 1}); !errors.As(err, &ve) {
		t.Fatalf("nil expectations: want ValidationError")
	}
	if err := s.AddBaseline(Baseline{Version: 1, Expect: map[string]Outcome{"x": "bogus"}}); !errors.As(err, &ve) {
		t.Fatalf("invalid baseline outcome: want ValidationError")
	}
	if s.RunCount() != 0 {
		t.Fatalf("invalid runs must not be stored, RunCount = %d", s.RunCount())
	}
}
