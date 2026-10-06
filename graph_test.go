package main

import (
	"fmt"
	"math/rand"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// chain builds a linear chain of n segments with payloads "p0".."pn-1".
func chain(prefix string, n int, prev string) []Segment {
	segs := make([]Segment, n)
	for i := 0; i < n; i++ {
		payload := fmt.Sprintf("%s%d", prefix, i)
		digest := ComputeDigest(prev, payload)
		segs[i] = Segment{Payload: payload, Prev: prev, Digest: digest}
		prev = digest
	}
	return segs
}

func loadAll(segs []Segment) *Graph {
	g := NewGraph()
	for _, s := range segs {
		g.Add(s)
	}
	return g
}

func pathDigests(res PathResult) []string {
	var out []string
	for _, s := range res.Path {
		out = append(out, s.Digest)
	}
	return out
}

func TestBranchesShareCommonPrefix(t *testing.T) {
	base := chain("base-", 3, "")
	forkA := chain("a-", 2, base[2].Digest)
	forkB := chain("b-", 2, base[2].Digest)

	g := loadAll(append(append(append([]Segment{}, base...), forkA...), forkB...))

	if g.Duplicates != 0 {
		t.Fatalf("different successors counted as duplicates: %d", g.Duplicates)
	}
	if got := len(g.Children(base[2].Digest)); got != 2 {
		t.Fatalf("expected 2 children at fork point, got %d", got)
	}
	if g.Len() != 7 {
		t.Fatalf("expected 7 distinct segments, got %d", g.Len())
	}

	// Both branch heads resolve to full paths sharing the common prefix.
	for _, head := range []Segment{forkA[1], forkB[1]} {
		res := g.Path(head.Digest)
		if res.Status != PathOK {
			t.Fatalf("head %s: status %v", head.Digest, res.Status)
		}
		if len(res.Path) != 5 {
			t.Fatalf("head %s: expected depth 5, got %d", head.Digest, len(res.Path))
		}
		prefix := pathDigests(res)[2:]
		for i, want := range []Segment{base[2], base[1], base[0]} {
			if prefix[i] != want.Digest {
				t.Fatalf("shared prefix mismatch at %d: got %s want %s", i, prefix[i], want.Digest)
			}
		}
	}
}

func TestExactDuplicateCountedNotConflicted(t *testing.T) {
	segs := chain("d-", 4, "")
	g := loadAll(append(append([]Segment{}, segs...), segs...))
	if g.Duplicates != 4 {
		t.Fatalf("expected 4 duplicates, got %d", g.Duplicates)
	}
	if len(g.Conflicts) != 0 {
		t.Fatalf("exact duplicates misreported as conflicts")
	}
	if g.Len() != 4 {
		t.Fatalf("expected 4 segments, got %d", g.Len())
	}
}

func TestConflictSameDigestDifferentContent(t *testing.T) {
	a := Segment{Payload: "x", Prev: "", Digest: "deadbeef"}
	b := Segment{Payload: "y", Prev: "", Digest: "deadbeef"}
	g := loadAll([]Segment{a, b})
	if len(g.Conflicts) != 1 {
		t.Fatalf("expected 1 conflict, got %d", len(g.Conflicts))
	}
	if g.Duplicates != 0 {
		t.Fatalf("conflict counted as duplicate")
	}
	if got, _ := g.Get("deadbeef"); got.Payload != "x" {
		t.Fatalf("first segment should be kept, got %q", got.Payload)
	}
}

func TestPathMissingAncestor(t *testing.T) {
	segs := chain("m-", 3, "")
	g := loadAll(segs[1:]) // drop genesis

	res := g.Path(segs[2].Digest)
	if res.Status != PathMissingAncestor {
		t.Fatalf("expected missing ancestor, got %v", res.Status)
	}
	if res.Missing != segs[0].Digest {
		t.Fatalf("missing digest = %s, want %s", res.Missing, segs[0].Digest)
	}
	if len(res.Path) != 2 {
		t.Fatalf("expected 2 resolved segments before the gap, got %d", len(res.Path))
	}

	// A completely unknown head is itself the missing ancestor.
	res = g.Path("00ff")
	if res.Status != PathMissingAncestor || res.Missing != "00ff" {
		t.Fatalf("unknown head: status=%v missing=%s", res.Status, res.Missing)
	}
}

func TestPathCycleReportedSeparately(t *testing.T) {
	// Claimed digests form a loop; only possible with forged digests, which is
	// exactly what the audit must flag distinctly from a missing ancestor.
	x := Segment{Payload: "x", Prev: "digest-y", Digest: "digest-x"}
	y := Segment{Payload: "y", Prev: "digest-x", Digest: "digest-y"}
	g := loadAll([]Segment{x, y})

	res := g.Path("digest-x")
	if res.Status != PathCycle {
		t.Fatalf("expected cycle, got %v", res.Status)
	}
	if res.CycleAt != "digest-x" {
		t.Fatalf("cycle at %s, want digest-x", res.CycleAt)
	}
	if len(res.Path) != 2 {
		t.Fatalf("expected 2 segments before loop, got %d", len(res.Path))
	}
}

func TestCorruptedPayloadLocatedToSegment(t *testing.T) {
	segs := chain("c-", 6, "")
	// Tamper with the payload of segment 3 but keep its claimed digest.
	segs[3].Payload = "c-3-tampered"
	g := loadAll(segs)

	res := g.Verify()
	if len(res.Corrupted) != 1 {
		t.Fatalf("expected exactly 1 corrupted segment, got %d", len(res.Corrupted))
	}
	c := res.Corrupted[0]
	if c.Digest != segs[3].Digest {
		t.Fatalf("corruption located at %s, want segment 3 digest %s", c.Digest, segs[3].Digest)
	}
	if c.Payload != "c-3-tampered" {
		t.Fatalf("corrupted payload = %q", c.Payload)
	}
	if c.Recomputed == c.Digest {
		t.Fatalf("recomputed digest should differ from claimed digest")
	}
	// Downstream segments still reference the claimed digest, so no missing refs.
	if len(res.MissingRefs) != 0 {
		t.Fatalf("unexpected missing refs: %v", res.MissingRefs)
	}
}

func TestRandomShuffleCrossCheckWithFullGraph(t *testing.T) {
	// Build a graph: trunk of 20, then two branches of 10 each from the trunk tip.
	trunk := chain("t-", 20, "")
	branchA := chain("A-", 10, trunk[19].Digest)
	branchB := chain("B-", 10, trunk[19].Digest)
	all := append(append(append([]Segment{}, trunk...), branchA...), branchB...)

	// Expected paths from each head, computed by direct index math.
	heads := []Segment{branchA[9], branchB[9]}
	wantDepth := 30

	for seed := int64(0); seed < 20; seed++ {
		shuffled := append([]Segment{}, all...)
		rand.New(rand.NewSource(seed)).Shuffle(len(shuffled), func(i, j int) {
			shuffled[i], shuffled[j] = shuffled[j], shuffled[i]
		})
		g := loadAll(shuffled)

		// Full-graph check must be clean regardless of insertion order.
		res := g.Verify()
		if !res.OK() {
			t.Fatalf("seed %d: full-graph check failed: %+v", seed, res)
		}
		if g.Len() != len(all) || g.Duplicates != 0 {
			t.Fatalf("seed %d: len=%d dup=%d", seed, g.Len(), g.Duplicates)
		}

		// Path queries from both heads must match the expected chain exactly.
		for _, head := range heads {
			pr := g.Path(head.Digest)
			if pr.Status != PathOK {
				t.Fatalf("seed %d: head %s status %v", seed, head.Digest, pr.Status)
			}
			if len(pr.Path) != wantDepth {
				t.Fatalf("seed %d: depth %d, want %d", seed, len(pr.Path), wantDepth)
			}
			got := pathDigests(pr)
			// Walk the expected sequence: branch segments then trunk, reversed.
			var want []string
			branch := branchA
			if head.Digest == branchB[9].Digest {
				branch = branchB
			}
			for i := len(branch) - 1; i >= 0; i-- {
				want = append(want, branch[i].Digest)
			}
			for i := len(trunk) - 1; i >= 0; i-- {
				want = append(want, trunk[i].Digest)
			}
			for i := range want {
				if got[i] != want[i] {
					t.Fatalf("seed %d: path[%d]=%s want %s", seed, i, got[i], want[i])
				}
			}
		}
	}
}

func TestLoadFileAndCheckLocateCorruptLine(t *testing.T) {
	segs := chain("f-", 5, "")
	var lines []string
	for _, s := range segs {
		lines = append(lines, fmt.Sprintf(`{"payload":%q,"prev":%q,"digest":%q}`, s.Payload, s.Prev, s.Digest))
	}
	// Corrupt the payload on line 4 (0-based index 3).
	lines[3] = strings.Replace(lines[3], "f-3", "f-3-evil", 1)

	path := filepath.Join(t.TempDir(), "segs.jsonl")
	if err := os.WriteFile(path, []byte(strings.Join(lines, "\n")+"\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	g, err := LoadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	res := g.Verify()
	if len(res.Corrupted) != 1 {
		t.Fatalf("expected 1 corrupted segment, got %d", len(res.Corrupted))
	}
	if res.Corrupted[0].Line != 4 {
		t.Fatalf("corruption at line %d, want 4", res.Corrupted[0].Line)
	}
	if res.Corrupted[0].Digest != segs[3].Digest {
		t.Fatalf("corruption digest %s, want %s", res.Corrupted[0].Digest, segs[3].Digest)
	}
}

func TestDigestComputedWhenAbsent(t *testing.T) {
	g := NewGraph()
	g.Add(Segment{Payload: "genesis"})
	g.Add(Segment{Payload: "second", Prev: ComputeDigest("", "genesis")})
	res := g.Path(ComputeDigest(ComputeDigest("", "genesis"), "second"))
	if res.Status != PathOK || len(res.Path) != 2 {
		t.Fatalf("status=%v depth=%d", res.Status, len(res.Path))
	}
	if v := g.Verify(); !v.OK() {
		t.Fatalf("verify failed: %+v", v)
	}
}
