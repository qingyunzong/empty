package matrix

import (
	"errors"
	"math/big"
	"math/rand"
	"strings"
	"testing"
)

func mustSpec(t *testing.T, js string) *Spec {
	t.Helper()
	spec, err := LoadSpec(strings.NewReader(js))
	if err != nil {
		t.Fatalf("LoadSpec: %v", err)
	}
	return spec
}

func TestLegalityConstraints(t *testing.T) {
	spec := mustSpec(t, `{
	  "dimensions": [
	    {"name": "os", "values": ["linux", "mac", "win"]},
	    {"name": "browser", "values": ["chrome", "safari", "ie"]}
	  ],
	  "forbidden": [{"os": "mac", "browser": "ie"}],
	  "requires": [{"if": {"browser": "safari"}, "then": {"os": "mac"}}]
	}`)
	m, err := buildModel(spec)
	if err != nil {
		t.Fatal(err)
	}
	cases := []struct {
		assign []int // os, browser value indices
		want   bool
	}{
		{[]int{0, 0}, true},  // linux/chrome
		{[]int{0, 1}, false}, // linux/safari violates requires
		{[]int{1, 1}, true},  // mac/safari
		{[]int{1, 2}, false}, // mac/ie forbidden
		{[]int{2, 2}, true},  // win/ie
		{[]int{2, 1}, false}, // win/safari violates requires
	}
	for _, c := range cases {
		if got := m.legal(c.assign); got != c.want {
			t.Errorf("legal(%v) = %v, want %v", c.assign, got, c.want)
		}
	}
}

func TestSolveCoversAllPairs(t *testing.T) {
	spec := mustSpec(t, `{
	  "dimensions": [
	    {"name": "os", "values": ["linux", "mac", "win"]},
	    {"name": "browser", "values": ["chrome", "firefox", "safari"]},
	    {"name": "db", "values": ["pg", "mysql"]}
	  ],
	  "forbidden": [{"os": "win", "browser": "safari"}],
	  "requires": [{"if": {"browser": "safari"}, "then": {"os": "mac"}}]
	}`)
	cert, err := Solve(spec, 30)
	if err != nil {
		t.Fatalf("Solve: %v", err)
	}
	if err := cert.Verify(spec); err != nil {
		t.Fatalf("Verify: %v", err)
	}
	if cert.Minimality != "exact" {
		t.Errorf("minimality = %q, want exact", cert.Minimality)
	}
	// safari requires mac, so (linux,safari) and (win,safari) are uncoverable.
	if len(cert.Uncoverable) != 2 {
		t.Errorf("uncoverable = %+v, want 2 pairs", cert.Uncoverable)
	}
	// 7 coverable os-browser pairs force >= 7 configs; safari appears in only
	// one os pairing, so covering (safari,pg) and (safari,mysql) needs one
	// more: minimum is 8.
	if len(cert.Configs) != 8 {
		t.Errorf("got %d configs, want 8", len(cert.Configs))
	}
}

func TestUncoverablePairsListedSeparately(t *testing.T) {
	// a=x forces c=p, but b=u together with c=p is forbidden, so the pair
	// (a=x, b=u) can never appear in any legal configuration.
	spec := mustSpec(t, `{
	  "dimensions": [
	    {"name": "a", "values": ["x", "y"]},
	    {"name": "b", "values": ["u", "v"]},
	    {"name": "c", "values": ["p", "q"]}
	  ],
	  "forbidden": [{"b": "u", "c": "p"}],
	  "requires": [{"if": {"a": "x"}, "then": {"c": "p"}}]
	}`)
	cert, err := Solve(spec, 30)
	if err != nil {
		t.Fatalf("Solve: %v", err)
	}
	if err := cert.Verify(spec); err != nil {
		t.Fatalf("Verify: %v", err)
	}
	// Uncoverable: (a=x,b=u) by design; (a=x,c=q) since a=x forces c=p;
	// (b=u,c=p) since it is directly forbidden.
	want := []Pair{
		{Dim1: "a", Val1: "x", Dim2: "b", Val2: "u"},
		{Dim1: "a", Val1: "x", Dim2: "c", Val2: "q"},
		{Dim1: "b", Val1: "u", Dim2: "c", Val2: "p"},
	}
	if len(cert.Uncoverable) != len(want) {
		t.Fatalf("uncoverable = %+v, want %+v", cert.Uncoverable, want)
	}
	got := map[Pair]bool{}
	for _, p := range cert.Uncoverable {
		got[p] = true
	}
	for _, w := range want {
		if !got[w] {
			t.Errorf("missing uncoverable pair %+v in %+v", w, cert.Uncoverable)
		}
	}
	for _, e := range cert.Coverage {
		if got[e.Pair] {
			t.Errorf("uncoverable pair %+v appears in coverage", e.Pair)
		}
	}
}

