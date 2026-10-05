package resultdb

import (
	"errors"
	"testing"
)

func mustImport(t *testing.T, s *Store, runs ...Run) {
	t.Helper()
	for _, r := range runs {
		if err := s.ImportRun(r); err != nil {
			t.Fatalf("ImportRun(%+v) = %v, want nil", r, err)
		}
	}
}

// 同用例多次实际运行不可只选成功：决策取最高轮次的结果，
// 即使历史中存在通过的运行。
func TestDecisionUsesLatestRoundNotAnyPass(t *testing.T) {
	s := NewStore()
	mustImport(t, s,
		Run{Case: "c1", Round: 1, Outcome: Pass, Source: "ci", Seq: 1},
		Run{Case: "c1", Round: 2, Outcome: Fail, Source: "ci", Seq: 2},
	)
	if err := s.ImportBaseline(Baseline{Case: "c1", Round: 1, Expected: Pass, Public: true, Seq: 3}); err != nil {
		t.Fatal(err)
	}
	d := s.Decide("c1")
	if d.Kind != Mismatch {
		t.Fatalf("Kind = %v, want Mismatch (latest round failed)", d.Kind)
	}
	if d.Round != 2 || d.Actual != Fail {
		t.Fatalf("decision taken from round %d outcome %v, want round 2 fail", d.Round, d.Actual)
	}
	mm := s.Mismatches()
	if len(mm) != 1 || mm[0].Case != "c1" {
		t.Fatalf("Mismatches() = %+v, want only c1", mm)
	}
}

// 同轮冲突拒绝：同（用例, 轮次）结果相左的导入被拒绝，
// 以最小 Seq 的运行定该轮结果，与导入顺序无关。
func TestSameRoundConflictRejected(t *testing.T) {
	s := NewStore()
	mustImport(t, s, Run{Case: "c1", Round: 1, Outcome: Pass, Source: "a", Seq: 1})
	err := s.ImportRun(Run{Case: "c1", Round: 1, Outcome: Fail, Source: "b", Seq: 2})
	if !errors.Is(err, ErrConflict) {
		t.Fatalf("ImportRun conflicting = %v, want ErrConflict", err)
	}
	// 被拒运行仍保留在完整历史中，状态为 RejectedConflict。
	h := s.History()
	if len(h) != 2 {
		t.Fatalf("len(History) = %d, want 2", len(h))
	}
	if h[0].Status != Accepted || h[1].Status != RejectedConflict {
		t.Fatalf("statuses = %v,%v, want accepted,rejected-conflict", h[0].Status, h[1].Status)
	}
	// 同轮同结果不冲突。
	mustImport(t, s, Run{Case: "c1", Round: 1, Outcome: Pass, Source: "b", Seq: 3})
}

// 低 Seq 冲突运行后到时，先前接受的运行被取代为拒绝。
func TestLowerSeqConflictDisplacesEarlierAccept(t *testing.T) {
	s := NewStore()
	mustImport(t, s, Run{Case: "c1", Round: 1, Outcome: Pass, Source: "a", Seq: 5})
	err := s.ImportRun(Run{Case: "c1", Round: 1, Outcome: Fail, Source: "a", Seq: 2})
	if err != nil {
		t.Fatalf("ImportRun lower-seq winner = %v, want nil", err)
	}
	h := s.History()
	if h[0].Run.Seq != 2 || h[0].Status != Accepted {
		t.Fatalf("seq 2 should be accepted, got %+v", h[0])
	}
	if h[1].Run.Seq != 5 || h[1].Status != RejectedConflict {
		t.Fatalf("seq 5 should be displaced to rejected, got %+v", h[1])
	}
	if d := s.Decide("c1"); d.Actual != Fail {
		t.Fatalf("Actual = %v, want fail (lowest seq wins)", d.Actual)
	}
}

// 按公开最新有效基线决策：非公开与已撤销基线不参与，
// 公开有效基线中取轮次最大者。
func TestGoverningBaselineIsLatestPublicValid(t *testing.T) {
	s := NewStore()
	mustImport(t, s, Run{Case: "c1", Round: 3, Outcome: Fail, Source: "ci", Seq: 10})
	bls := []Baseline{
		{Case: "c1", Round: 1, Expected: Pass, Public: true, Seq: 1},
		{Case: "c1", Round: 2, Expected: Fail, Public: false, Seq: 2}, // 非公开
		{Case: "c1", Round: 3, Expected: Pass, Public: true, Seq: 3},  // 将被撤销
	}
	for _, b := range bls {
		if err := s.ImportBaseline(b); err != nil {
			t.Fatal(err)
		}
	}
	s.RevokeBaseline("c1", 3)
	d := s.Decide("c1")
	if d.Kind != Mismatch || d.Baseline == nil || d.Baseline.Round != 1 {
		t.Fatalf("decision = %+v, want Mismatch against round-1 public baseline", d)
	}
}

