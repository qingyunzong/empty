package dataeng

import (
	"testing"
)

func referenceRank1(bits []byte, end int) uint64 {
	var count uint64
	for i := 0; i < end; i++ {
		if bits[i] != 0 {
			count++
		}
	}
	return count
}

func referencePositions(bits []byte, wantOne bool) []uint64 {
	var positions []uint64
	for i, bit := range bits {
		one := bit != 0
		if one == wantOne {
			positions = append(positions, uint64(i))
		}
	}
	return positions
}

func checkStatsBounds(t *testing.T, stats QueryStats, S int) {
	t.Helper()
	if stats.BlockHeadersRead > uint64(S) {
		t.Fatalf("query read %d block headers, S=%d", stats.BlockHeadersRead, S)
	}
	if stats.BlocksDecoded > 1 {
		t.Fatalf("query decoded %d blocks, want at most one", stats.BlocksDecoded)
	}
	if stats.CacheHits > 1 {
		t.Fatalf("query reported %d cache hits", stats.CacheHits)
	}
	for i, r := range stats.PayloadBitRanges {
		if r.Start >= r.End {
			t.Fatalf("range %d is empty/inverted: %+v", i, r)
		}
		if i > 0 && stats.PayloadBitRanges[i-1].End > r.Start {
			t.Fatalf("ranges not increasing: %+v", stats.PayloadBitRanges)
		}
	}
}

func checkAgainstReference(t *testing.T, bits []byte, b, S int) {
	t.Helper()
	ix, err := New(bits, b, S)
	if err != nil {
		t.Fatalf("New(b=%d,S=%d,N=%d): %v", b, S, len(bits), err)
	}
	n := uint64(len(bits))
	if ix.Len() != n {
		t.Fatalf("Len=%d want %d", ix.Len(), n)
	}
	if ix.TotalOnes() != referenceRank1(bits, len(bits)) {
		t.Fatalf("TotalOnes=%d want %d", ix.TotalOnes(), referenceRank1(bits, len(bits)))
	}

	for i := range bits {
		got, stats, err := ix.AccessWithStats(uint64(i))
		if err != nil {
			t.Fatalf("Access(%d): %v", i, err)
		}
		if got != bits[i] {
			t.Fatalf("Access(%d)=%d want %d", i, got, bits[i])
		}
		checkStatsBounds(t, stats, S)
	}

	for end := 0; end <= len(bits); end++ {
		got, stats, err := ix.Rank1WithStats(uint64(end))
		if err != nil {
			t.Fatalf("Rank1(%d): %v", end, err)
		}
		want := referenceRank1(bits, end)
		if got != want {
			t.Fatalf("Rank1(%d)=%d want %d", end, got, want)
		}
		checkStatsBounds(t, stats, S)

		got0, stats0, err := ix.Rank0WithStats(uint64(end))
		if err != nil {
			t.Fatalf("Rank0(%d): %v", end, err)
		}
		if got0 != uint64(end)-want {
			t.Fatalf("Rank0(%d)=%d want %d", end, got0, uint64(end)-want)
		}
		checkStatsBounds(t, stats0, S)
	}

	ones := referencePositions(bits, true)
	for k, want := range ones {
		got, found, stats, err := ix.Select1WithStats(int64(k))
		if err != nil {
			t.Fatalf("Select1(%d): %v", k, err)
		}
		if !found || got != want {
			t.Fatalf("Select1(%d)=(%d,%v) want %d", k, got, found, want)
		}
		checkStatsBounds(t, stats, S)
	}
	if _, found, err := ix.Select1(int64(len(ones))); err != nil || found {
		t.Fatalf("Select1(total)=(found=%v,err=%v), want absent", found, err)
	}

	zeros := referencePositions(bits, false)
	for k, want := range zeros {
		got, found, stats, err := ix.Select0WithStats(int64(k))
		if err != nil {
			t.Fatalf("Select0(%d): %v", k, err)
		}
		if !found || got != want {
			t.Fatalf("Select0(%d)=(%d,%v) want %d", k, got, found, want)
		}
		checkStatsBounds(t, stats, S)
	}
	if _, found, err := ix.Select0(int64(len(zeros))); err != nil || found {
		t.Fatalf("Select0(total)=(found=%v,err=%v), want absent", found, err)
	}
}

func allBitVectors(n int, fn func([]byte)) {
	if n == 0 {
		fn(nil)
		return
	}
	limit := 1 << uint(n)
	bits := make([]byte, n)
	for mask := 0; mask < limit; mask++ {
		for i := 0; i < n; i++ {
			bits[i] = byte((mask >> uint(n-1-i)) & 1)
		}
		fn(bits)
	}
}
