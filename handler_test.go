package bchandler

import (
	"math/rand"
	"reflect"
	"sort"
	"testing"
)

func h(name string, start, end int) Handler {
	return Handler{Name: name, Start: start, End: end}
}

func ordered(hs ...Handler) []Handler { return NewHandlers(hs) }

func TestValidateHandlers(t *testing.T) {
	tests := []struct {
		name    string
		hs      []Handler
		codeLen int
		wantErr bool
	}{
		{"empty", nil, 4, false},
		{"nested", ordered(h("a", 0, 8), h("b", 2, 5), h("c", 3, 4)), 8, false},
		{"disjoint", ordered(h("a", 0, 2), h("b", 2, 4), h("c", 5, 6)), 6, false},
		{"touching", ordered(h("a", 0, 2), h("b", 2, 4)), 4, false},
		{"identical", ordered(h("a", 1, 3), h("b", 1, 3)), 4, false},
		{"shared start", ordered(h("a", 0, 6), h("b", 0, 3)), 6, false},
		{"shared end", ordered(h("a", 0, 6), h("b", 3, 6)), 6, false},
		{"crossing", ordered(h("a", 0, 3), h("b", 2, 5)), 6, true},
		{"crossing reversed", ordered(h("b", 2, 5), h("a", 0, 3)), 6, true},
		{"empty interval", ordered(h("a", 2, 2)), 4, true},
		{"inverted interval", ordered(h("a", 3, 2)), 4, true},
		{"negative start", ordered(h("a", -1, 2)), 4, true},
		{"end beyond code", ordered(h("a", 0, 5)), 4, true},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			err := ValidateHandlers(tt.hs, tt.codeLen)
			if (err != nil) != tt.wantErr {
				t.Fatalf("ValidateHandlers() err = %v, wantErr %v", err, tt.wantErr)
			}
		})
	}
}

func chainOrders(chain []Handler) []int {
	out := make([]int, len(chain))
	for i, h := range chain {
		out[i] = h.Order
	}
	return out
}

func TestChainOrdering(t *testing.T) {
	hs := ordered(
		h("outer", 0, 8), // 0
		h("mid", 2, 5),   // 1
		h("mid2", 2, 5),  // 2: same level as mid, declared later
		h("inner", 3, 4), // 3
		h("other", 6, 7), // 4
	)
	if err := ValidateHandlers(hs, 8); err != nil {
		t.Fatal(err)
	}
	forest := BuildForest(hs)
	tests := []struct {
		pc   int
		want []int // handler declaration orders, innermost first
	}{
		{0, []int{0}},
		{2, []int{1, 2, 0}},    // mid before mid2: same level, smaller order first
		{3, []int{3, 1, 2, 0}}, // innermost first
		{5, []int{0}},
		{6, []int{4, 0}},
		{7, []int{0}}, // half-open: "other" [6,7) excludes pc 7
	}
	for _, tt := range tests {
		got := chainOrders(Chain(forest, tt.pc))
		if !reflect.DeepEqual(got, tt.want) {
			t.Errorf("Chain(pc=%d) = %v, want %v", tt.pc, got, tt.want)
		}
	}
}

// genLaminar appends a random laminar set of intervals within [lo, hi).
func genLaminar(r *rand.Rand, lo, hi int, depth int, out *[]Handler) {
	if depth > 8 || len(*out) > 60 {
		return
	}
	pos := lo
	for pos < hi {
		if r.Intn(2) == 0 { // leave a gap
			pos++
			continue
		}
		a := pos
		b := a + 1 + r.Intn(hi-a)
		*out = append(*out, Handler{Start: a, End: b})
		if r.Intn(4) == 0 { // duplicate: same level, later declaration
			*out = append(*out, Handler{Start: a, End: b})
		}
		genLaminar(r, a, b, depth+1, out)
		pos = b
	}
}

func randomValidSet(r *rand.Rand, codeLen int) []Handler {
	var hs []Handler
	genLaminar(r, 0, codeLen, 0, &hs)
	r.Shuffle(len(hs), func(i, j int) { hs[i], hs[j] = hs[j], hs[i] })
	return NewHandlers(hs)
}

func TestChainMatchesReference(t *testing.T) {
	r := rand.New(rand.NewSource(1))
	for iter := 0; iter < 500; iter++ {
		codeLen := 1 + r.Intn(24)
		hs := randomValidSet(r, codeLen)
		if err := ValidateHandlers(hs, codeLen); err != nil {
			t.Fatalf("iter %d: generated set invalid: %v", iter, err)
		}
		forest := BuildForest(hs)
		for pc := 0; pc < codeLen; pc++ {
			got := chainOrders(Chain(forest, pc))
			want := chainOrders(ChainReference(hs, pc))
			if !reflect.DeepEqual(got, want) {
				t.Fatalf("iter %d pc %d: Chain = %v, reference = %v (handlers %v)", iter, pc, got, want, hs)
			}
		}
	}
}