// 同（用例, 轮次）重复发布的基线以最大 Seq 为准。
func TestDuplicateBaselineHighestSeqWins(t *testing.T) {
	s := NewStore()
	mustImport(t, s, Run{Case: "c1", Round: 1, Outcome: Fail, Source: "ci", Seq: 1})
	for _, b := range []Baseline{
		{Case: "c1", Round: 1, Expected: Pass, Public: true, Seq: 2},
		{Case: "c1", Round: 1, Expected: Fail, Public: true, Seq: 3},
	} {
		if err := s.ImportBaseline(b); err != nil {
			t.Fatal(err)
		}
	}
	if d := s.Decide("c1"); d.Kind != Match {
		t.Fatalf("Kind = %v, want Match (seq 3 baseline expects fail)", d.Kind)
	}
}

// 基线不匹配单列：Mismatch 与 Match/NoBaseline/Undecided 分开列出。
func TestMismatchesListedSeparately(t *testing.T) {
	s := NewStore()
	mustImport(t, s,
		Run{Case: "match", Round: 1, Outcome: Pass, Source: "ci", Seq: 1},
		Run{Case: "mismatch", Round: 1, Outcome: Fail, Source: "ci", Seq: 2},
		Run{Case: "nobase", Round: 1, Outcome: Pass, Source: "ci", Seq: 3},
	)
	for _, b := range []Baseline{
		{Case: "match", Round: 1, Expected: Pass, Public: true, Seq: 4},
		{Case: "mismatch", Round: 1, Expected: Pass, Public: true, Seq: 5},
	} {
		if err := s.ImportBaseline(b); err != nil {
			t.Fatal(err)
		}
	}
	mm := s.Mismatches()
	if len(mm) != 1 || mm[0].Case != "mismatch" {
		t.Fatalf("Mismatches() = %+v, want only [mismatch]", mm)
	}
	kinds := map[string]DecisionKind{}
	for _, d := range s.Decisions() {
		kinds[d.Case] = d.Kind
	}
	if kinds["match"] != Match || kinds["mismatch"] != Mismatch || kinds["nobase"] != NoBaseline {
		t.Fatalf("kinds = %v", kinds)
	}
}

// 乱序导入：高轮次先导入，决策仍取最高轮次。
func TestOutOfOrderRounds(t *testing.T) {
	s := NewStore()
	mustImport(t, s,
		Run{Case: "c1", Round: 5, Outcome: Fail, Source: "ci", Seq: 1},
		Run{Case: "c1", Round: 2, Outcome: Pass, Source: "ci", Seq: 2},
	)
	if d := s.Decide("c1"); d.Round != 5 || d.Actual != Fail {
		t.Fatalf("decision = %+v, want round 5 fail", d)
	}
}

// 来源摘要：按来源聚合完整历史（含被拒运行）。
func TestSourceSummary(t *testing.T) {
	s := NewStore()
	mustImport(t, s,
		Run{Case: "c1", Round: 1, Outcome: Pass, Source: "ci", Seq: 1},
		Run{Case: "c2", Round: 1, Outcome: Fail, Source: "ci", Seq: 2},
		Run{Case: "c1", Round: 2, Outcome: Pass, Source: "nightly", Seq: 3},
	)
	if err := s.ImportRun(Run{Case: "c1", Round: 2, Outcome: Fail, Source: "nightly", Seq: 4}); !errors.Is(err, ErrConflict) {
		t.Fatalf("want ErrConflict, got %v", err)
	}
	sum := s.SourceSummary()
	if len(sum) != 2 {
		t.Fatalf("len(SourceSummary) = %d, want 2", len(sum))
	}
	ci, nightly := sum[0], sum[1]
	if ci.Source != "ci" || ci.Total != 2 || ci.Accepted != 2 || ci.Pass != 1 || ci.Fail != 1 {
		t.Fatalf("ci stat = %+v", ci)
	}
	if nightly.Source != "nightly" || nightly.Total != 2 || nightly.Accepted != 1 || nightly.Rejected != 1 {
		t.Fatalf("nightly stat = %+v", nightly)
	}
}

// 重复 Seq 拒绝。
func TestDuplicateSeqRejected(t *testing.T) {
	s := NewStore()
	mustImport(t, s, Run{Case: "c1", Round: 1, Outcome: Pass, Source: "ci", Seq: 7})
	if err := s.ImportRun(Run{Case: "c2", Round: 1, Outcome: Pass, Source: "ci", Seq: 7}); err == nil {
		t.Fatal("duplicate run seq accepted")
	}
	if err := s.ImportBaseline(Baseline{Case: "c1", Round: 1, Expected: Pass, Public: true, Seq: 7}); err == nil {
		t.Fatal("duplicate baseline seq accepted")
	}
}

// 无运行用例为 Undecided。
func TestUndecided(t *testing.T) {
	s := NewStore()
	if err := s.ImportBaseline(Baseline{Case: "c1", Round: 1, Expected: Pass, Public: true, Seq: 1}); err != nil {
		t.Fatal(err)
	}
	if d := s.Decide("c1"); d.Kind != Undecided {
		t.Fatalf("Kind = %v, want Undecided", d.Kind)
	}
}
