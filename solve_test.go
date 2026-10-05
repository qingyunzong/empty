package main

import "testing"

func spec3x2() *Spec {
	return &Spec{Dimensions: []Dimension{
		{Name: "a", Values: []string{"a1", "a2"}},
		{Name: "b", Values: []string{"b1", "b2"}},
		{Name: "c", Values: []string{"c1", "c2"}},
	}}
}

func TestValidate(t *testing.T) {
	good := spec3x2()
	if err := good.Validate(); err != nil {
		t.Fatalf("valid spec rejected: %v", err)
	}
	cases := []*Spec{
		{Dimensions: []Dimension{}},
		{Dimensions: []Dimension{{Name: "a"}}},
		{Dimensions: []Dimension{{Name: "a", Values: []string{"x"}}, {Name: "a", Values: []string{"y"}}}},
		{Dimensions: []Dimension{{Name: "a", Values: []string{"x", "x"}}}},
		{Dimensions: spec3x2().Dimensions, Forbidden: []Assignment{{"nope": "x"}}},
		{Dimensions: spec3x2().Dimensions, Forbidden: []Assignment{{"a": "nope"}}},
		{Dimensions: spec3x2().Dimensions, Preconditions: []Precondition{{When: Assignment{"a": "a1"}}}},
		{Dimensions: spec3x2().Dimensions, Preconditions: []Precondition{{When: Assignment{"a": "a1"}, Require: Assignment{"b": "nope"}}}},
	}
	for i, s := range cases {
		if err := s.Validate(); err == nil {
			t.Fatalf("case %d: invalid spec accepted", i)
		}
	}
}

func TestLegality(t *testing.T) {
	s := &Spec{
		Dimensions: []Dimension{
			{Name: "os", Values: []string{"linux", "win"}},
			{Name: "browser", Values: []string{"chrome", "safari"}},
			{Name: "db", Values: []string{"mysql", "pg"}},
		},
		Forbidden:     []Assignment{{"os": "win", "browser": "safari"}},
		Preconditions: []Precondition{{When: Assignment{"db": "mysql"}, Require: Assignment{"os": "linux"}}},
	}
	cs := compile(s)
	legal := [][]int{
		{0, 0, 0}, // linux chrome mysql
		{1, 0, 1}, // win chrome pg
		{0, 1, 1}, // linux safari pg
	}
	for _, cfg := range legal {
		if !cs.Legal(cfg) {
			t.Fatalf("expected legal: %v", cfg)
		}
	}
	illegal := [][]int{
		{1, 1, 1}, // win safari pg: forbidden
		{1, 0, 0}, // win chrome mysql: precondition violated
		{0, -1, 0},
	}
	for _, cfg := range illegal {
		if cs.Legal(cfg) {
			t.Fatalf("expected illegal: %v", cfg)
		}
	}
}

func TestSearchComplete(t *testing.T) {
	s := spec3x2()
	cs := compile(s)
	cfg, ok := search(cs, []DimVal{{0, 0}, {1, 1}})
	if !ok || cfg[0] != 0 || cfg[1] != 1 {
		t.Fatalf("search failed: %v %v", cfg, ok)
	}
	// Force an impossible combination via forbidden on all extensions.
	s2 := &Spec{
		Dimensions: spec3x2().Dimensions,
		Forbidden: []Assignment{
			{"a": "a1", "b": "b1", "c": "c1"},
			{"a": "a1", "b": "b1", "c": "c2"},
		},
	}
	cs2 := compile(s2)
	if _, ok := search(cs2, []DimVal{{0, 0}, {1, 0}}); ok {
		t.Fatal("search succeeded on uncoverable pair (a1,b1)")
	}
}

func TestUncoverableViaPrecondition(t *testing.T) {
	s := &Spec{
		Dimensions: []Dimension{
			{Name: "a", Values: []string{"a1", "a2"}},
			{Name: "b", Values: []string{"b1", "b2"}},
		},
		Preconditions: []Precondition{{When: Assignment{"b": "b1"}, Require: Assignment{"a": "a2"}}},
	}
	cs := compile(s)
	if Coverable(cs, Pair{0, 0, 1, 0}) { // a1 & b1
		t.Fatal("(a1,b1) should be uncoverable under precondition b1 -> a2")
	}
	if !Coverable(cs, Pair{0, 1, 1, 0}) { // a2 & b1
		t.Fatal("(a2,b1) should be coverable")
	}
}

func TestGreedyCoversAll(t *testing.T) {
	s := spec3x2()
	cs := compile(s)
	pairs := AllPairs(s)
	configs, cover, leftover := GreedyCover(cs, pairs, 30)
	if len(leftover) != 0 {
		t.Fatalf("leftover pairs: %v", leftover)
	}
	if len(cover) != len(pairs) {
		t.Fatalf("covered %d of %d pairs", len(cover), len(pairs))
	}
	for _, cfg := range configs {
		if !cs.Legal(cfg) {
			t.Fatalf("greedy produced illegal config %v", cfg)
		}
	}
	if len(configs) != 4 {
		t.Fatalf("expected 4 configs for 3x2, got %d", len(configs))
	}
}

func TestGreedyRespectsCap(t *testing.T) {
	s := spec3x2()
	cs := compile(s)
	pairs := AllPairs(s)
	configs, _, leftover := GreedyCover(cs, pairs, 2)
	if len(configs) != 2 {
		t.Fatalf("expected exactly 2 configs, got %d", len(configs))
	}
	if len(leftover) == 0 {
		t.Fatal("expected leftover pairs with cap 2")
	}
	for _, p := range leftover {
		if !Coverable(cs, p) {
			t.Fatalf("leftover pair %v is actually uncoverable", p)
		}
	}
}

func TestExactMinCover(t *testing.T) {
	s := spec3x2()
	cs := compile(s)
	pairs := AllPairs(s)
	legal, ok := EnumerateLegal(cs, 100)
	if !ok || len(legal) != 8 {
		t.Fatalf("expected 8 legal configs, got %d (ok=%v)", len(legal), ok)
	}
	opt, size := ExactMinCover(legal, pairs, 8)
	if size != 4 {
		t.Fatalf("expected optimal size 4, got %d", size)
	}
	if len(opt) != 4 {
		t.Fatalf("expected 4 optimal configs, got %d", len(opt))
	}
	// Verify the optimal set really covers everything.
	covered := map[Pair]bool{}
	for _, cfg := range opt {
		for _, p := range pairsOf(cfg) {
			covered[p] = true
		}
	}
	if len(covered) != len(pairs) {
		t.Fatalf("optimal set covers %d of %d pairs", len(covered), len(pairs))
	}
	// upperBound == optimal size must prove minimality (returns nil configs).
	if _, size := ExactMinCover(legal, pairs, 4); size != 4 {
		t.Fatalf("minimality proof failed, got size %d", size)
	}
}

func TestEnumerateLegalLimit(t *testing.T) {
	s := spec3x2()
	cs := compile(s)
	if _, ok := EnumerateLegal(cs, 3); ok {
		t.Fatal("expected limit overflow to report ok=false")
	}
}
