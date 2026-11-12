package dataeng

import (
	"fmt"
	"math/rand"
	"testing"
)

type bruteResult struct {
	hasModel bool
	subsumes map[ConceptPair]bool
	empty    map[string]bool
}

func forEachBit(mask uint64, fn func(int)) {
	for mask != 0 {
		bit := mask & -mask
		index := 0
		for (uint64(1) << uint(index)) != bit {
			index++
		}
		fn(index)
		mask &= mask - 1
	}
}

// bruteForceSemantics enumerates all set and relation interpretations on
// domains of size 1..3. It uses set semantics directly, not the completion
// rules, and is only used for snapshots with at most two ordinary concepts and
// one relation.
func bruteForceSemantics(t *testing.T, s *Snapshot) bruteResult {
	t.Helper()
	names := s.Concepts()
	ordinary := names[:len(names)-2]
	relations := s.Relations()
	if len(ordinary) > 2 || len(relations) != 1 {
		t.Fatalf("brute force test requires <=2 concepts and exactly one relation")
	}

	result := bruteResult{
		subsumes: make(map[ConceptPair]bool, len(names)*len(names)),
		empty:    make(map[string]bool, len(names)),
	}
	for _, a := range names {
		result.empty[a] = true
		for _, b := range names {
			result.subsumes[ConceptPair{A: a, B: b}] = true
		}
	}

	for n := 1; n <= 3; n++ {
		allMask := (uint64(1) << uint(n)) - 1
		conceptAssignmentCount := 1 << uint(n*len(ordinary))
		relationAssignmentCount := 1 << uint(n*n)

		for assignment := 0; assignment < conceptAssignmentCount; assignment++ {
			sets := make([]uint64, len(ordinary))
			for i := range ordinary {
				sets[i] = uint64(assignment>>uint(i*n)) & allMask
			}

			for relAssignment := 0; relAssignment < relationAssignmentCount; relAssignment++ {
				successors := make([]uint64, n)
				for x := 0; x < n; x++ {
					successors[x] = uint64(relAssignment>>uint(x*n)) & allMask
				}

				setOf := func(concept string) uint64 {
					switch concept {
					case Top:
						return allMask
					case Bottom:
						return 0
					}
					for i, name := range ordinary {
						if name == concept {
							return sets[i]
						}
					}
					t.Fatalf("unknown concept %q in brute force", concept)
					return 0
				}

				model := true
				for _, a := range s.Axioms() {
					switch a.Kind {
					case KindInclusion:
						if setOf(a.A)&^setOf(a.B) != 0 {
							model = false
						}
					case KindIntersectionInclusion:
						if setOf(a.A1)&setOf(a.A2)&^setOf(a.B) != 0 {
							model = false
						}
					case KindExistentialInclusion:
						left, right := setOf(a.A), setOf(a.B)
						forEachBit(left, func(x int) {
							if successors[x]&right == 0 {
								model = false
							}
						})
					case KindExistentialSubsumption:
						left, right := setOf(a.A), setOf(a.B)
						_ = right
						for x := 0; x < n; x++ {
							if successors[x]&left != 0 && right&(uint64(1)<<uint(x)) == 0 {
								model = false
							}
						}
					default:
						t.Fatalf("unexpected axiom kind")
					}
					if !model {
						break
					}
				}
				if !model {
					continue
				}

				result.hasModel = true
				for _, a := range names {
					aSet := setOf(a)
					if aSet != 0 {
						result.empty[a] = false
					}
					for _, b := range names {
						if aSet&^setOf(b) != 0 {
							result.subsumes[ConceptPair{A: a, B: b}] = false
						}
					}
				}
			}
		}
	}
	return result
}

func randomConceptSet(rng *rand.Rand, concepts []string) []string {
	n := 1 + rng.Intn(2)
	return append([]string(nil), concepts[:n]...)
}

func pickConcept(rng *rand.Rand, concepts []string) string {
	choices := append([]string(nil), concepts...)
	choices = append(choices, Top, Bottom)
	return choices[rng.Intn(len(choices))]
}

func TestRandomAxiomsAgainstExhaustiveSetSemantics(t *testing.T) {
	allConcepts := []string{"A", "B"}
	seeds := []int64{0x5182026, 0x9e3779b9, 0x1234567, 0xabcdef}
	const trialsPerSeed = 50

	for _, seed := range seeds {
		rng := rand.New(rand.NewSource(seed))
		for trial := 0; trial < trialsPerSeed; trial++ {
			concepts := randomConceptSet(rng, allConcepts)
			axiomCount := 1 + rng.Intn(12)
			axioms := make([]Axiom, 0, axiomCount)
			for i := 0; i < axiomCount; i++ {
				id := fmt.Sprintf("s%d-t%d-a%d", seed, trial, i)
				a1 := pickConcept(rng, concepts)
				a2 := pickConcept(rng, concepts)
				b := pickConcept(rng, concepts)
				switch AxiomKind(rng.Intn(4)) {
				case KindInclusion:
					axioms = append(axioms, Include(id, a1, b))
				case KindIntersectionInclusion:
					axioms = append(axioms, Intersect(id, a1, a2, b))
				case KindExistentialInclusion:
					axioms = append(axioms, Exists(id, a1, "r", b))
				case KindExistentialSubsumption:
					axioms = append(axioms, ExistsSubsumed(id, "r", a1, b))
				}
			}

			s, err := NewSnapshot(Vocabulary{Concepts: concepts, Relations: []string{"r"}}, axioms)
			if err != nil {
				t.Fatalf("seed %d trial %d: NewSnapshot: %v", seed, trial, err)
			}
			c := s.Classify()
			want := bruteForceSemantics(t, s)

			if c.Inconsistent() == want.hasModel {
				t.Fatalf("seed %d trial %d: classifier inconsistent=%v, brute-force hasModel=%v",
					seed, trial, c.Inconsistent(), want.hasModel)
			}

			for pair, expected := range want.subsumes {
				got := mustSubsumes(t, c, pair.A, pair.B)
				if got != expected {
					t.Fatalf("seed %d trial %d: %s <= %s classifier=%v brute=%v; axioms=%v",
						seed, trial, pair.A, pair.B, got, expected, axioms)
				}
				if got {
					p, err := c.ProofFor(pair.A, pair.B)
					if err != nil {
						t.Fatalf("seed %d trial %d: ProofFor(%s,%s): %v", seed, trial, pair.A, pair.B, err)
					}
					verifyProof(t, s, p)
					if len(p.Steps) == 0 {
						t.Fatalf("seed %d trial %d: empty proof", seed, trial)
					}
				} else {
					countermodel(t, c, pair.A, pair.B)
				}
			}

			for concept, expected := range want.empty {
				got := mustEmpty(t, c, concept)
				if got != expected {
					t.Fatalf("seed %d trial %d: empty(%s) classifier=%v brute=%v; axioms=%v",
						seed, trial, concept, got, expected, axioms)
				}
			}
		}
	}
}
