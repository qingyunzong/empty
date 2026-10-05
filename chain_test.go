package main

import (
	"fmt"
	"math/rand"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// buildChain returns a linear chain of n records with the given payloads.
func buildChain(payloads ...string) []Record {
	var out []Record
	prev := ""
	for _, p := range payloads {
		out = append(out, Record{Digest: ComputeDigest(prev, p), Prev: prev, Payload: p})
		prev = out[len(out)-1].Digest
	}
	return out
}

// writeSegments splits recs at the given cut points and writes each part
// as a .seg file in dir, in the order given.
func writeSegments(t *testing.T, dir string, segs [][]Record) []string {
	t.Helper()
	var names []string
	for i, seg := range segs {
		name := fmt.Sprintf("seg-%02d.seg", i)
		var sb strings.Builder
		for _, r := range seg {
			fmt.Fprintf(&sb, `{"digest":%q,"prev":%q,"payload":%q}`+"\n", r.Digest, r.Prev, r.Payload)
		}
		if err := os.WriteFile(filepath.Join(dir, name), []byte(sb.String()), 0o644); err != nil {
			t.Fatal(err)
		}
		names = append(names, name)
	}
	return names
}

// randomSplit splits recs into k non-empty segments (k clamped to len).
func randomSplit(r *rand.Rand, recs []Record, k int) [][]Record {
	if k > len(recs) {
		k = len(recs)
	}
	cuts := map[int]bool{}
	for len(cuts) < k-1 {
		cuts[1+r.Intn(len(recs)-1)] = true
	}
	var segs [][]Record
	start := 0
	for i := 1; i <= len(recs); i++ {
		if i == len(recs) || cuts[i] {
			segs = append(segs, recs[start:i])
			start = i
		}
	}
	return segs
}

// TestShuffledSegmentsMatchFullGraph builds a branched chain, then for
// many seeds randomly re-segments and reorders the segment files,
// verifying the full-graph check result is invariant and correct.
func TestShuffledSegmentsMatchFullGraph(t *testing.T) {
	payloads := make([]string, 40)
	for i := range payloads {
		payloads[i] = fmt.Sprintf("block-%d", i)
	}
	trunk := buildChain(payloads...)
	// Two different successors of trunk[10]: a branch, not a duplicate.
	branchA := buildChain(appendPrefix(trunk[:11], "alpha-1", "alpha-2")...)
	branchB := buildChain(appendPrefix(trunk[:11], "beta-1")...)
	all := append(append(append([]Record{}, trunk...), branchA[11:]...), branchB[11:]...)
	wantHeads := map[string]bool{
		trunk[len(trunk)-1].Digest:     true,
		branchA[len(branchA)-1].Digest: true,
		branchB[len(branchB)-1].Digest: true,
	}

	for seed := int64(0); seed < 25; seed++ {
		r := rand.New(rand.NewSource(seed))
		dir := t.TempDir()
		segs := randomSplit(r, all, 2+r.Intn(8))
		// Shuffle segment order; file names are assigned after shuffling,
		// so load order differs from chain order.
		r.Shuffle(len(segs), func(i, j int) { segs[i], segs[j] = segs[j], segs[i] })
		writeSegments(t, dir, segs)

		rep, err := Check(dir)
		if err != nil {
			t.Fatal(err)
		}
		if !rep.OK() {
			t.Fatalf("seed %d: expected OK, got %+v", seed, rep)
		}
		if rep.Records != len(all) {
			t.Fatalf("seed %d: records=%d want %d", seed, rep.Records, len(all))
		}
		if len(rep.Heads) != len(wantHeads) {
			t.Fatalf("seed %d: heads=%v", seed, rep.Heads)
		}
		for _, h := range rep.Heads {
			if !wantHeads[h] {
				t.Fatalf("seed %d: unexpected head %s", seed, h)
			}
		}
	}
}

func appendPrefix(prefix []Record, payloads ...string) []string {
	out := make([]string, 0, len(prefix)+len(payloads))
	for _, r := range prefix {
		out = append(out, r.Payload)
	}
	return append(out, payloads...)
}

// TestBranchesAreNotDuplicates ensures two different successors of the
// same record are accepted as a branch and reported as two heads.
func TestBranchesAreNotDuplicates(t *testing.T) {
	base := buildChain("genesis", "a", "b")
	parent := base[len(base)-1]
	child1 := Record{Digest: ComputeDigest(parent.Digest, "fork-1"), Prev: parent.Digest, Payload: "fork-1"}
	child2 := Record{Digest: ComputeDigest(parent.Digest, "fork-2"), Prev: parent.Digest, Payload: "fork-2"}
	dir := t.TempDir()
	writeSegments(t, dir, [][]Record{base, {child1}, {child2}})

	rep, err := Check(dir)
	if err != nil {
		t.Fatal(err)
	}
	if !rep.OK() {
		t.Fatalf("branch flagged as problem: %+v", rep)
	}
	if len(rep.Heads) != 2 {
		t.Fatalf("heads=%v, want 2", rep.Heads)
	}
}

// TestPathByHeadDigest walks a head digest back to genesis and checks
// the full path, including through a branch point.
func TestPathByHeadDigest(t *testing.T) {
	trunk := buildChain("genesis", "a", "b", "c")
	tip := trunk[len(trunk)-1]
	fork := Record{Digest: ComputeDigest(tip.Digest, "fork"), Prev: tip.Digest, Payload: "fork"}
	dir := t.TempDir()
	writeSegments(t, dir, [][]Record{trunk[:2], {fork}, trunk[2:]})

	res, err := Path(dir, fork.Digest)
	if err != nil {
		t.Fatal(err)
	}
	if res.Missing != "" || len(res.Cycle) != 0 {
		t.Fatalf("unexpected: %+v", res)
	}
	var got []string
	for _, r := range res.Path {
		got = append([]string{r.Payload}, got...) // un-reverse to genesis-first
	}
	want := []string{"genesis", "a", "b", "c", "fork"}
	if strings.Join(got, ",") != strings.Join(want, ",") {
		t.Fatalf("path=%v want %v", got, want)
	}
}

// TestMissingAncestorReportedSeparately removes the segment holding a
// middle record; both Check and Path must report a missing ancestor and
// must not report a cycle.
func TestMissingAncestorReportedSeparately(t *testing.T) {
	chain := buildChain("genesis", "a", "b", "c", "d")
	dir := t.TempDir()
	// Middle record "b" is absent from every segment.
	writeSegments(t, dir, [][]Record{chain[:2], chain[3:]})

	rep, err := Check(dir)
	if err != nil {
		t.Fatal(err)
	}
	if len(rep.Cycles) != 0 {
		t.Fatalf("false cycle: %+v", rep.Cycles)
	}
	if len(rep.Missing) != 1 || rep.Missing[0].Digest != chain[2].Digest {
		t.Fatalf("missing=%+v, want digest of %q", rep.Missing, "b")
	}

	res, err := Path(dir, chain[len(chain)-1].Digest)
	if err != nil {
		t.Fatal(err)
	}
	if res.Missing != chain[2].Digest {
		t.Fatalf("path missing=%q want %q", res.Missing, chain[2].Digest)
	}
	if len(res.Cycle) != 0 {
		t.Fatalf("false cycle in path: %+v", res.Cycle)
	}
}

// TestCycleReportedSeparately crafts two records referencing each other
// and requires a cycle report, never a missing-ancestor report.
func TestCycleReportedSeparately(t *testing.T) {
	// Stored digests are graph keys; prev pointers form a 2-cycle.
	a := Record{Digest: ComputeDigest("", "node-a"), Payload: "node-a"}
	b := Record{Digest: ComputeDigest("", "node-b"), Payload: "node-b"}
	a.Prev = b.Digest
	b.Prev = a.Digest
	dir := t.TempDir()
	writeSegments(t, dir, [][]Record{{a}, {b}})

	rep, err := Check(dir)
	if err != nil {
		t.Fatal(err)
	}
	if len(rep.Missing) != 0 {
		t.Fatalf("cycle misreported as missing: %+v", rep.Missing)
	}
	if len(rep.Cycles) != 1 {
		t.Fatalf("cycles=%+v, want exactly 1", rep.Cycles)
	}
	if len(rep.Cycles[0].Digests) != 2 {
		t.Fatalf("cycle digests=%v, want 2", rep.Cycles[0].Digests)
	}

	res, err := Path(dir, a.Digest)
	if err != nil {
		t.Fatal(err)
	}
	if res.Missing != "" {
		t.Fatalf("path reported missing %q for a cycle", res.Missing)
	}
	if len(res.Cycle) != 2 {
		t.Fatalf("path cycle=%v, want 2 digests", res.Cycle)
	}
}

// TestCorruptPayloadLocatesSegment tampers with one payload byte and
// requires the report to name the exact segment file that was corrupted.
func TestCorruptPayloadLocatesSegment(t *testing.T) {
	chain := buildChain("genesis", "alpha", "beta", "gamma", "delta", "omega")
	dir := t.TempDir()
	names := writeSegments(t, dir, [][]Record{chain[:2], chain[2:4], chain[4:]})

	// Corrupt a payload inside the middle segment.
	victim := filepath.Join(dir, names[1])
	data, err := os.ReadFile(victim)
	if err != nil {
		t.Fatal(err)
	}
	data = []byte(strings.Replace(string(data), "beta", "b3ta", 1))
	if err := os.WriteFile(victim, data, 0o644); err != nil {
		t.Fatal(err)
	}

	rep, err := Check(dir)
	if err != nil {
		t.Fatal(err)
	}
	if rep.OK() {
		t.Fatal("corruption went undetected")
	}
	if len(rep.BadDigests) == 0 {
		t.Fatalf("no digest issue reported: %+v", rep)
	}
	found := false
	for _, d := range rep.BadDigests {
		if d.Segment == names[1] {
			found = true
		}
	}
	if !found {
		t.Fatalf("corruption not located in %s: %+v", names[1], rep.BadDigests)
	}
}
