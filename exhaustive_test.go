package q220

import (
	"math/rand"
	"strconv"
	"testing"
)

// TestExhaustiveSmallGraphs 对 0..5 个匿名节点的随机图做大量采样，
// 每幅图都与全排列暴力参考逐字节对拍，覆盖自环、重复边、孤立匿名节点等结构。
func TestExhaustiveSmallGraphs(t *testing.T) {
	rng := rand.New(rand.NewSource(424242))
	total := 0
	for n := 0; n <= 5; n++ {
		iterations := 300
		for it := 0; it < iterations; it++ {
			in := randomGraph(rng, n)
			res, err := Canonicalize(in)
			if err != nil {
				t.Fatal(err)
			}
			wantSeq, wantPerm := bruteForceCanonical(t, in)
			assertBruteForce(t, res, wantSeq, wantPerm)
			total++
		}
	}
	t.Logf("穷尽对拍图数: %d", total)
}

// TestAllIsolatedBlanks 覆盖全部匿名节点互不相连、仅各自挂 IRI 的退化结构。
func TestAllIsolatedBlanks(t *testing.T) {
	for n := 1; n <= MaxBlanks; n++ {
		var in []Triple
		for i := 0; i < n; i++ {
			b := blank("k" + strconv.Itoa(i))
			in = append(in, Triple{b, iri("p"), iri("u")})
		}
		res, err := Canonicalize(in)
		if err != nil {
			t.Fatal(err)
		}
		wantSeq, wantPerm := bruteForceCanonical(t, in)
		assertBruteForce(t, res, wantSeq, wantPerm)
	}
}

// TestSelfLoopsAndDuplicates 覆盖匿名节点自环与显式重复三元组。
func TestSelfLoopsAndDuplicates(t *testing.T) {
	rng := rand.New(rand.NewSource(7))
	for n := 1; n <= 5; n++ {
		var in []Triple
		for i := 0; i < n; i++ {
			b := blank("b" + strconv.Itoa(i))
			in = append(in, Triple{b, iri("self"), b})
			in = append(in, Triple{b, iri("self"), b}) // 完全重复
		}
		for k := 0; k < 2*n; k++ {
			i, j := rng.Intn(n), rng.Intn(n)
			in = append(in, Triple{
				blank("b" + strconv.Itoa(i)),
				iri("link"),
				blank("b" + strconv.Itoa(j)),
			})
		}
		res, err := Canonicalize(in)
		if err != nil {
			t.Fatal(err)
		}
		wantSeq, wantPerm := bruteForceCanonical(t, in)
		assertBruteForce(t, res, wantSeq, wantPerm)
	}
}

func randomGraph(rng *rand.Rand, blankCount int) []Triple {
	iris := []Node{iri("a"), iri("b"), iri("c")}
	preds := []Node{iri("p1"), iri("p2")}
	all := make([]Node, 0, blankCount+len(iris))
	for i := 0; i < blankCount; i++ {
		all = append(all, blank("b"+strconv.Itoa(i)))
	}
	all = append(all, iris...)

	count := rng.Intn(2 * len(all))
	out := make([]Triple, 0, count)
	for k := 0; k < count; k++ {
		out = append(out, Triple{
			Subject:   all[rng.Intn(len(all))],
			Predicate: preds[rng.Intn(len(preds))],
			Object:    all[rng.Intn(len(all))],
		})
	}
	return out
}