func TestConfigLimit(t *testing.T) {
	// Two 6-value dimensions have 36 pairs and each config covers exactly
	// one of them, so 36 configs are needed, exceeding the limit of 30.
	var b strings.Builder
	b.WriteString(`{"dimensions":[{"name":"a","values":[`)
	for i := 0; i < 6; i++ {
		if i > 0 {
			b.WriteByte(',')
		}
		b.WriteString(`"a` + strings.Repeat("x", i+1) + `"`)
	}
	b.WriteString(`]},{"name":"b","values":[`)
	for i := 0; i < 6; i++ {
		if i > 0 {
			b.WriteByte(',')
		}
		b.WriteString(`"b` + strings.Repeat("y", i+1) + `"`)
	}
	b.WriteString(`]}]}`)
	spec := mustSpec(t, b.String())
	_, err := Solve(spec, 30)
	var limit *ErrLimit
	if !errors.As(err, &limit) {
		t.Fatalf("Solve error = %v, want ErrLimit", err)
	}
	if limit.Needed != 36 || limit.Limit != 30 {
		t.Errorf("ErrLimit = %+v, want Needed=36 Limit=30", limit)
	}
}

func TestInvalidSpecs(t *testing.T) {
	bad := []string{
		`{"dimensions": []}`,
		`{"dimensions": [{"name": "a", "values": []}]}`,
		`{"dimensions": [{"name": "a", "values": ["x"]}, {"name": "a", "values": ["y"]}]}`,
		`{"dimensions": [{"name": "a", "values": ["x"]}], "forbidden": [{"b": "u"}]}`,
		`{"dimensions": [{"name": "a", "values": ["x"]}], "forbidden": [{"a": "z"}]}`,
		`{"dimensions": [{"name": "a", "values": ["x"]}], "requires": [{"if": {"a": "x"}, "then": {}}]}`,
	}
	for _, js := range bad {
		if _, err := LoadSpec(strings.NewReader(js)); err == nil {
			t.Errorf("LoadSpec(%s) succeeded, want error", js)
		}
	}
}

// bruteForceMin enumerates every subset of the legal configurations and
// returns the size of the smallest subset covering all coverable pairs.
func bruteForceMin(t *testing.T, spec *Spec) int {
	t.Helper()
	m, err := buildModel(spec)
	if err != nil {
		t.Fatal(err)
	}
	legal, err := m.enumerateLegal()
	if err != nil {
		t.Fatal(err)
	}
	masks := make([]*big.Int, len(legal))
	full := new(big.Int)
	for i, cfg := range legal {
		masks[i] = m.pairMask(cfg)
		full.Or(full, masks[i])
	}
	if len(legal) > 20 {
		t.Fatalf("too many legal configs (%d) for exhaustive subset enumeration", len(legal))
	}
	best := -1
	for subset := 0; subset < (1 << len(legal)); subset++ {
		if best >= 0 && popcountBits(subset) >= best {
			continue
		}
		cover := new(big.Int)
		for i := range legal {
			if subset&(1<<i) != 0 {
				cover.Or(cover, masks[i])
			}
		}
		if cover.Cmp(full) == 0 {
			best = popcountBits(subset)
		}
	}
	return best
}

func popcountBits(x int) int {
	n := 0
	for x != 0 {
		x &= x - 1
		n++
	}
	return n
}

