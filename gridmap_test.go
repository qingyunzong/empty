package gridmap

import (
	"reflect"
	"testing"
)

func mustMap(t *testing.T, w, h int) *Map {
	t.Helper()
	m, err := New(w, h)
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	return m
}

func mustSnap(t *testing.T, m *Map, v int) *Snapshot {
	t.Helper()
	s, err := m.Snapshot(v)
	if err != nil {
		t.Fatalf("Snapshot(%d): %v", v, err)
	}
	return s
}

func TestCornerCuttingForbidden(t *testing.T) {
	m := mustMap(t, 3, 3)
	// Wall off one flank of the diagonal (0,0)->(1,1): the diagonal step
	// would cut the corner past the obstacle at (1,0).
	s, err := m.ApplyBatch([]Edit{{Cell: Coord{1, 0}, Block: true}})
	if err != nil {
		t.Fatalf("ApplyBatch: %v", err)
	}
	if _, ok := s.MoveCost(Coord{0, 0}, Coord{1, 1}); ok {
		t.Fatal("diagonal corner cut should be illegal")
	}
	path, dist, ok := ShortestPath(s, Coord{0, 0}, Coord{2, 2})
	if !ok {
		t.Fatal("expected a path")
	}
	// Without the corner-cut rule the cost would be 2*14=28; the cheapest
	// legal detour, e.g. (0,0)->(0,1)->(1,2)->(2,2), costs 10+14+10=34.
	if dist != 2*OrthogonalCost+DiagonalCost {
		t.Fatalf("dist = %d, want %d", dist, 2*OrthogonalCost+DiagonalCost)
	}
	for i := 1; i < len(path); i++ {
		if _, ok := s.MoveCost(path[i-1], path[i]); !ok {
			t.Fatalf("path contains illegal move %v -> %v", path[i-1], path[i])
		}
	}
}

func TestDiagonalAllowedWhenFlanksFree(t *testing.T) {
	m := mustMap(t, 3, 3)
	s := mustSnap(t, m, 0)
	if c, ok := s.MoveCost(Coord{0, 0}, Coord{1, 1}); !ok || c != DiagonalCost {
		t.Fatalf("diagonal move = %d,%v; want %d,true", c, ok, DiagonalCost)
	}
	_, dist, ok := ShortestPath(s, Coord{0, 0}, Coord{2, 2})
	if !ok || dist != 2*DiagonalCost {
		t.Fatalf("dist = %d,%v; want %d,true", dist, ok, 2*DiagonalCost)
	}
}

func TestLexicographicTieBreak(t *testing.T) {
	// 5x5 open grid, (0,0) -> (2,1). Cheapest: one diagonal (14) + one
	// orthogonal (10) = 24. Candidate sequences:
	//   (0,0),(1,1),(2,1)  and  (0,0),(1,0),(2,1)
	// Second cell (1,0) < (1,1), so the latter must win.
	m := mustMap(t, 5, 5)
	s := mustSnap(t, m, 0)
	path, dist, ok := ShortestPath(s, Coord{0, 0}, Coord{2, 1})
	if !ok {
		t.Fatal("expected a path")
	}
	if dist != DiagonalCost+OrthogonalCost {
		t.Fatalf("dist = %d, want %d", dist, DiagonalCost+OrthogonalCost)
	}
	want := []Coord{{0, 0}, {1, 0}, {2, 1}}
	if !reflect.DeepEqual(path, want) {
		t.Fatalf("path = %v, want lex-min %v", path, want)
	}
}

func TestBatchEditsAndOldSnapshots(t *testing.T) {
	m := mustMap(t, 4, 1)
	v0 := mustSnap(t, m, 0)
	// Version 1: wall at (1,0) disconnects (0,0) from (3,0).
	v1, err := m.ApplyBatch([]Edit{{Cell: Coord{1, 0}, Block: true}})
	if err != nil {
		t.Fatalf("ApplyBatch: %v", err)
	}
	if _, _, ok := ShortestPath(v1, Coord{0, 0}, Coord{3, 0}); ok {
		t.Fatal("v1 should be disconnected")
	}
	// Old snapshot still answers with the pre-wall result.
	if _, d, ok := ShortestPath(v0, Coord{0, 0}, Coord{3, 0}); !ok || d != 3*OrthogonalCost {
		t.Fatalf("v0 dist = %d,%v; want %d,true", d, ok, 3*OrthogonalCost)
	}
	// Version 2: clear the wall again; v1 must stay disconnected.
	v2, err := m.ApplyBatch([]Edit{{Cell: Coord{1, 0}, Block: false}})
	if err != nil {
		t.Fatalf("ApplyBatch: %v", err)
	}
	if _, d, ok := ShortestPath(v2, Coord{0, 0}, Coord{3, 0}); !ok || d != 3*OrthogonalCost {
		t.Fatalf("v2 dist = %d,%v; want %d,true", d, ok, 3*OrthogonalCost)
	}
	if _, _, ok := ShortestPath(mustSnap(t, m, 1), Coord{0, 0}, Coord{3, 0}); ok {
		t.Fatal("v1 must remain disconnected after later batch")
	}
	if m.Version() != 2 || v1.Version() != 1 || v2.Version() != 2 {
		t.Fatalf("bad versions: latest=%d v1=%d v2=%d", m.Version(), v1.Version(), v2.Version())
	}
	if _, err := m.Snapshot(3); err == nil {
		t.Fatal("Snapshot(3) should fail")
	}
	if _, err := m.ApplyBatch([]Edit{{Cell: Coord{9, 9}, Block: true}}); err == nil {
		t.Fatal("out-of-bounds edit should fail")
	}
	// Batch edits on the same cell apply in order.
	v3, err := m.ApplyBatch([]Edit{{Cell: Coord{2, 0}, Block: true}, {Cell: Coord{2, 0}, Block: false}})
	if err != nil {
		t.Fatalf("ApplyBatch: %v", err)
	}
	if v3.Blocked(Coord{2, 0}) {
		t.Fatal("later edit in batch should override earlier one")
	}
}

