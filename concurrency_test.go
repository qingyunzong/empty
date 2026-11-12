package dataeng

import (
	"math/big"
	"sync"
	"testing"
)

func TestConcurrentShapleyCalls(t *testing.T) {
	g := &Graph{
		Facts: []string{"a", "b", "c", "u"},
		Root:  "and",
		Nodes: append(
			[]Node{{ID: "and", Kind: NodeAnd, Children: []string{"a", "b", "c"}}},
			literalNodes("a", "b", "c")...,
		),
	}
	compiled := mustCompile(t, g)
	want := big.NewRat(1, 3)

	const goroutines = 16
	var wait sync.WaitGroup
	wait.Add(goroutines)
	for i := 0; i < goroutines; i++ {
		go func() {
			defer wait.Done()
			result := compiled.Shapley()
			if result.Facts["a"].Shapley.Cmp(want) != 0 {
				t.Errorf("phi[a] = %s, want 1/3", result.Facts["a"].Shapley.String())
			}
		}()
	}
	wait.Wait()
}
