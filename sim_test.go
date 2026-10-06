package repsim

import (
	"strings"
	"testing"
)

func tickN(s *Sim, n int) {
	for i := 0; i < n; i++ {
		s.Tick()
	}
}

// 联合配置期间：只有旧集多数可用时，联合条目不得提交——
// 未提交的新集不能单独推进，旧集同样不能单独推进。
func TestJointRequiresBothMajorities(t *testing.T) {
	s := NewSim("A", []string{"A", "B", "C"})
	if _, err := s.ChangeMembership([]string{"C", "D", "E"}); err != nil {
		t.Fatal(err)
	}
	s.Propose("x=1")

	// 新集多数 (D,E) 不可达：只有 C 一个新集成员拿到日志。
	s.Isolate("D", "E")
	tickN(s, 3)
	if s.Committed() != 0 {
		t.Fatalf("joint entry committed without new-set majority, commitIndex=%d", s.Committed())
	}
	if len(s.Certs) != 0 {
		t.Fatalf("unexpected commit certificates: %v", s.Certs)
	}
	if s.Change().Phase != PhaseJointProposed {
		t.Fatalf("phase = %s, want joint-proposed", s.Change().Phase)
	}

	// 恢复后：联合条目需新旧双多数，随后自动进入最终配置。
	s.Heal()
	tickN(s, 4)
	if s.Change().Phase != PhaseDone {
		t.Fatalf("phase = %s, want done", s.Change().Phase)
	}
	if err := CheckTrace(s.Certs, s.initial); err != nil {
		t.Fatalf("trace check: %v", err)
	}
	// 联合条目的证书必须同时携带新旧两个多数。
	var jointCert *CommitCertificate
	for i := range s.Certs {
		if s.Certs[i].Kind == KindJoint {
			jointCert = &s.Certs[i]
		}
	}
	if jointCert == nil {
		t.Fatal("no joint certificate emitted")
	}
	if len(jointCert.OldQuorum) < 2 || len(jointCert.NewQuorum) < 2 {
		t.Fatalf("joint cert lacks dual majority: %v", jointCert)
	}
	t.Logf("joint cert: %v", jointCert)
}

// 联合配置期间：新集多数已持有条目，但旧集多数不可达时不得提交——
// 未提交的新集不能单独推进。
func TestNewSetAloneCannotAdvance(t *testing.T) {
	// leader C 同时属于新旧两集；旧集独有成员为 A,B。
	s := NewSim("C", []string{"A", "B", "C"})
	if _, err := s.ChangeMembership([]string{"C", "D", "E"}); err != nil {
		t.Fatal(err)
	}
	// 旧集多数 (A,B) 失联：联合条目复制到新集多数 {C,D,E}，仍不得提交。
	s.Isolate("A", "B")
	tickN(s, 3)
	for _, id := range []string{"C", "D", "E"} {
		if len(s.Nodes[id].Log) == 0 {
			t.Fatalf("new-set node %s missing the joint entry", id)
		}
	}
	if s.Committed() != 0 {
		t.Fatalf("new set advanced alone during joint phase, commitIndex=%d", s.Committed())
	}
	if len(s.Certs) != 0 {
		t.Fatalf("unexpected certificates: %v", s.Certs)
	}
	// 恢复后双多数齐备，变更完成。
	s.Heal()
	tickN(s, 4)
	if s.Change().Phase != PhaseDone {
		t.Fatalf("phase = %s, want done", s.Change().Phase)
	}
	if err := CheckTrace(s.Certs, s.initial); err != nil {
		t.Fatalf("trace check: %v", err)
	}
}

