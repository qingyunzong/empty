package dataeng

import (
	"errors"
	"math"
	"math/rand"
	"reflect"
	"testing"
)

func cand(n int, confidence float64) NumberCandidate {
	return NumberCandidate{Number: n, Confidence: confidence}
}

func mustSolve(t *testing.T, doc Document, opts Options) Result {
	t.Helper()
	res, err := Adjudicate(doc, opts)
	if err != nil {
		t.Fatalf("Adjudicate: %v", err)
	}
	if len(res.Candidates) == 0 {
		t.Fatal("no candidates returned")
	}
	return res
}

func assertBreakdown(t *testing.T, arr Arrangement) {
	t.Helper()
	bd := arr.Breakdown
	sum := bd.OCR + bd.Unnumbered + bd.PageNumber + bd.Continuity +
		bd.Parity + bd.FileOrder + bd.Duplicate
	if math.Abs(sum-arr.Cost) > 1e-8 {
		t.Fatalf("breakdown sum %v != cost %v", sum, arr.Cost)
	}
}

func TestExactUsesPageNumbersOverFileOrder(t *testing.T) {
	doc := Document{Pages: []Page{
		{ID: "a", FileIndex: 0, Candidates: []NumberCandidate{cand(2, 0.95)}},
		{ID: "b", FileIndex: 1, Candidates: []NumberCandidate{cand(1, 0.95)}},
	}}
	res := mustSolve(t, doc, Options{})
	if !res.Exhaustive {
		t.Fatal("small batch should be exhaustive")
	}
	if got := res.Candidates[0].Order(); !reflect.DeepEqual(got, []string{"b", "a"}) {
		t.Fatalf("order = %v, want [b a]", got)
	}
	assertBreakdown(t, res.Candidates[0])
}

func TestParitySelectsConsistentCandidate(t *testing.T) {
	doc := Document{Pages: []Page{{
		ID: "front", FileIndex: 0, Side: SideFront,
		Candidates: []NumberCandidate{cand(3, 0.6), cand(4, 0.6)},
	}}}
	res := mustSolve(t, doc, Options{
		Weights: Weights{OCR: 1, Parity: 2, Unnumbered: 1},
	})
	p := res.Candidates[0].Pages[0]
	if !p.HasNumber || p.Number != 3 {
		t.Fatalf("selected %d (has=%v), want 3", p.Number, p.HasNumber)
	}
	if res.Candidates[0].Breakdown.Parity != 0 {
		t.Fatalf("parity cost = %v, want 0", res.Candidates[0].Breakdown.Parity)
	}
}

func TestParityRules(t *testing.T) {
	doc := Document{Pages: []Page{{
		ID: "front", FileIndex: 0, Side: SideFront,
		Candidates: []NumberCandidate{cand(2, 1)},
	}}}
	defaultRes := mustSolve(t, doc, Options{Weights: Weights{Parity: 2, Unnumbered: 5}})
	if got := defaultRes.Candidates[0].Breakdown.Parity; got != 2 {
		t.Fatalf("front/even parity cost = %v, want 2", got)
	}
	reversed, err := Adjudicate(doc, Options{
		Weights: Weights{Parity: 2, Unnumbered: 5},
		Parity:  FrontEvenBackOdd,
	})
	if err != nil {
		t.Fatal(err)
	}
	if got := reversed.Candidates[0].Breakdown.Parity; got != 0 {
		t.Fatalf("FrontEvenBackOdd parity cost = %v, want 0", got)
	}
	ignored, err := Adjudicate(doc, Options{
		Weights: Weights{Parity: 2, Unnumbered: 5},
		Parity:  ParityIgnored,
	})
	if err != nil {
		t.Fatal(err)
	}
	if got := ignored.Candidates[0].Breakdown.Parity; got != 0 {
		t.Fatalf("ignored parity cost = %v, want 0", got)
	}
}

func TestDuplicateDigestCorroboratesReading(t *testing.T) {
	doc := Document{Pages: []Page{
		{ID: "dup1", FileIndex: 0, Digest: "same",
			Candidates: []NumberCandidate{cand(12, 0.7), cand(13, 0.3)}},
		{ID: "dup2", FileIndex: 1, Digest: "same",
			Candidates: []NumberCandidate{cand(12, 0.8)}},
	}}
	res := mustSolve(t, doc, Options{})
	for _, p := range res.Candidates[0].Pages {
		if !p.HasNumber || p.Number != 12 {
			t.Fatalf("%s selected %d (has=%v), want 12", p.PageID, p.Number, p.HasNumber)
		}
	}
	if res.Candidates[0].Pages[1].DuplicateOf != "dup1" {
		t.Fatalf("DuplicateOf = %q, want dup1", res.Candidates[0].Pages[1].DuplicateOf)
	}
}

