package linearck

import (
	"strings"
	"testing"
)

// linear builds a single-block straight-line program.
func linear(cmds ...Cmd) *Program {
	return &Program{
		Entry: "main",
		Blocks: map[string]*Block{
			"main": {Name: "main", Cmds: cmds},
		},
	}
}

// testPrograms collects the hand-written programs reused across tests.
func testPrograms() map[string]*Program {
	diamondOK := &Program{
		Entry: "entry",
		Blocks: map[string]*Block{
			"entry": {Name: "entry", Cmds: []Cmd{New{Name: "x"}}, Next: []string{"l", "r"}},
			"l": {Name: "l", Cmds: []Cmd{
				Share{Ref: "a", Owner: "x"}, Use{Name: "a"}, End{Ref: "a"},
			}, Next: []string{"join"}},
			"r": {Name: "r", Cmds: []Cmd{
				Share{Ref: "b", Owner: "x"}, Use{Name: "b"}, End{Ref: "b"},
			}, Next: []string{"join"}},
			"join": {Name: "join", Cmds: []Cmd{Use{Name: "x"}, Drop{Owner: "x"}}},
		},
	}
	diamondBad := &Program{
		Entry: "entry",
		Blocks: map[string]*Block{
			"entry": {Name: "entry", Cmds: []Cmd{New{Name: "x"}}, Next: []string{"l", "r"}},
			"l":     {Name: "l", Cmds: []Cmd{Share{Ref: "a", Owner: "x"}}, Next: []string{"join"}},
			"r":     {Name: "r", Next: []string{"join"}},
			"join":  {Name: "join", Cmds: []Cmd{Use{Name: "x"}}},
		},
	}
	loopOK := &Program{
		Entry: "entry",
		Blocks: map[string]*Block{
			"entry": {Name: "entry", Cmds: []Cmd{New{Name: "x"}}, Next: []string{"loop"}},
			"loop": {Name: "loop", Cmds: []Cmd{
				Share{Ref: "t", Owner: "x"}, Use{Name: "t"}, End{Ref: "t"},
			}, Next: []string{"loop", "exit"}},
			"exit": {Name: "exit", Cmds: []Cmd{Drop{Owner: "x"}}},
		},
	}
	loopBad := &Program{
		Entry: "entry",
		Blocks: map[string]*Block{
			"entry": {Name: "entry", Cmds: []Cmd{
				New{Name: "x"}, Share{Ref: "r", Owner: "x"},
			}, Next: []string{"loop"}},
			"loop": {Name: "loop", Cmds: []Cmd{
				Use{Name: "r"}, End{Ref: "r"},
			}, Next: []string{"loop", "exit"}},
			"exit": {Name: "exit"},
		},
	}
	return map[string]*Program{
		"shared-ok": linear(
			New{Name: "x"},
			Share{Ref: "a", Owner: "x"},
			Share{Ref: "b", Owner: "x"},
			Use{Name: "x"}, Use{Name: "a"}, Use{Name: "b"},
			End{Ref: "a"}, End{Ref: "b"},
			Write{Name: "x"},
			Drop{Owner: "x"},
		),
		"exclusive-alias": linear(
			New{Name: "x"},
			Mut{Ref: "m", Owner: "x"},
			Use{Name: "x"},                   // alias during exclusive
			Write{Name: "x"},                 // write while borrowed
			Use{Name: "m"}, Write{Name: "m"}, // the borrow itself is fine
			End{Ref: "m"},
			Use{Name: "x"},
			Drop{Owner: "x"},
		),
		"exclusive-while-borrowed": linear(
			New{Name: "x"},
			Share{Ref: "a", Owner: "x"},
			Mut{Ref: "m", Owner: "x"},
		),
		"share-during-exclusive": linear(
			New{Name: "x"},
			Mut{Ref: "m", Owner: "x"},
			Share{Ref: "a", Owner: "x"},
		),
		"move-transfer": linear(
			New{Name: "x"},
			Mut{Ref: "m", Owner: "x"},
			Move{Dst: "n", Src: "m"},
			Use{Name: "m"}, // moved away
			Write{Name: "n"},
			End{Ref: "n"},
			Drop{Owner: "x"},
		),
		"outlives-owner": linear(
			New{Name: "x"},
			Share{Ref: "r", Owner: "x"},
			Drop{Owner: "x"}, // borrow still alive
			Use{Name: "r"},   // dangling borrow
		),
		"write-through-shared": linear(
			New{Name: "x"},
			Share{Ref: "a", Owner: "x"},
			Write{Name: "a"},
		),
		"use-of-unknown":  linear(Use{Name: "y"}),
		"move-of-invalid": linear(New{Name: "x"}, Move{Dst: "n", Src: "m"}),
		"double-end": linear(
			New{Name: "x"},
			Share{Ref: "r", Owner: "x"},
			End{Ref: "r"},
			End{Ref: "r"},
		),
		"diamond-ok":  diamondOK,
		"diamond-bad": diamondBad,
		"loop-ok":     loopOK,
		"loop-bad":    loopBad,
	}
}

func mustCheck(t *testing.T, p *Program) []Violation {
	t.Helper()
	vs, err := Check(p)
	if err != nil {
		t.Fatalf("Check: %v", err)
	}
	return vs
}

func ruleList(vs []Violation) []string {
	var out []string
	for _, v := range vs {
		out = append(out, v.Rule)
	}
	return out
}