func TestCertificateVerifyAndTamper(t *testing.T) {
	m := mustMap(t, 6, 6)
	s, err := m.ApplyBatch([]Edit{
		{Cell: Coord{2, 0}, Block: true}, {Cell: Coord{2, 1}, Block: true},
		{Cell: Coord{2, 2}, Block: true}, {Cell: Coord{2, 3}, Block: true},
	})
	if err != nil {
		t.Fatalf("ApplyBatch: %v", err)
	}
	cert, ok := ShortestPathCertificate(s, Coord{0, 0}, Coord{5, 5})
	if !ok {
		t.Fatal("expected certificate")
	}
	if err := cert.Verify(s); err != nil {
		t.Fatalf("valid certificate rejected: %v", err)
	}
	// Certificate must not verify against a different map version.
	s2, err := m.ApplyBatch([]Edit{{Cell: Coord{2, 4}, Block: true}, {Cell: Coord{2, 5}, Block: true}})
	if err != nil {
		t.Fatalf("ApplyBatch: %v", err)
	}
	if err := cert.Verify(s2); err == nil {
		t.Fatal("certificate verified against the wrong snapshot")
	}
	// Tampered distance.
	bad := *cert
	bad.Dist = cert.Dist - 1
	if err := bad.Verify(s); err == nil {
		t.Fatal("tampered Dist accepted")
	}
	// Tampered labels.
	bad2 := *cert
	bad2.Labels = map[Coord]int{cert.From: 0, cert.To: cert.Dist}
	if err := bad2.Verify(s); err == nil {
		t.Fatal("incomplete labels accepted")
	}
	// Tampered path.
	bad3 := *cert
	bad3.Path = append([]Coord{}, cert.Path...)
	bad3.Path[1] = Coord{cert.Path[1].X, cert.Path[1].Y + 3}
	if err := bad3.Verify(s); err == nil {
		t.Fatal("tampered path accepted")
	}
}

func TestUnreachableCertificate(t *testing.T) {
	m := mustMap(t, 3, 3)
	s, err := m.ApplyBatch([]Edit{
		{Cell: Coord{1, 0}, Block: true}, {Cell: Coord{0, 1}, Block: true}, {Cell: Coord{1, 1}, Block: true},
	})
	if err != nil {
		t.Fatalf("ApplyBatch: %v", err)
	}
	cert, ok := ShortestPathCertificate(s, Coord{0, 0}, Coord{2, 2})
	if !ok {
		t.Fatal("expected unreachability certificate")
	}
	if cert.Dist != -1 || cert.Path != nil {
		t.Fatalf("unreachable cert: Dist=%d Path=%v", cert.Dist, cert.Path)
	}
	if err := cert.Verify(s); err != nil {
		t.Fatalf("unreachability certificate rejected: %v", err)
	}
	// Claiming reachability must fail.
	bad := *cert
	bad.Dist = 28
	bad.Path = []Coord{{0, 0}, {1, 1}, {2, 2}}
	if err := bad.Verify(s); err == nil {
		t.Fatal("false reachability claim accepted")
	}
}

func TestBlockedEndpoints(t *testing.T) {
	m := mustMap(t, 3, 3)
	s, err := m.ApplyBatch([]Edit{{Cell: Coord{1, 1}, Block: true}})
	if err != nil {
		t.Fatalf("ApplyBatch: %v", err)
	}
	if _, _, ok := ShortestPath(s, Coord{1, 1}, Coord{0, 0}); ok {
		t.Fatal("blocked source should give no path")
	}
	if _, ok := ShortestPathCertificate(s, Coord{0, 0}, Coord{1, 1}); ok {
		t.Fatal("blocked target should give no certificate")
	}
	if _, ok := Distance(s, Coord{0, 0}, Coord{-1, 0}); ok {
		t.Fatal("out-of-bounds target should give no distance")
	}
}