// 最终配置提交后只用新集仲裁：旧集独有节点全部宕机仍可提交。
func TestFinalConfigUsesOnlyNewSet(t *testing.T) {
	s := NewSim("A", []string{"A", "B", "C"})
	if _, err := s.ChangeMembership([]string{"C", "D", "E"}); err != nil {
		t.Fatal(err)
	}
	tickN(s, 5)
	if s.Change().Phase != PhaseDone {
		t.Fatalf("phase = %s, want done", s.Change().Phase)
	}
	if m := s.Membership(); m.Joint() || keyOf(m.Old) != "C,D,E" {
		t.Fatalf("membership = %+v, want single {C,D,E}", m)
	}

	// 旧集独有的 A(旧 leader) 宕机后由 C 接任新 leader 继续提交。
	s.Crash("A")
	s.Crash("B")
	s.Leader = "C"
	s.Term++
	idx := s.Propose("y=2")
	tickN(s, 3)
	if s.Committed() < idx {
		t.Fatalf("entry %d not committed with new-set-only majority, commitIndex=%d", idx, s.Committed())
	}
	last := s.Certs[len(s.Certs)-1]
	if last.Membership.Joint() {
		t.Fatalf("post-final cert still joint: %v", last)
	}
	if len(last.OldQuorum) < 2 || countIn([]string{"A", "B"}, last.Voters) != 0 {
		t.Fatalf("post-final cert must use only the new set: %v", last)
	}
	if err := CheckTrace(s.Certs, s.initial); err != nil {
		t.Fatalf("trace check: %v", err)
	}
	t.Logf("final cert: %v", last)
}

// 重复配置事件幂等：进行中与完成后重复提交同一目标均不产生重复日志条目。
func TestDuplicateConfigEventsIdempotent(t *testing.T) {
	s := NewSim("A", []string{"A", "B", "C"})
	r1, err := s.ChangeMembership([]string{"C", "D", "E"})
	if err != nil {
		t.Fatal(err)
	}
	r2, err := s.ChangeMembership([]string{"E", "C", "D"}) // 顺序不同，同一目标
	if err != nil {
		t.Fatal(err)
	}
	if r1.Phase != r2.Phase || r1.JointIndex != r2.JointIndex || keyOf(r1.Target) != keyOf(r2.Target) {
		t.Fatalf("duplicate event returned different results: %+v vs %+v", r1, r2)
	}
	if got := len(s.Nodes["A"].Log); got != 1 {
		t.Fatalf("duplicate joint entries appended, log len = %d", got)
	}

	tickN(s, 5)
	if r1.Phase == PhaseDone {
		t.Fatal("result snapshot should have been taken while in progress")
	}
	r3, err := s.ChangeMembership([]string{"C", "D", "E"})
	if err != nil {
		t.Fatal(err)
	}
	if r3.Phase != PhaseDone {
		t.Fatalf("phase = %s, want done", r3.Phase)
	}
	logLen := len(s.Nodes["A"].Log)
	// 完成后再重复：不得追加任何条目。
	if _, err := s.ChangeMembership([]string{"C", "D", "E"}); err != nil {
		t.Fatal(err)
	}
	if got := len(s.Nodes["A"].Log); got != logLen {
		t.Fatalf("entries appended after done: %d -> %d", logLen, got)
	}
	// 目标即当前配置：空操作。
	r4, err := s.ChangeMembership([]string{"D", "E", "C"})
	if err != nil {
		t.Fatal(err)
	}
	if r4.Phase != PhaseDone || len(s.Nodes["A"].Log) != logLen {
		t.Fatalf("no-op change mutated state: %+v", r4)
	}
}

// 进行中的变更拒绝冲突目标。
func TestConflictingChangeRejected(t *testing.T) {
	s := NewSim("A", []string{"A", "B", "C"})
	if _, err := s.ChangeMembership([]string{"C", "D", "E"}); err != nil {
		t.Fatal(err)
	}
	if _, err := s.ChangeMembership([]string{"A", "D", "F"}); err == nil {
		t.Fatal("conflicting change accepted while one is in progress")
	} else if !strings.Contains(err.Error(), "in progress") {
		t.Fatalf("unexpected error: %v", err)
	}
}