func TestDuplicateConflictIsCosted(t *testing.T) {
	doc := Document{Pages: []Page{
		{ID: "dup1", FileIndex: 0, Digest: "same",
			Candidates: []NumberCandidate{cand(12, 0.9)}},
		{ID: "dup2", FileIndex: 1, Digest: "same",
			Candidates: []NumberCandidate{cand(12, 0.9)}},
		{ID: "dup3", FileIndex: 2, Digest: "same",
			Candidates: []NumberCandidate{cand(13, 0.9)}},
	}}
	res := mustSolve(t, doc, Options{
		Weights: Weights{OCR: 1, Duplicate: 2, Unnumbered: 5},
	})
	if got := res.Candidates[0].Breakdown.Duplicate; got != 4 {
		t.Fatalf("duplicate cost = %v, want 4", got)
	}
}

func TestMissingPagesExemptContiguity(t *testing.T) {
	doc := Document{
		Pages: []Page{
			{ID: "p1", FileIndex: 0, Candidates: []NumberCandidate{cand(1, 1)}},
			{ID: "p3", FileIndex: 1, Candidates: []NumberCandidate{cand(3, 1)}},
		},
	}
	opts := Options{
		Weights:           Weights{PageNumber: 4, Continuity: 1.5, Unnumbered: 10},
		RequireContiguous: true,
	}
	res := mustSolve(t, doc, opts)
	if got := res.Candidates[0].Breakdown.Continuity; got != 1.5 {
		t.Fatalf("continuity without exemption = %v, want 1.5", got)
	}

	doc.MissingPages = []int{2}
	res = mustSolve(t, doc, opts)
	if got := res.Candidates[0].Breakdown.Continuity; got != 0 {
		t.Fatalf("declared missing gap cost = %v, want 0", got)
	}
}

func TestCoversAndInsertsDoNotConstrainNumbering(t *testing.T) {
	doc := Document{Pages: []Page{
		{ID: "p1", FileIndex: 0, Candidates: []NumberCandidate{cand(1, 1)}},
		{ID: "cover", FileIndex: 1, Role: RoleCover, Side: SideFront,
			Candidates: []NumberCandidate{cand(99, 0.1)}},
		{ID: "p2", FileIndex: 2, Candidates: []NumberCandidate{cand(2, 1)}},
		{ID: "insert", FileIndex: 3, Role: RoleInsert},
		{ID: "p3", FileIndex: 4, Candidates: []NumberCandidate{cand(3, 1)}},
	}}
	res := mustSolve(t, doc, Options{
		Weights:           Weights{PageNumber: 4, Parity: 2, Unnumbered: 1},
		RequireContiguous: true,
	})
	arr := res.Candidates[0]
	if arr.Breakdown.PageNumber != 0 || arr.Breakdown.Continuity != 0 ||
		arr.Breakdown.Parity != 0 {
		t.Fatalf("exempt pages contributed cost: %+v", arr.Breakdown)
	}
	for _, p := range arr.Pages {
		if p.Role != RoleContent && p.HasNumber {
			t.Fatalf("exempt page %s received number %d", p.PageID, p.Number)
		}
	}
}

func TestUnnumberedContentDoesNotBreakNumberChain(t *testing.T) {
	doc := Document{Pages: []Page{
		{ID: "p1", FileIndex: 0, Candidates: []NumberCandidate{cand(1, 1)}},
		{ID: "ocr-miss", FileIndex: 1},
		{ID: "p3", FileIndex: 2, Candidates: []NumberCandidate{cand(3, 1)}},
	}}
	res := mustSolve(t, doc, Options{
		Weights:           Weights{PageNumber: 4, Continuity: 1.5, Unnumbered: 10},
		RequireContiguous: true,
	})
	if got := res.Candidates[0].Breakdown.Continuity; got != 1.5 {
		t.Fatalf("continuity = %v, want 1.5", got)
	}
}

func TestFileOrderFallback(t *testing.T) {
	doc := Document{Pages: []Page{
		{ID: "a", FileIndex: 0},
		{ID: "b", FileIndex: 1},
		{ID: "c", FileIndex: 2},
	}}
	res := mustSolve(t, doc, Options{})
	if got := res.Candidates[0].Order(); !reflect.DeepEqual(got, []string{"a", "b", "c"}) {
		t.Fatalf("order = %v, want file order", got)
	}
}

