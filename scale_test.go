package dataeng

import (
	"testing"
	"time"
)

func TestScaleTwoHundredCandidates(t *testing.T) {
	const n = 220
	nodes := makeNodes(n)
	cands := make([]Candidate, 0, 200)
	for i := 0; i < 100; i++ {
		cands = append(cands, Candidate{Start: 2 * i, End: 2*i + 2, Profit: int64(i%5 + 1)})
	}
	for i := 0; i < 100; i++ {
		cands = append(cands, Candidate{Start: 2 * i, End: 2*i + 3, Profit: int64(i%7 + 1)})
	}
	anchors := make([]int, 20)
	for i := range anchors {
		anchors[i] = 10 * i
	}

	start := time.Now()
	got, err := BestPartition(nodes, cands, anchors)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if got.Records == 0 || got.Profit <= 0 {
		t.Fatalf("degenerate result: %+v", got)
	}
	if time.Since(start) > 250*time.Millisecond {
		t.Fatalf("BestPartition too slow at max scale: %v", time.Since(start))
	}
}