// 每条提交都必须输出可验证的仲裁证书，且整条故障轨迹通过检查。
func TestCommitCertificatesAndTraceCheck(t *testing.T) {
	s := NewSim("A", []string{"A", "B", "C"})
	s.Propose("a")
	s.Tick()
	if _, err := s.ChangeMembership([]string{"B", "C", "D", "E", "F"}); err != nil {
		t.Fatal(err)
	}
	s.Propose("b")
	s.Isolate("F")
	tickN(s, 2)
	// F 不可达，但新旧两侧仍各有多数：联合条目可以提交。
	if s.Change().Phase == PhaseJointProposed {
		t.Fatal("joint entry should commit with both majorities available")
	}
	s.Heal()
	s.Propose("c")
	tickN(s, 4)

	if len(s.Certs) == 0 {
		t.Fatal("no certificates emitted")
	}
	for _, c := range s.Certs {
		if err := c.Verify(); err != nil {
			t.Fatalf("cert verify: %v", err)
		}
		t.Logf("%v", c)
	}
	if err := CheckTrace(s.Certs, s.initial); err != nil {
		t.Fatalf("trace check: %v", err)
	}
	if s.Change().Phase != PhaseDone {
		t.Fatalf("phase = %s, want done", s.Change().Phase)
	}
}

// 故障轨迹检查器必须拒绝伪造轨迹：联合期缺少新集多数的“提交”。
func TestCheckTraceRejectsNewSetAlone(t *testing.T) {
	initial := Membership{Old: []string{"A", "B", "C"}}
	joint := Membership{Old: []string{"A", "B", "C"}, New: []string{"C", "D", "E"}}
	forged := []CommitCertificate{{
		Index:      1,
		Term:       1,
		Kind:       KindJoint,
		Membership: joint,
		Voters:     []string{"C", "D", "E"}, // 新集多数，旧集仅 C
		OldQuorum:  []string{"C"},
		NewQuorum:  []string{"C", "D", "E"},
	}}
	if err := CheckTrace(forged, initial); err == nil {
		t.Fatal("checker accepted a joint commit without an old-set majority")
	}
}

// 最终配置提交后，仲裁不得继续沿用联合配置。
func TestCheckTraceRejectsStaleJointAfterFinal(t *testing.T) {
	initial := Membership{Old: []string{"A", "B", "C"}}
	joint := Membership{Old: []string{"A", "B", "C"}, New: []string{"C", "D", "E"}}
	final := Membership{Old: []string{"C", "D", "E"}}
	certs := []CommitCertificate{
		{Index: 1, Term: 1, Kind: KindJoint, Membership: joint,
			Voters: []string{"A", "B", "C", "D", "E"}, OldQuorum: []string{"A", "B", "C"}, NewQuorum: []string{"C", "D", "E"}},
		{Index: 2, Term: 1, Kind: KindFinal, Membership: final,
			Voters: []string{"C", "D", "E"}, OldQuorum: []string{"C", "D", "E"}},
		{Index: 3, Term: 1, Kind: KindCommand, Membership: joint, // 非法：最终配置已提交
			Voters: []string{"A", "B", "C", "D", "E"}, OldQuorum: []string{"A", "B", "C"}, NewQuorum: []string{"C", "D", "E"}},
	}
	if err := CheckTrace(certs, initial); err == nil {
		t.Fatal("checker accepted joint arbitration after the final config committed")
	}
	// 合法轨迹：最终配置提交后仅由新集仲裁。
	certs[2] = CommitCertificate{Index: 3, Term: 1, Kind: KindCommand, Membership: final,
		Voters: []string{"C", "D", "E"}, OldQuorum: []string{"C", "D", "E"}}
	if err := CheckTrace(certs, initial); err != nil {
		t.Fatalf("checker rejected a valid trace: %v", err)
	}
}
