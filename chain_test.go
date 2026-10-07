package preimage

import (
	"math/rand"
	"reflect"
	"testing"
)

// bruteChainPreimage evaluates the composed function value by value over
// the short input domain.
func bruteChainPreimage(chain []Map, y Interval) []Interval {
	var out []Interval
	dom := chain[0].Domain()
	for x := dom.Lo; x < dom.Hi; x++ {
		if v, ok := EvalChain(chain, x); ok && y.Contains(v) {
			out = append(out, Interval{Lo: x, Hi: x + 1})
		}
	}
	return Canonicalize(out)
}

func randChain(rng *rand.Rand, layers int) []Map {
	chain := make([]Map, layers)
	for i := range chain {
		chain[i] = randMap(rng, -25, 25, 3)
	}
	return chain
}

func TestChainPreimageAgainstCompositeBruteForce(t *testing.T) {
	rng := rand.New(rand.NewSource(4))
	for i := 0; i < 300; i++ {
		chain := randChain(rng, 1+rng.Intn(3))
		y := Interval{Lo: rng.Int63n(21) - 10, Hi: 0}
		y.Hi = y.Lo + rng.Int63n(8) + 1
		got, tok, _ := PreimageChain(chain, y, 0)
		if tok != nil {
			t.Fatal("unlimited query must complete")
		}
		want := bruteChainPreimage(chain, y)
		if !reflect.DeepEqual(Canonicalize(got), want) {
			t.Fatalf("y=%v:\ngot  %v\nwant %v", y, Canonicalize(got), want)
		}
	}
}

// TestChainTraversesIntermediateRounding pins the layer-by-layer semantics:
// preimages cross every intermediate floor rounding instead of merging
// coefficients into one composite affine.
func TestChainTraversesIntermediateRounding(t *testing.T) {
	f, _ := NewMap([]Piece{{Dom: Interval{Lo: 0, Hi: 64}, F: NewAffine(1, 0, 2)}})
	g, _ := NewMap([]Piece{{Dom: Interval{Lo: 0, Hi: 64}, F: NewAffine(1, 0, 2)}})
	got, _, _ := PreimageChain([]Map{f, g}, Interval{Lo: 3, Hi: 4}, 0)
	// g^{-1}([3,4)) = [6,8); f^{-1}([6,8)) = [12,16).
	want := []Interval{{Lo: 12, Hi: 16}}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("got %v, want %v", got, want)
	}
	// With an offset the layered path is not a single merged division:
	// h(x) = floor((x+1)/2), then g. Query y = [1,2):
	// g^{-1}([1,2)) = [2,4); h^{-1}([2,4)) = {x: 4 <= x+1 < 8} = [3,7).
	h, _ := NewMap([]Piece{{Dom: Interval{Lo: 0, Hi: 64}, F: NewAffine(1, 1, 2)}})
	chain2 := []Map{h, g}
	got2, _, _ := PreimageChain(chain2, Interval{Lo: 1, Hi: 2}, 0)
	want2 := []Interval{{Lo: 3, Hi: 7}}
	if !reflect.DeepEqual(got2, want2) {
		t.Fatalf("layered got %v, want %v", got2, want2)
	}
	if bf := bruteChainPreimage(chain2, Interval{Lo: 1, Hi: 2}); !reflect.DeepEqual(got2, bf) {
		t.Fatalf("layered %v disagrees with brute force %v", got2, bf)
	}
}

