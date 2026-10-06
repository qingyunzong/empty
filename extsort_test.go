package jsoncanon

import (
	"errors"
	"fmt"
	"math/rand"
	"strings"
	"testing"
)

// makeFlatObject builds {"k000":v0,...} with n members in shuffled order.
func makeFlatObject(r *rand.Rand, n int) *Value {
	v := &Value{Kind: KindObject}
	perm := r.Perm(n)
	for _, i := range perm {
		key := fmt.Sprintf("k%04d", i)
		val := &Value{Kind: KindNumber, Num: fmt.Sprintf("%d.%03d", i, r.Intn(1000))}
		v.Obj = append(v.Obj, Member{Key: key, Value: val})
	}
	return v
}

func TestExternalSortMatchesInMemory(t *testing.T) {
	r := rand.New(rand.NewSource(7))
	v := makeFlatObject(r, 500)
	want, _, err := Canonicalize(v, nil)
	if err != nil {
		t.Fatal(err)
	}
	for _, budget := range []int64{1, 64, 256, 4096} {
		dir := t.TempDir()
		got, _, err := Canonicalize(v, &Options{MemBudget: budget, TempDir: dir})
		if err != nil {
			t.Fatalf("budget %d: %v", budget, err)
		}
		if string(got) != string(want) {
			t.Fatalf("budget %d: external sort output differs from in-memory", budget)
		}
	}
	if !strings.HasPrefix(string(want), `{"k0000":`) {
		t.Fatalf("unexpected canonical prefix: %.40s", want)
	}
}

func TestExternalSortDeepTree(t *testing.T) {
	// Nested objects each exceeding the budget must also sort externally.
	src := `{"z": {"d": 1, "c": 2, "b": 3, "a": 4}, "a": [{"y": 1, "x": 2}]}`
	v := mustParse(t, src)
	want := canonString(t, src, nil)
	got, _, err := Canonicalize(v, &Options{MemBudget: 1, TempDir: t.TempDir()})
	if err != nil {
		t.Fatal(err)
	}
	if string(got) != want {
		t.Fatalf("got %s want %s", got, want)
	}
}

func TestDuplicateKeyAcrossSegments(t *testing.T) {
	// Budget 1 forces every member into its own segment, so the duplicate
	// "b" keys land in different segments and must be caught at merge time.
	src := `{"b": 1, "a": 2, "c": 3, "b": 4}`
	v := mustParse(t, src)
	_, _, err := Canonicalize(v, &Options{MemBudget: 1, TempDir: t.TempDir()})
	var de *DuplicateKeyError
	if !errors.As(err, &de) {
		t.Fatalf("got %v, want DuplicateKeyError", err)
	}
	if de.Key != "b" {
		t.Fatalf("duplicate key %q, want %q", de.Key, "b")
	}
}

func TestDuplicateKeyWithinSegment(t *testing.T) {
	src := `{"a": 1, "a": 2}`
	v := mustParse(t, src)
	_, _, err := Canonicalize(v, &Options{MemBudget: 1 << 20, TempDir: t.TempDir()})
	var de *DuplicateKeyError
	if !errors.As(err, &de) {
		t.Fatalf("got %v, want DuplicateKeyError", err)
	}
}

// TestLowBudgetVsFullMemoryRandom is the randomized对照: canonical output
// with a tiny memory budget must be byte-identical to full-memory output.
func TestLowBudgetVsFullMemoryRandom(t *testing.T) {
	for seed := int64(0); seed < 100; seed++ {
		r := rand.New(rand.NewSource(1000 + seed))
		tree := randValue(r, 0)
		src := toJSONC(r, tree)
		v, err := Parse([]byte(src))
		if err != nil {
			t.Fatalf("seed %d: %v", seed, err)
		}
		full, _, err := Canonicalize(v, nil)
		if err != nil {
			t.Fatalf("seed %d full: %v", seed, err)
		}
		low, _, err := Canonicalize(v, &Options{MemBudget: 8, TempDir: t.TempDir()})
		if err != nil {
			t.Fatalf("seed %d low: %v", seed, err)
		}
		if string(full) != string(low) {
			t.Fatalf("seed %d: low-budget output differs\nfull: %s\nlow:  %s", seed, full, low)
		}
	}
}

func TestExternalSortSpans(t *testing.T) {
	src := `{"b": 10, "a": [1, {"q": 2}], "c": "x"}`
	v := mustParse(t, src)
	res := map[string]Span{}
	_, out, err := Canonicalize(v, &Options{MemBudget: 1, TempDir: t.TempDir(), CollectSpans: true})
	if err != nil {
		t.Fatal(err)
	}
	for _, se := range out.Spans {
		res[se.Path] = Span{se.Start, se.End}
	}
	checks := map[string]string{
		"/a":     `[1, {"q": 2}]`,
		"/a/0":   `1`,
		"/a/1":   `{"q": 2}`,
		"/a/1/q": `2`,
		"/b":     `10`,
		"/c":     `"x"`,
	}
	for path, text := range checks {
		sp, ok := res[path]
		if !ok {
			t.Fatalf("missing span for %q", path)
		}
		if got := src[sp.Start:sp.End]; got != text {
			t.Errorf("path %q: got %q want %q", path, got, text)
		}
	}
}