// TestExhaustiveSmallSpecs cross-checks the solver against full subset
// enumeration on many small random specs: the solver's config count must
// equal the brute-force minimum, and every certificate must verify.
func TestExhaustiveSmallSpecs(t *testing.T) {
	rng := rand.New(rand.NewSource(20261005))
	checked := 0
	for trial := 0; trial < 400 && checked < 60; trial++ {
		spec := randomSpec(rng)
		m, err := buildModel(spec)
		if err != nil {
			t.Fatalf("trial %d: %v", trial, err)
		}
		legal, err := m.enumerateLegal()
		if err != nil {
			t.Fatalf("trial %d: %v", trial, err)
		}
		if len(legal) == 0 || len(legal) > 16 {
			continue // keep exhaustive enumeration cheap
		}
		checked++
		cert, err := Solve(spec, 30)
		if err != nil {
			t.Fatalf("trial %d: Solve: %v", trial, err)
		}
		if err := cert.Verify(spec); err != nil {
			t.Fatalf("trial %d: Verify: %v", trial, err)
		}
		want := bruteForceMin(t, spec)
		if got := len(cert.Configs); got != want {
			t.Fatalf("trial %d: solver used %d configs, exhaustive minimum is %d\nspec: %+v",
				trial, got, want, spec)
		}
		if cert.Minimality != "exact" {
			t.Errorf("trial %d: minimality = %q, want exact", trial, cert.Minimality)
		}
	}
	if checked == 0 {
		t.Fatal("no small specs were checked")
	}
	t.Logf("cross-checked %d small specs against exhaustive subset enumeration", checked)
}

// randomSpec builds a small random spec: 2-4 dimensions of 2-3 values, a few
// random forbidden pairs and single-dimension preconditions.
func randomSpec(rng *rand.Rand) *Spec {
	numDims := 2 + rng.Intn(3)
	spec := &Spec{}
	for d := 0; d < numDims; d++ {
		dim := Dimension{Name: string(rune('a' + d))}
		for v := 0; v < 2+rng.Intn(2); v++ {
			dim.Values = append(dim.Values, string(rune('a'+d))+string(rune('0'+v)))
		}
		spec.Dimensions = append(spec.Dimensions, dim)
	}
	randAssign := func() Assignment {
		a := Assignment{}
		d := rng.Intn(numDims)
		a[spec.Dimensions[d].Name] = spec.Dimensions[d].Values[rng.Intn(len(spec.Dimensions[d].Values))]
		return a
	}
	for i := 0; i < rng.Intn(3); i++ {
		// Forbidden combination over two distinct dimensions.
		d1, d2 := rng.Intn(numDims), rng.Intn(numDims)
		if d1 == d2 {
			continue
		}
		f := Assignment{}
		f[spec.Dimensions[d1].Name] = spec.Dimensions[d1].Values[rng.Intn(len(spec.Dimensions[d1].Values))]
		f[spec.Dimensions[d2].Name] = spec.Dimensions[d2].Values[rng.Intn(len(spec.Dimensions[d2].Values))]
		spec.Forbidden = append(spec.Forbidden, f)
	}
	for i := 0; i < rng.Intn(3); i++ {
		ifC, thenC := randAssign(), randAssign()
		conflict := false
		for dim, v := range ifC {
			if tv, ok := thenC[dim]; ok && tv != v {
				conflict = true
			}
		}
		if conflict {
			continue
		}
		spec.Requires = append(spec.Requires, Precondition{If: ifC, Then: thenC})
	}
	return spec
}

// TestVerifyRejectsTamperedCertificate ensures the checker is not vacuous.
func TestVerifyRejectsTamperedCertificate(t *testing.T) {
	spec := mustSpec(t, `{
	  "dimensions": [
	    {"name": "a", "values": ["x", "y"]},
	    {"name": "b", "values": ["u", "v"]}
	  ],
	  "forbidden": [{"a": "x", "b": "u"}]
	}`)
	cert, err := Solve(spec, 30)
	if err != nil {
		t.Fatalf("Solve: %v", err)
	}
	if err := cert.Verify(spec); err != nil {
		t.Fatalf("Verify: %v", err)
	}
	// Illegal config: the forbidden combination itself.
	bad := *cert
	bad.Configs = append([]Assignment{{"a": "x", "b": "u"}}, cert.Configs...)
	if err := bad.Verify(spec); err == nil {
		t.Error("Verify accepted a certificate containing a forbidden config")
	}
	// Missing coverage entries.
	bad2 := *cert
	bad2.Coverage = cert.Coverage[:len(cert.Coverage)-1]
	if err := bad2.Verify(spec); err == nil {
		t.Error("Verify accepted a certificate with truncated coverage")
	}
	// Bogus uncoverable entry.
	bad3 := *cert
	bad3.Uncoverable = []Pair{{Dim1: "a", Val1: "y", Dim2: "b", Val2: "v"}}
	if err := bad3.Verify(spec); err == nil {
		t.Error("Verify accepted a bogus uncoverable pair")
	}
}
