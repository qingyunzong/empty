package linearck

import (
	"fmt"
	"math/rand"
	"testing"
)

// violationKey identifies a violation independently of its path.
func violationKey(v Violation) string {
	return fmt.Sprintf("%s|%s|%s", v.Rule, v.Cmd, v.At)
}

func multiset(vs []Violation) map[string]int {
	out := map[string]int{}
	for _, v := range vs {
		if v.Rule == RuleMergeIncompatible {
			continue // the reference machine does not reason about merges
		}
		out[violationKey(v)]++
	}
	return out
}

// agreeWithReference checks that Check and the exhaustive reference
// enumeration report exactly the same command violations.
func agreeWithReference(t *testing.T, p *Program) {
	t.Helper()
	cv, err := Check(p)
	if err != nil {
		t.Fatalf("Check: %v", err)
	}
	rv, err := Reference(p)
	if err != nil {
		t.Fatalf("Reference: %v", err)
	}
	got, want := multiset(cv), multiset(rv)
	for k, n := range want {
		if got[k] != n {
			t.Errorf("checker missed reference violation %s (checker %d, reference %d)", k, got[k], n)
		}
	}
	for k, n := range got {
		if want[k] != n {
			t.Errorf("checker reported extra violation %s (checker %d, reference %d)", k, n, want[k])
		}
	}
}

// checkStatuses cross-checks State.StatusOf against the independent
// refStatuses enumeration on every reachable state of the program.
func checkStatuses(t *testing.T, p *Program) {
	t.Helper()
	snaps, err := Enumerate(p)
	if err != nil {
		t.Fatalf("Enumerate: %v", err)
	}
	for _, sn := range snaps {
		for name, want := range refStatuses(sn.State) {
			if got := sn.State.StatusOf(name); got != want {
				t.Errorf("block %s: StatusOf(%q) = %v, reference says %v", sn.Block, name, got, want)
			}
		}
	}
}

func TestReferenceAgreesWithChecker(t *testing.T) {
	for name, p := range testPrograms() {
		t.Run(name, func(t *testing.T) {
			agreeWithReference(t, p)
			checkStatuses(t, p)
		})
	}
}

func TestReportedPathsReplay(t *testing.T) {
	for name, p := range testPrograms() {
		t.Run(name, func(t *testing.T) {
			vs := mustCheck(t, p)
			for _, v := range vs {
				if v.Rule == RuleMergeIncompatible {
					// Both conflicting executions must be feasible.
					if _, err := Replay(p, v.Path); err != nil {
						t.Errorf("merge path A infeasible: %v", err)
					}
					if _, err := Replay(p, v.Other); err != nil {
						t.Errorf("merge path B infeasible: %v", err)
					}
					continue
				}
				replayed, err := Replay(p, v.Path)
				if err != nil {
					t.Fatalf("reported path infeasible: %v\n%s", err, v)
				}
				if len(replayed) == 0 {
					t.Fatalf("replaying reported path found no violation:\n%s", v)
				}
				last := replayed[len(replayed)-1]
				if last.Rule != v.Rule || last.At != v.At {
					t.Errorf("replay ended with %v at %v, reported %v at %v",
						last.Rule, last.At, v.Rule, v.At)
				}
			}
		})
	}
}

// randomProgram builds a random control-flow graph over a tiny name pool,
// exercising borrows, moves, branches, loops and drops.
func randomProgram(r *rand.Rand) *Program {
	owners := []string{"x", "y"}
	refs := []string{"a", "b", "c"}
	anyName := append(append([]string{}, owners...), refs...)
	pick := func(xs []string) string { return xs[r.Intn(len(xs))] }

	nBlocks := 2 + r.Intn(4)
	names := make([]string, nBlocks)
	for i := range names {
		names[i] = fmt.Sprintf("b%d", i)
	}
	p := &Program{Entry: "b0", Blocks: map[string]*Block{}}
	for _, name := range names {
		nCmds := 1 + r.Intn(6)
		cmds := make([]Cmd, 0, nCmds)
		for i := 0; i < nCmds; i++ {
			switch r.Intn(8) {
			case 0:
				cmds = append(cmds, New{Name: pick(owners)})
			case 1:
				cmds = append(cmds, Share{Ref: pick(refs), Owner: pick(owners)})
			case 2:
				cmds = append(cmds, Mut{Ref: pick(refs), Owner: pick(owners)})
			case 3:
				cmds = append(cmds, Use{Name: pick(anyName)})
			case 4:
				cmds = append(cmds, Write{Name: pick(anyName)})
			case 5:
				cmds = append(cmds, Move{Dst: pick(refs), Src: pick(refs)})
			case 6:
				cmds = append(cmds, End{Ref: pick(refs)})
			case 7:
				cmds = append(cmds, Drop{Owner: pick(owners)})
			}
		}
		var next []string
		for i, n := 0, r.Intn(3); i < n; i++ {
			next = append(next, pick(names))
		}
		p.Blocks[name] = &Block{Name: name, Cmds: cmds, Next: next}
	}
	return p
}

func TestFuzzCheckerVsReference(t *testing.T) {
	r := rand.New(rand.NewSource(20261006))
	for i := 0; i < 500; i++ {
		p := randomProgram(r)
		agreeWithReference(t, p)
		checkStatuses(t, p)
		if t.Failed() {
			t.Fatalf("mismatch on random program %d: %+v", i, p)
		}
	}
}

func TestFuzzReportedPathsReplay(t *testing.T) {
	r := rand.New(rand.NewSource(42))
	for i := 0; i < 200; i++ {
		p := randomProgram(r)
		vs, err := Check(p)
		if err != nil {
			t.Fatalf("Check: %v", err)
		}
		for _, v := range vs {
			if v.Rule == RuleMergeIncompatible {
				continue
			}
			replayed, err := Replay(p, v.Path)
			if err != nil {
				t.Fatalf("program %d: reported path infeasible: %v\n%s", i, err, v)
			}
			if n := len(replayed); n == 0 || replayed[n-1].Rule != v.Rule {
				t.Fatalf("program %d: replay mismatch for %v", i, v)
			}
		}
	}
}