func expectRules(t *testing.T, name string, want ...string) {
	t.Helper()
	vs := mustCheck(t, testPrograms()[name])
	got := ruleList(vs)
	if len(got) != len(want) {
		t.Fatalf("%s: got rules %v, want %v\nviolations:\n%s", name, got, want, dump(vs))
	}
	for i := range want {
		if got[i] != want[i] {
			t.Fatalf("%s: got rules %v, want %v", name, got, want)
		}
	}
}

func dump(vs []Violation) string {
	var b strings.Builder
	for _, v := range vs {
		b.WriteString(v.String())
		b.WriteByte('\n')
	}
	return b.String()
}

func TestSharedBorrowsAllowAliasedReads(t *testing.T) {
	expectRules(t, "shared-ok")
}

func TestExclusiveForbidsAliasAccess(t *testing.T) {
	expectRules(t, "exclusive-alias", RuleAliasDuringExclusive, RuleWriteWhileBorrowed)
}

func TestExclusiveWhileBorrowed(t *testing.T) {
	expectRules(t, "exclusive-while-borrowed", RuleExclusiveWhileBorrowed)
}

func TestShareDuringExclusive(t *testing.T) {
	expectRules(t, "share-during-exclusive", RuleShareDuringExclusive)
}

func TestMoveTransfersBorrow(t *testing.T) {
	expectRules(t, "move-transfer", RuleUseAfterMove)
}

func TestBorrowCannotOutliveOwner(t *testing.T) {
	expectRules(t, "outlives-owner", RuleBorrowOutlivesOwner, RuleBorrowOutlivesOwner)
}

func TestWriteThroughShared(t *testing.T) {
	expectRules(t, "write-through-shared", RuleWriteThroughShared)
}

func TestInvalidNames(t *testing.T) {
	expectRules(t, "use-of-unknown", RuleUseOfUnknown)
	expectRules(t, "move-of-invalid", RuleMoveOfInvalid)
	expectRules(t, "double-end", RuleEndOfInvalid)
}

func TestMergeRequiresCompatibility(t *testing.T) {
	expectRules(t, "diamond-ok")

	vs := mustCheck(t, testPrograms()["diamond-bad"])
	if len(vs) != 1 || vs[0].Rule != RuleMergeIncompatible {
		t.Fatalf("diamond-bad: got %v, want one merge-incompatible", ruleList(vs))
	}
	v := vs[0]
	if v.At.Block != "join" {
		t.Fatalf("merge violation at %q, want join", v.At.Block)
	}
	if len(v.Path) == 0 || len(v.Other) == 0 {
		t.Fatalf("merge violation must carry both paths: %v", v)
	}
	msg := v.String()
	if !strings.Contains(msg, "path A") || !strings.Contains(msg, "path B") {
		t.Fatalf("merge violation should print both paths, got:\n%s", msg)
	}
}

func TestLoopMerge(t *testing.T) {
	expectRules(t, "loop-ok")

	vs := mustCheck(t, testPrograms()["loop-bad"])
	if len(vs) == 0 || vs[0].Rule != RuleMergeIncompatible || vs[0].At.Block != "loop" {
		t.Fatalf("loop-bad: got %v, want merge-incompatible at loop", ruleList(vs))
	}
	// Analysis continues past the bad merge: the second iteration touches
	// the already-ended borrow and must also be reported.
	got := ruleList(vs)
	want := []string{RuleMergeIncompatible, RuleUseOfUnknown, RuleEndOfInvalid}
	if len(got) != len(want) {
		t.Fatalf("loop-bad: got %v, want %v", got, want)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Fatalf("loop-bad: got %v, want %v", got, want)
		}
	}
}

func TestViolationPathLeadsToOffendingCommand(t *testing.T) {
	vs := mustCheck(t, testPrograms()["exclusive-alias"])
	v := vs[0]
	last := v.Path[len(v.Path)-1]
	if last != v.At {
		t.Fatalf("path should end at the offending command %v, got %v", v.At, last)
	}
	msg := v.String()
	for _, want := range []string{"alias-during-exclusive", "use x", "main[0]", "main[2]", "->"} {
		if !strings.Contains(msg, want) {
			t.Fatalf("violation text missing %q:\n%s", want, msg)
		}
	}
}

func TestStatusEnumeration(t *testing.T) {
	s := NewState()
	run := func(c Cmd) {
		if v := c.exec(s); v != nil {
			t.Fatalf("unexpected violation from %s: %v", c, v)
		}
	}
	if got := s.StatusOf("x"); got != Dead {
		t.Fatalf("before new: got %v, want dead", got)
	}
	run(New{Name: "x"})
	if got := s.StatusOf("x"); got != Owned {
		t.Fatalf("after new: got %v, want owned", got)
	}
	run(Share{Ref: "a", Owner: "x"})
	run(Share{Ref: "b", Owner: "x"})
	if got := s.StatusOf("x"); got != Lent {
		t.Fatalf("after shares: got %v, want lent", got)
	}
	run(End{Ref: "a"})
	run(End{Ref: "b"})
	if got := s.StatusOf("x"); got != Owned {
		t.Fatalf("after ends: got %v, want owned", got)
	}
	run(Mut{Ref: "m", Owner: "x"})
	if got := s.StatusOf("x"); got != MutBorrowed {
		t.Fatalf("after mut: got %v, want mut-borrowed", got)
	}
	run(End{Ref: "m"})
	run(Drop{Owner: "x"})
	if got := s.StatusOf("x"); got != Dead {
		t.Fatalf("after drop: got %v, want dead", got)
	}
}