// TestChainMatchesReferenceArbitrary feeds arbitrary (possibly crossing)
// interval sets and cross-checks the two implementations whenever the set
// passes validation.
func TestChainMatchesReferenceArbitrary(t *testing.T) {
	r := rand.New(rand.NewSource(2))
	valid := 0
	for iter := 0; iter < 2000; iter++ {
		codeLen := 1 + r.Intn(16)
		n := r.Intn(8)
		raw := make([]Handler, n)
		for i := range raw {
			a := r.Intn(codeLen)
			b := a + 1 + r.Intn(codeLen-a)
			raw[i] = h("", a, b)
		}
		hs := NewHandlers(raw)
		if err := ValidateHandlers(hs, codeLen); err != nil {
			continue
		}
		valid++
		forest := BuildForest(hs)
		for pc := 0; pc < codeLen; pc++ {
			got := chainOrders(Chain(forest, pc))
			want := chainOrders(ChainReference(hs, pc))
			if !reflect.DeepEqual(got, want) {
				t.Fatalf("iter %d pc %d: Chain = %v, reference = %v (handlers %v)", iter, pc, got, want, hs)
			}
		}
	}
	if valid == 0 {
		t.Fatal("no valid sets generated")
	}
}

func TestInsertInstructions(t *testing.T) {
	tests := []struct {
		name      string
		hs        []Handler
		at, count int
		wantStart []int
		wantEnd   []int
		wantErr   bool
	}{
		{"before", ordered(h("a", 0, 2)), 3, 2, []int{0}, []int{2}, false},
		{"after", ordered(h("a", 3, 5)), 2, 2, []int{5}, []int{7}, false},
		{"inside expands", ordered(h("a", 0, 5)), 2, 3, []int{0}, []int{8}, false},
		{"at start excluded", ordered(h("a", 2, 5)), 2, 3, []int{5}, []int{8}, false},
		{"at end excluded", ordered(h("a", 0, 2)), 2, 3, []int{0}, []int{2}, false},
		{"zero count", ordered(h("a", 0, 5)), 2, 0, []int{0}, []int{5}, false},
		{"negative count", ordered(h("a", 0, 5)), 2, -1, nil, nil, true},
		{"negative at", ordered(h("a", 0, 5)), -1, 2, nil, nil, true},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got, err := InsertInstructions(tt.hs, tt.at, tt.count)
			if (err != nil) != tt.wantErr {
				t.Fatalf("err = %v, wantErr %v", err, tt.wantErr)
			}
			if tt.wantErr {
				return
			}
			for i, gh := range got {
				if gh.Start != tt.wantStart[i] || gh.End != tt.wantEnd[i] {
					t.Errorf("handler %d: got [%d,%d), want [%d,%d)", i, gh.Start, gh.End, tt.wantStart[i], tt.wantEnd[i])
				}
			}
		})
	}
}

// TestInsertPreservesChains inserts instructions into random valid sets and
// checks, against the per-interval reference, that old instructions keep
// their chains and inserted instructions are covered exactly by handlers
// strictly containing the insertion point.
func TestInsertPreservesChains(t *testing.T) {
	r := rand.New(rand.NewSource(3))
	for iter := 0; iter < 500; iter++ {
		codeLen := 1 + r.Intn(20)
		hs := randomValidSet(r, codeLen)
		at := r.Intn(codeLen + 1)
		count := r.Intn(5)

		remapped, err := InsertInstructions(hs, at, count)
		if err != nil {
			t.Fatalf("iter %d: %v", iter, err)
		}
		newLen := codeLen + count
		if err := ValidateHandlers(remapped, newLen); err != nil {
			t.Fatalf("iter %d: remapped set invalid: %v (at=%d count=%d hs=%v)", iter, err, at, count, hs)
		}
		forest := BuildForest(remapped)

		// Old instructions keep their effective chains.
		for pc := 0; pc < codeLen; pc++ {
			mapped := pc
			if pc >= at {
				mapped += count
			}
			got := chainOrders(Chain(forest, mapped))
			want := chainOrders(ChainReference(hs, pc))
			if !reflect.DeepEqual(got, want) {
				t.Fatalf("iter %d: old pc %d -> %d: got %v, want %v (at=%d count=%d hs=%v)",
					iter, pc, mapped, got, want, at, count, hs)
			}
		}
		// Inserted instructions are covered iff the handler strictly
		// contained the insertion point; the expected chain is those
		// handlers in priority order.
		var covering []Handler
		for _, hh := range hs {
			if hh.Start < at && at < hh.End {
				covering = append(covering, hh)
			}
		}
		sort.Slice(covering, func(i, j int) bool { return higherPriority(covering[i], covering[j]) })
		want := chainOrders(covering)
		for pc := at; pc < at+count; pc++ {
			got := chainOrders(Chain(forest, pc))
			if !reflect.DeepEqual(got, want) {
				t.Fatalf("iter %d: inserted pc %d: got %v, want %v (at=%d count=%d hs=%v)",
					iter, pc, got, want, at, count, hs)
			}
		}
	}
}
