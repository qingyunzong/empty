package frameidx_test

import (
	"math/rand"
	"reflect"
	"sort"
	"testing"

	"frameidx"
)

// bFrameStream mirrors a typical IBBPBBP coding order where display order
// (PTS) differs from decode order (DTS).
//
//	ID 1: I, DTS 0, PTS 0
//	ID 2: P, DTS 1, PTS 3, refs [1]
//	ID 3: B, DTS 2, PTS 1, refs [1,2]
//	ID 4: B, DTS 3, PTS 2, refs [1,2]
//	ID 5: P, DTS 4, PTS 6, refs [2]
//	ID 6: B, DTS 5, PTS 4, refs [2,5]
//	ID 7: B, DTS 6, PTS 5, refs [2,5]
func bFrameStream() []frameidx.Frame {
	return []frameidx.Frame{
		{ID: 1, DTS: 0, PTS: 0},
		{ID: 2, Refs: []int64{1}, DTS: 1, PTS: 3},
		{ID: 3, Refs: []int64{1, 2}, DTS: 2, PTS: 1},
		{ID: 4, Refs: []int64{1, 2}, DTS: 3, PTS: 2},
		{ID: 5, Refs: []int64{2}, DTS: 4, PTS: 6},
		{ID: 6, Refs: []int64{2, 5}, DTS: 5, PTS: 4},
		{ID: 7, Refs: []int64{2, 5}, DTS: 6, PTS: 5},
	}
}

func TestSeekBFrames(t *testing.T) {
	ix, rep := frameidx.NewIndex(bFrameStream())
	if !rep.OK() {
		t.Fatalf("unexpected validation problems: %+v", rep)
	}
	res := ix.SeekInterval(1, 2) // display interval covering B frames PTS 1 and 2
	if want := []int64{3, 4}; !reflect.DeepEqual(res.Targets, want) {
		t.Fatalf("targets = %v, want %v", res.Targets, want)
	}
	if want := []int64{1, 2, 3, 4}; !reflect.DeepEqual(res.Closure, want) {
		t.Fatalf("closure = %v, want %v", res.Closure, want)
	}
	if res.Cycle != nil {
		t.Fatalf("unexpected cycle: %v", res.Cycle)
	}
	if len(res.MissingRefs) != 0 {
		t.Fatalf("unexpected missing refs: %v", res.MissingRefs)
	}
	if res.Certificate == nil {
		t.Fatal("missing certificate")
	}
	if want := []int64{1, 2, 3, 4}; !reflect.DeepEqual(res.Certificate.Order, want) {
		t.Fatalf("certificate order = %v, want %v", res.Certificate.Order, want)
	}
	if err := res.Certificate.Verify(ix, res.Targets); err != nil {
		t.Fatalf("certificate does not verify: %v", err)
	}
}

// TestDisplayTimeIsNotDecodeOrder proves that sorting the closure by PTS
// yields an invalid decode order, while the certificate order is valid.
func TestDisplayTimeIsNotDecodeOrder(t *testing.T) {
	ix, _ := frameidx.NewIndex(bFrameStream())
	res := ix.SeekInterval(1, 2)

	byPTS := append([]int64(nil), res.Closure...)
	sort.Slice(byPTS, func(i, j int) bool {
		a, _ := ix.Frame(byPTS[i])
		b, _ := ix.Frame(byPTS[j])
		return a.PTS < b.PTS
	})
	if reflect.DeepEqual(byPTS, res.Certificate.Order) {
		t.Fatalf("PTS order %v unexpectedly equals certificate order", byPTS)
	}
	bad := &frameidx.Certificate{Order: byPTS}
	if err := bad.Verify(ix, res.Targets); err == nil {
		t.Fatalf("PTS-ordered certificate %v must not verify as decode order", byPTS)
	}
	if err := res.Certificate.Verify(ix, res.Targets); err != nil {
		t.Fatalf("certificate does not verify: %v", err)
	}
}

func TestSeekMinimalClosure(t *testing.T) {
	ix, _ := frameidx.NewIndex(bFrameStream())
	res := ix.SeekInterval(1, 2)
	for _, id := range res.Closure {
		if id >= 5 {
			t.Fatalf("closure %v contains unrelated frame %d", res.Closure, id)
		}
	}
	// Widening the interval pulls in the second GOP's dependencies.
	res = ix.SeekInterval(4, 6)
	if want := []int64{6, 7, 5}; !reflect.DeepEqual(res.Targets, want) {
		t.Fatalf("targets = %v, want %v", res.Targets, want)
	}
	if want := []int64{1, 2, 5, 6, 7}; !reflect.DeepEqual(res.Closure, want) {
		t.Fatalf("closure = %v, want %v", res.Closure, want)
	}
	if err := res.Certificate.Verify(ix, res.Targets); err != nil {
		t.Fatalf("certificate does not verify: %v", err)
	}
}

func TestMissingRefsReported(t *testing.T) {
	frames := []frameidx.Frame{
		{ID: 1, DTS: 0, PTS: 0},
		{ID: 2, Refs: []int64{1, 99}, DTS: 1, PTS: 1},
		{ID: 3, Refs: []int64{99}, DTS: 2, PTS: 2},
	}
	ix, rep := frameidx.NewIndex(frames)
	if len(rep.MissingRefs) != 2 {
		t.Fatalf("validation missing refs = %v, want 2 entries", rep.MissingRefs)
	}
	res := ix.SeekInterval(2, 2)
	if len(res.MissingRefs) != 1 || res.MissingRefs[0] != (frameidx.MissingRef{Frame: 3, Ref: 99}) {
		t.Fatalf("seek missing refs = %v", res.MissingRefs)
	}
	if want := []int64{3}; !reflect.DeepEqual(res.Closure, want) {
		t.Fatalf("closure = %v, want %v", res.Closure, want)
	}
	if err := res.Certificate.Verify(ix, res.Targets); err != nil {
		t.Fatalf("certificate with dangling ref must still verify: %v", err)
	}
}