func TestConflictReportsTiedCandidates(t *testing.T) {
	doc := Document{Pages: []Page{
		{ID: "a", FileIndex: 0},
		{ID: "b", FileIndex: 1},
		{ID: "c", FileIndex: 2},
	}}
	// Only OCR is enabled, and there is no OCR. Every permutation ties.
	res := mustSolve(t, doc, Options{
		Weights:       Weights{OCR: 1},
		MaxCandidates: 6,
	})
	if !res.Conflict {
		t.Fatal("expected conflict for fully tied permutations")
	}
	if len(res.Candidates) != 6 {
		t.Fatalf("got %d candidates, want all 6", len(res.Candidates))
	}
	if res.Candidates[0].Cost != 0 {
		t.Fatalf("tied cost = %v, want 0", res.Candidates[0].Cost)
	}
}

func TestZeroValueSolverAndEmptyDocument(t *testing.T) {
	var solver Solver
	res, err := solver.Solve(Document{})
	if err != nil {
		t.Fatal(err)
	}
	if !res.Exhaustive || len(res.Candidates) != 1 || res.Candidates[0].Cost != 0 {
		t.Fatalf("unexpected empty result: %+v", res)
	}
	if len(res.Candidates[0].Pages) != 0 {
		t.Fatal("empty document produced pages")
	}
}

func TestValidationErrors(t *testing.T) {
	tests := []struct {
		name string
		doc  Document
		opts Options
	}{
		{"duplicate IDs", Document{Pages: []Page{
			{ID: "x", FileIndex: 0}, {ID: "x", FileIndex: 1},
		}}, Options{}},
		{"negative file index", Document{Pages: []Page{
			{ID: "x", FileIndex: -1},
		}}, Options{}},
		{"bad number", Document{Pages: []Page{
			{ID: "x", Candidates: []NumberCandidate{cand(0, 0.5)}},
		}}, Options{}},
		{"bad confidence", Document{Pages: []Page{
			{ID: "x", Candidates: []NumberCandidate{cand(1, 1.5)}},
		}}, Options{}},
		{"bad weight", Document{}, Options{Weights: Weights{OCR: -1}}},
		{"bad parity", Document{}, Options{Parity: ParityIgnored + 1}},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if _, err := Adjudicate(tt.doc, tt.opts); err == nil {
				t.Fatal("expected error")
			}
		})
	}
}

func TestSolveExactLimit(t *testing.T) {
	pages := make([]Page, maxExactPages+1)
	for i := range pages {
		pages[i] = Page{ID: "p", FileIndex: i}
	}
	for i := range pages {
		pages[i].ID = string(rune('a' + i))
	}
	s, err := NewSolver(Options{})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := s.SolveExact(Document{Pages: pages}); !errors.Is(err, ErrTooManyPages) {
		t.Fatalf("error = %v, want ErrTooManyPages", err)
	}
}

func TestExactMediumBatch(t *testing.T) {
	doc := Document{Pages: make([]Page, 10)}
	for i := range doc.Pages {
		doc.Pages[i] = Page{
			ID:        string(rune('a' + i)),
			FileIndex: 9 - i,
			Side:      Side([]Side{SideFront, SideBack}[i%2]),
			Candidates: []NumberCandidate{
				cand(i+1, 0.8),
				cand(i+2, 0.55),
			},
		}
	}
	s, err := NewSolver(Options{})
	if err != nil {
		t.Fatal(err)
	}
	res, err := s.SolveExact(doc)
	if err != nil {
		t.Fatal(err)
	}
	if !res.Exhaustive {
		t.Fatal("medium exact result is not marked exhaustive")
	}
	arr := res.Candidates[0]
	if len(arr.Pages) != len(doc.Pages) {
		t.Fatalf("got %d pages, want %d", len(arr.Pages), len(doc.Pages))
	}
	seen := make(map[string]bool, len(arr.Pages))
	for _, p := range arr.Pages {
		if seen[p.PageID] {
			t.Fatalf("page %s repeated", p.PageID)
		}
		seen[p.PageID] = true
	}
	assertBreakdown(t, arr)
}

func TestExactMatchesBruteForce(t *testing.T) {
	rng := rand.New(rand.NewSource(7))
	for trial := 0; trial < 40; trial++ {
		n := 2 + rng.Intn(4)
		doc := randomDocument(rng, n)
		opts, err := normalizeOptions(Options{
			ExactMaxPages: 8,
			CostWindow:    1e-9,
			MaxCandidates: 5,
		})
		if err != nil {
			t.Fatal(err)
		}
		s, err := NewSolver(opts)
		if err != nil {
			t.Fatal(err)
		}
		exact, err := s.SolveExact(doc)
		if err != nil {
			t.Fatal(err)
		}
		m, err := newModel(doc, opts)
		if err != nil {
			t.Fatal(err)
		}
		best := bruteForceBest(m)
		if math.Abs(exact.Candidates[0].Cost-best) > 1e-8 {
			t.Fatalf("trial %d: exact %v, brute %v; doc=%+v",
				trial, exact.Candidates[0].Cost, best, doc)
		}
		assertBreakdown(t, exact.Candidates[0])
	}
}

