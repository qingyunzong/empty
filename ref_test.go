package linearchk

import (
	"math/rand"
	"testing"
)

// alphabet is the small command vocabulary used for reference
// verification: owners x, y and borrows r, m.
var alphabet = []Cmd{
	New{Name: "x"}, New{Name: "y"},
	Share{Borrow: "r", Owner: "x"}, Share{Borrow: "r", Owner: "y"},
	Share{Borrow: "m", Owner: "x"},
	Excl{Borrow: "r", Owner: "x"}, Excl{Borrow: "m", Owner: "y"},
	Use{Name: "x"}, Use{Name: "y"}, Use{Name: "r"}, Use{Name: "m"},
	Mut{Name: "x"}, Mut{Name: "r"},
	Move{Dst: "y", Src: "x"}, Move{Dst: "m", Src: "r"},
	Drop{Name: "x"}, Drop{Name: "y"}, Drop{Name: "r"}, Drop{Name: "m"},
}

// agree asserts the path-sensitive checker and the exhaustive state
// enumerator reach the same verdict on prog.
func agree(t *testing.T, prog []Cmd) {
	t.Helper()
	checked := len(Check(prog)) > 0
	explored := len(Explore(prog).Bad) > 0
	if checked != explored {
		t.Fatalf("verdict mismatch: Check=%v Explore=%v\nprogram: %v\ncheck: %v\nexplore: %v",
			checked, explored, prog, Check(prog), Explore(prog).Bad)
	}
}

// TestReferenceExhaustive cross-checks every straight-line program up
// to length 3 and every single-If program with one-command branches
// against the finite state enumerator.
func TestReferenceExhaustive(t *testing.T) {
	n := len(alphabet)
	for i := 0; i < n; i++ {
		agree(t, []Cmd{alphabet[i]})
		for j := 0; j < n; j++ {
			agree(t, []Cmd{alphabet[i], alphabet[j]})
			agree(t, []Cmd{alphabet[i], If{
				Then: []Cmd{alphabet[j]},
				Else: []Cmd{alphabet[i]},
			}})
			for k := 0; k < n; k++ {
				agree(t, []Cmd{alphabet[i], alphabet[j], alphabet[k]})
			}
		}
	}
}

// TestReferenceRandom cross-checks random programs with nested
// branches.
func TestReferenceRandom(t *testing.T) {
	rng := rand.New(rand.NewSource(20261007))
	var gen func(depth int) []Cmd
	gen = func(depth int) []Cmd {
		var prog []Cmd
		for i, n := 0, rng.Intn(6); i < n; i++ {
			if depth < 2 && rng.Intn(4) == 0 {
				prog = append(prog, If{Then: gen(depth + 1), Else: gen(depth + 1)})
				continue
			}
			prog = append(prog, alphabet[rng.Intn(len(alphabet))])
		}
		return prog
	}
	for i := 0; i < 3000; i++ {
		agree(t, gen(0))
	}
}