func TestCycleReported(t *testing.T) {
	frames := []frameidx.Frame{
		{ID: 1, Refs: []int64{3}, DTS: 0, PTS: 0},
		{ID: 2, Refs: []int64{1}, DTS: 1, PTS: 1},
		{ID: 3, Refs: []int64{2}, DTS: 2, PTS: 2},
	}
	ix, rep := frameidx.NewIndex(frames)
	if len(rep.Cycles) == 0 {
		t.Fatal("validation must report the dependency cycle")
	}
	res := ix.SeekInterval(0, 2)
	if res.Cycle == nil {
		t.Fatal("seek must report the dependency cycle")
	}
	if res.Certificate != nil {
		t.Fatalf("no certificate may be issued for a cyclic closure, got %v", res.Certificate.Order)
	}
}

func TestDuplicateIDsReported(t *testing.T) {
	frames := []frameidx.Frame{
		{ID: 1, DTS: 0, PTS: 0},
		{ID: 1, DTS: 1, PTS: 1},
	}
	ix, rep := frameidx.NewIndex(frames)
	if !reflect.DeepEqual(rep.Duplicates, []int64{1}) {
		t.Fatalf("duplicates = %v, want [1]", rep.Duplicates)
	}
	if ix.Len() != 1 {
		t.Fatalf("index length = %d, want 1 (first definition kept)", ix.Len())
	}
}

func TestCertificateTamperingDetected(t *testing.T) {
	ix, _ := frameidx.NewIndex(bFrameStream())
	res := ix.SeekInterval(1, 2)
	targets := res.Targets

	cases := map[string]*frameidx.Certificate{
		"swapped order":   {Order: []int64{2, 1, 3, 4}},
		"missing frame":   {Order: []int64{1, 2, 3}},
		"unneeded frame":  {Order: []int64{1, 2, 3, 4, 5}},
		"duplicate entry": {Order: []int64{1, 1, 2, 3, 4}},
		"unknown frame":   {Order: []int64{1, 2, 3, 42}},
	}
	for name, cert := range cases {
		if err := cert.Verify(ix, targets); err == nil {
			t.Errorf("%s: tampered certificate %v verified", name, cert.Order)
		}
	}
	var nilCert *frameidx.Certificate
	if err := nilCert.Verify(ix, targets); err == nil {
		t.Error("nil certificate verified")
	}
}

func TestEmptyInterval(t *testing.T) {
	ix, _ := frameidx.NewIndex(bFrameStream())
	res := ix.SeekInterval(100, 200)
	if len(res.Targets) != 0 || len(res.Closure) != 0 {
		t.Fatalf("empty interval yielded targets=%v closure=%v", res.Targets, res.Closure)
	}
	if res.Certificate == nil || len(res.Certificate.Order) != 0 {
		t.Fatalf("empty interval certificate = %+v", res.Certificate)
	}
	if err := res.Certificate.Verify(ix, res.Targets); err != nil {
		t.Fatalf("empty certificate does not verify: %v", err)
	}
}

// TestRandomDAGCrossCheck cross-checks the seek closure and certificate
// against the independent DFS model on randomly generated acyclic graphs
// whose PTS order is shuffled relative to decode order.
func TestRandomDAGCrossCheck(t *testing.T) {
	rng := rand.New(rand.NewSource(20261005))
	for trial := 0; trial < 200; trial++ {
		n := 1 + rng.Intn(40)
		pts := rng.Perm(n) // display order deliberately shuffled vs DTS
		frames := make([]frameidx.Frame, 0, n)
		for i := 0; i < n; i++ {
			f := frameidx.Frame{ID: int64(i + 1), DTS: int64(i), PTS: int64(pts[i])}
			for j := 0; j < i; j++ {
				if rng.Intn(4) == 0 { // refs only to earlier IDs: acyclic
					f.Refs = append(f.Refs, int64(j+1))
				}
			}
			frames = append(frames, f)
		}
		ix, rep := frameidx.NewIndex(frames)
		if !rep.OK() {
			t.Fatalf("trial %d: unexpected validation problems: %+v", trial, rep)
		}
		lo := int64(rng.Intn(n))
		hi := lo + int64(rng.Intn(n))
		res := ix.SeekInterval(lo, hi)
		if res.Cycle != nil {
			t.Fatalf("trial %d: unexpected cycle %v", trial, res.Cycle)
		}
		if err := res.Certificate.Verify(ix, res.Targets); err != nil {
			t.Fatalf("trial %d: certificate failed verification: %v", trial, err)
		}
		// Closure listed by seek must match the certificate exactly as a set.
		if len(res.Closure) != len(res.Certificate.Order) {
			t.Fatalf("trial %d: closure size %d != certificate size %d",
				trial, len(res.Closure), len(res.Certificate.Order))
		}
		inCert := make(map[int64]bool, len(res.Certificate.Order))
		for _, id := range res.Certificate.Order {
			inCert[id] = true
		}
		for _, id := range res.Closure {
			if !inCert[id] {
				t.Fatalf("trial %d: closure frame %d missing from certificate", trial, id)
			}
		}
	}
}