func TestBeamFindsOptimumWhenWideEnough(t *testing.T) {
	rng := rand.New(rand.NewSource(11))
	for trial := 0; trial < 20; trial++ {
		n := 2 + rng.Intn(4)
		doc := randomDocument(rng, n)
		opts := Options{BeamWidth: 100_000, MaxCandidates: 5, CostWindow: 1e-9}
		s, err := NewSolver(opts)
		if err != nil {
			t.Fatal(err)
		}
		exact, err := s.SolveExact(doc)
		if err != nil {
			t.Fatal(err)
		}
		beam, err := s.SolveBeam(doc)
		if err != nil {
			t.Fatal(err)
		}
		if beam.Exhaustive {
			t.Fatal("beam result marked exhaustive")
		}
		if math.Abs(beam.Candidates[0].Cost-exact.Candidates[0].Cost) > 1e-8 {
			t.Fatalf("trial %d: beam %v, exact %v", trial, beam.Candidates[0].Cost, exact.Candidates[0].Cost)
		}
	}
}

func TestSolveAutoSelectsSolver(t *testing.T) {
	small := Document{Pages: []Page{{ID: "a"}, {ID: "b"}}}
	s, err := NewSolver(Options{})
	if err != nil {
		t.Fatal(err)
	}
	res, err := s.Solve(small)
	if err != nil {
		t.Fatal(err)
	}
	if !res.Exhaustive {
		t.Fatal("small batch should use exact solver")
	}

	large := make([]Page, 20)
	for i := range large {
		large[i] = Page{ID: string(rune('a' + i)), FileIndex: i}
	}
	res, err = s.Solve(Document{Pages: large})
	if err != nil {
		t.Fatal(err)
	}
	if res.Exhaustive {
		t.Fatal("large batch should use beam solver")
	}
}

func TestDeterministic(t *testing.T) {
	doc := randomDocument(rand.New(rand.NewSource(3)), 6)
	opts := Options{MaxCandidates: 5, CostWindow: 1}
	first := mustSolve(t, doc, opts)
	second := mustSolve(t, doc, opts)
	if !reflect.DeepEqual(first, second) {
		t.Fatal("same input produced different results")
	}
}

func randomDocument(rng *rand.Rand, n int) Document {
	roles := []PageRole{RoleContent, RoleContent, RoleContent, RoleCover, RoleInsert}
	sides := []Side{SideUnknown, SideFront, SideBack}
	doc := Document{Pages: make([]Page, n)}
	digestChoice := []string{"", "", "d1", "d2"}
	for i := 0; i < n; i++ {
		p := Page{
			ID:        string(rune('a' + i)),
			FileIndex: i,
			Role:      roles[rng.Intn(len(roles))],
			Side:      sides[rng.Intn(len(sides))],
			Digest:    digestChoice[rng.Intn(len(digestChoice))],
		}
		if p.Role == RoleContent && rng.Intn(5) != 0 {
			base := 1 + rng.Intn(8)
			count := 1 + rng.Intn(2)
			for j := 0; j < count; j++ {
				num := base + rng.Intn(3)
				conf := 0.4 + rng.Float64()*0.6
				p.Candidates = append(p.Candidates, cand(num, conf))
			}
		}
		doc.Pages[i] = p
	}
	if rng.Intn(2) == 0 {
		doc.MissingPages = []int{1 + rng.Intn(4)}
	}
	return doc
}

func bruteForceBest(m *model) float64 {
	n := len(m.pages)
	if n == 0 {
		return 0
	}
	best := math.Inf(1)
	seq := make([]int, 0, n)
	choices := make([]int, 0, n)
	used := newBitset(n)

	var visit func()
	visit = func() {
		if len(seq) == n {
			arr, err := m.evaluate(seq, choices)
			if err == nil && arr.Cost < best {
				best = arr.Cost
			}
			return
		}
		for page := 0; page < n; page++ {
			if used.has(page) {
				continue
			}
			used.set(page)
			for ci := range m.choices[page] {
				seq = append(seq, page)
				choices = append(choices, ci)
				visit()
				seq = seq[:len(seq)-1]
				choices = choices[:len(choices)-1]
			}
			used.set(page)
			used[page>>6] &^= uint64(1) << (uint(page) & 63)
		}
	}
	visit()
	return best
}