// verifyProof replays proofs (possibly split across pause/resume batches)
// against the chain and the original query.
func verifyProof(t *testing.T, chain []Map, y Interval, proofs []Proof, results []Interval) {
	t.Helper()
	frontier := []Interval{y}
	wantLayer := len(chain) - 1
	var final []Interval
	for _, p := range proofs {
		for _, lp := range p.Layers {
			if lp.Layer != wantLayer {
				// A budget pause resumes mid-layer at layer 0.
				if lp.Layer == 0 && wantLayer == -1 {
					wantLayer = 0
				} else {
					t.Fatalf("proof layer = %d, want %d", lp.Layer, wantLayer)
				}
			}
			var next []Interval
			for _, step := range lp.Steps {
				if len(frontier) == 0 || frontier[0] != step.Query {
					t.Fatalf("layer %d: unexpected query %v", lp.Layer, step.Query)
				}
				frontier = frontier[1:]
				if got := chain[lp.Layer].Preimage(step.Query); !reflect.DeepEqual(got, step.Results) {
					t.Fatalf("layer %d query %v: proof %v, recomputed %v",
						lp.Layer, step.Query, step.Results, got)
				}
				next = append(next, step.Results...)
			}
			if lp.Layer != 0 && len(frontier) != 0 {
				t.Fatalf("layer %d: %d queries left unproven", lp.Layer, len(frontier))
			}
			if lp.Layer == 0 {
				final = append(final, next...)
			} else {
				frontier = Canonicalize(next)
			}
			wantLayer--
		}
	}
	if wantLayer != -1 {
		t.Fatalf("proof stopped at layer %d", wantLayer+1)
	}
	if len(frontier) != 0 {
		t.Fatalf("%d queries left unproven at layer 0", len(frontier))
	}
	if !reflect.DeepEqual(final, results) {
		t.Fatalf("proof final %v != emitted results %v", final, results)
	}
}

func TestChainProofAndBudgetResume(t *testing.T) {
	rng := rand.New(rand.NewSource(5))
	for i := 0; i < 100; i++ {
		chain := randChain(rng, 2+rng.Intn(2))
		y := Interval{Lo: rng.Int63n(11) - 5, Hi: 0}
		y.Hi = y.Lo + rng.Int63n(6) + 1

		full, tok, fullProof := PreimageChain(chain, y, 0)
		if tok != nil {
			t.Fatal("unlimited query must complete")
		}
		verifyProof(t, chain, y, []Proof{fullProof}, full)

		// Pause/resume with a small budget must emit exactly the same
		// intervals in the same order, batch by batch.
		budget := 1 + rng.Intn(3)
		var got []Interval
		var proofs []Proof
		tok = nil
		first := true
		for {
			var batch []Interval
			var p Proof
			if first {
				batch, tok, p = PreimageChain(chain, y, budget)
				first = false
			} else {
				batch, tok, p = ResumePreimage(chain, *tok, budget)
			}
			if len(batch) > budget {
				t.Fatalf("batch of %d exceeds budget %d", len(batch), budget)
			}
			got = append(got, batch...)
			proofs = append(proofs, p)
			if tok == nil {
				break
			}
		}
		if !reflect.DeepEqual(got, full) {
			t.Fatalf("resumed %v != unlimited %v", got, full)
		}
		verifyProof(t, chain, y, proofs, got)
		if !reflect.DeepEqual(Canonicalize(got), bruteChainPreimage(chain, y)) {
			t.Fatal("resumed result disagrees with composite brute force")
		}
	}
}

func TestEvalChainOutOfDomain(t *testing.T) {
	narrow, _ := NewMap([]Piece{{Dom: Interval{Lo: 0, Hi: 3}, F: NewAffine(1, 0, 1)}})
	wide, _ := NewMap([]Piece{{Dom: Interval{Lo: -10, Hi: 10}, F: NewAffine(2, 0, 1)}})
	chain := []Map{wide, narrow}
	if _, ok := EvalChain(chain, 4); ok {
		t.Fatal("x=4 leaves the second map domain (2*4=8 >= 3)")
	}
	if v, ok := EvalChain(chain, 1); !ok || v != 2 {
		t.Fatalf("got (%d, %v), want (2, true)", v, ok)
	}
	// Preimage must respect the intermediate domain restriction.
	got, _, _ := PreimageChain(chain, Interval{Lo: 0, Hi: 3}, 0)
	want := bruteChainPreimage(chain, Interval{Lo: 0, Hi: 3})
	if !reflect.DeepEqual(Canonicalize(got), want) {
		t.Fatalf("got %v, want %v", got, want)
	}
}
