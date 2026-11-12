package dataeng

import (
	"errors"
	"testing"
)

func TestCheckpointRankPlateaus(t *testing.T) {
	const n = 5000
	const b = 8
	const S = 16

	zeroThenOne := makePattern(n, func(i int) byte {
		if i < 4000 {
			return 0
		}
		return 1
	})
	ix, err := New(zeroThenOne, b, S)
	if err != nil {
		t.Fatal(err)
	}
	pos, found, stats, err := ix.Select1WithStats(0)
	if err != nil || !found || pos != 4000 {
		t.Fatalf("Select1(0)=(%d,%v,%v) want 4000", pos, found, err)
	}
	checkStatsBounds(t, stats, S)
	if stats.BlockHeadersRead > 16 {
		t.Fatalf("plateau query scanned %d blocks", stats.BlockHeadersRead)
	}
	if len(stats.PayloadBitRanges) == 0 || stats.PayloadBitRanges[0].Start == 0 {
		t.Fatalf("Select1 restarted at payload zero: %+v", stats.PayloadBitRanges)
	}

	pos, found, stats, err = ix.Select1WithStats(100)
	if err != nil || !found || pos != 4100 {
		t.Fatalf("Select1(100)=(%d,%v,%v) want 4100", pos, found, err)
	}
	checkStatsBounds(t, stats, S)

	oneThenZero := makePattern(n, func(i int) byte {
		if i < 4000 {
			return 1
		}
		return 0
	})
	ix, err = New(oneThenZero, b, S)
	if err != nil {
		t.Fatal(err)
	}
	pos, found, stats, err = ix.Select0WithStats(0)
	if err != nil || !found || pos != 4000 {
		t.Fatalf("Select0(0)=(%d,%v,%v) want 4000", pos, found, err)
	}
	checkStatsBounds(t, stats, S)
	if stats.BlockHeadersRead > 16 {
		t.Fatalf("zero plateau query scanned %d blocks", stats.BlockHeadersRead)
	}
	if len(stats.PayloadBitRanges) == 0 || stats.PayloadBitRanges[0].Start == 0 {
		t.Fatalf("Select0 restarted at payload zero: %+v", stats.PayloadBitRanges)
	}
}

func TestLongAllZeroAndAllOne(t *testing.T) {
	const n = 10000
	const b = 9
	const S = 64

	zeros := make([]byte, n)
	ix, err := New(zeros, b, S)
	if err != nil {
		t.Fatal(err)
	}
	if ix.TotalOnes() != 0 || ix.TotalZeros() != n {
		t.Fatalf("zero totals: ones=%d zeros=%d", ix.TotalOnes(), ix.TotalZeros())
	}
	for _, end := range []uint64{0, 1, 100, 9999, 10000} {
		if got, err := ix.Rank1(end); err != nil || got != 0 {
			t.Fatalf("Rank1(%d)=(%d,%v)", end, got, err)
		}
		if got, err := ix.Rank0(end); err != nil || got != end {
			t.Fatalf("Rank0(%d)=(%d,%v) want %d", end, got, err, end)
		}
	}
	if _, found, err := ix.Select1(0); err != nil || found {
		t.Fatalf("Select1 on all-zero=(found=%v,err=%v)", found, err)
	}
	for _, k := range []int64{0, 123, 9999} {
		pos, found, stats, err := ix.Select0WithStats(k)
		if err != nil || !found || pos != uint64(k) {
			t.Fatalf("Select0(%d)=(%d,%v,%v)", k, pos, found, err)
		}
		checkStatsBounds(t, stats, S)
	}

	ones := makePattern(n, func(int) byte { return 1 })
	ix, err = New(ones, b, S)
	if err != nil {
		t.Fatal(err)
	}
	if ix.TotalOnes() != n || ix.TotalZeros() != 0 {
		t.Fatalf("one totals: ones=%d zeros=%d", ix.TotalOnes(), ix.TotalZeros())
	}
	if _, found, err := ix.Select0(0); err != nil || found {
		t.Fatalf("Select0 on all-one=(found=%v,err=%v)", found, err)
	}
	for _, k := range []int64{0, 123, 9999} {
		pos, found, stats, err := ix.Select1WithStats(k)
		if err != nil || !found || pos != uint64(k) {
			t.Fatalf("Select1(%d)=(%d,%v,%v)", k, pos, found, err)
		}
		checkStatsBounds(t, stats, S)
	}
}

func TestMaxCheckpointIntervalBound(t *testing.T) {
	const n = 4097
	const b = 1
	const S = 4096
	bits := makePattern(n, func(i int) byte { return byte(i & 1) })
	ix, err := New(bits, b, S)
	if err != nil {
		t.Fatal(err)
	}

	rank, stats, err := ix.Rank1WithStats(4096)
	if err != nil {
		t.Fatal(err)
	}
	if rank != referenceRank1(bits, 4096) {
		t.Fatalf("Rank1(4096)=%d", rank)
	}
	if stats.BlockHeadersRead != 4096 {
		t.Fatalf("Rank1 read %d headers, want 4096", stats.BlockHeadersRead)
	}
	checkStatsBounds(t, stats, S)

	got, stats, err := ix.AccessWithStats(4096)
	if err != nil || got != bits[4096] {
		t.Fatalf("Access(4096)=(%d,%v)", got, err)
	}
	if stats.BlockHeadersRead != 1 {
		t.Fatalf("Access at checkpoint read %d headers", stats.BlockHeadersRead)
	}
	checkStatsBounds(t, stats, S)
}

func TestStatsRangesStartAtCheckpoint(t *testing.T) {
	const n = 1024
	const b = 7
	const S = 5
	bits := makePattern(n, func(i int) byte { return byte((i*17 + 3) & 1) })
	ix, err := New(bits, b, S)
	if err != nil {
		t.Fatal(err)
	}

	// Position 102*7 is inside block 102.  Its checkpoint starts at block 100.
	const i = uint64(102 * 7)
	cp := ix.dir[102/S]
	got, stats, err := ix.AccessWithStats(i)
	if err != nil || got != bits[i] {
		t.Fatalf("Access(%d)=(%d,%v)", i, got, err)
	}
	if stats.BlockHeadersRead != 3 {
		t.Fatalf("Access headers=%d want 3", stats.BlockHeadersRead)
	}
	if stats.BlocksDecoded != 1 {
		t.Fatalf("Access decoded=%d want 1", stats.BlocksDecoded)
	}
	if len(stats.PayloadBitRanges) == 0 || stats.PayloadBitRanges[0].Start != cp.payloadBitOffset {
		t.Fatalf("ranges=%+v want start at %d", stats.PayloadBitRanges, cp.payloadBitOffset)
	}
	checkStatsBounds(t, stats, S)

	// A rank ending in the same block also starts at that checkpoint.
	end := i + 3
	rank, stats, err := ix.Rank1WithStats(end)
	if err != nil || rank != referenceRank1(bits, int(end)) {
		t.Fatalf("Rank1(%d)=(%d,%v)", end, rank, err)
	}
	if stats.BlockHeadersRead != 3 {
		t.Fatalf("Rank1 headers=%d want 3", stats.BlockHeadersRead)
	}
	if len(stats.PayloadBitRanges) == 0 || stats.PayloadBitRanges[0].Start != cp.payloadBitOffset {
		t.Fatalf("Rank1 ranges start=%+v want %d", stats.PayloadBitRanges, cp.payloadBitOffset)
	}
	checkStatsBounds(t, stats, S)
}

func TestCacheHitReportsZeroDecode(t *testing.T) {
	const n = 512
	const b = 8
	const S = 7
	ones := makePattern(n, func(int) byte { return 1 })
	ix, err := New(ones, b, S)
	if err != nil {
		t.Fatal(err)
	}

	_, stats, err := ix.AccessWithStats(100)
	if err != nil {
		t.Fatal(err)
	}
	if stats.BlocksDecoded != 1 || stats.CacheHits != 0 {
		t.Fatalf("initial Access decoded=%d cacheHits=%d", stats.BlocksDecoded, stats.CacheHits)
	}

	_, stats, err = ix.AccessWithStats(101)
	if err != nil {
		t.Fatal(err)
	}
	if stats.BlocksDecoded != 0 || stats.CacheHits != 1 {
		t.Fatalf("cached Access decoded=%d cacheHits=%d", stats.BlocksDecoded, stats.CacheHits)
	}
	checkStatsBounds(t, stats, S)

	// Select1 lands in the cached block and must not claim a decode.
	pos, found, stats, err := ix.Select1WithStats(100)
	if err != nil || !found || pos != 100 {
		t.Fatalf("Select1(100)=(%d,%v,%v)", pos, found, err)
	}
	if stats.BlocksDecoded != 0 || stats.CacheHits != 1 {
		t.Fatalf("cached Select decoded=%d cacheHits=%d", stats.BlocksDecoded, stats.CacheHits)
	}
	checkStatsBounds(t, stats, S)

	rank, stats, err := ix.Rank1WithStats(101)
	if err != nil || rank != 101 {
		t.Fatalf("Rank1(101)=(%d,%v)", rank, err)
	}
	if stats.BlocksDecoded != 0 || stats.CacheHits != 1 {
		t.Fatalf("cached Rank decoded=%d cacheHits=%d", stats.BlocksDecoded, stats.CacheHits)
	}
	checkStatsBounds(t, stats, S)

	// Decoding a different block replaces the single cache entry.
	_, stats, err = ix.AccessWithStats(300)
	if err != nil {
		t.Fatal(err)
	}
	if stats.BlocksDecoded != 1 {
		t.Fatalf("different block decoded=%d", stats.BlocksDecoded)
	}
	_, stats, err = ix.AccessWithStats(100)
	if err != nil {
		t.Fatal(err)
	}
	if stats.BlocksDecoded != 1 || stats.CacheHits != 0 {
		t.Fatalf("evicted block decoded=%d cacheHits=%d", stats.BlocksDecoded, stats.CacheHits)
	}
}

func TestInvalidQueriesAndAbsentSelect(t *testing.T) {
	bits := []byte{1, 0, 1}
	ix, err := New(bits, 2, 1)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := ix.Access(3); !errors.Is(err, ErrOutOfRange) {
		t.Fatalf("Access(3): %v", err)
	}
	if _, err := ix.Rank1(4); !errors.Is(err, ErrOutOfRange) {
		t.Fatalf("Rank1(4): %v", err)
	}
	if _, err := ix.Rank0(4); !errors.Is(err, ErrOutOfRange) {
		t.Fatalf("Rank0(4): %v", err)
	}
	if _, _, err := ix.Select1(-1); !errors.Is(err, ErrOutOfRange) {
		t.Fatalf("Select1(-1): %v", err)
	}
	if _, _, err := ix.Select0(-1); !errors.Is(err, ErrOutOfRange) {
		t.Fatalf("Select0(-1): %v", err)
	}
	if pos, found, err := ix.Select1(2); err != nil || found || pos != 0 {
		t.Fatalf("Select1(2)=(%d,%v,%v)", pos, found, err)
	}
	if pos, found, err := ix.Select0(1); err != nil || found || pos != 0 {
		t.Fatalf("Select0(1)=(%d,%v,%v)", pos, found, err)
	}
	if pos, found, err := ix.Select1(1 << 40); err != nil || found || pos != 0 {
		t.Fatalf("Select1(huge)=(%d,%v,%v)", pos, found, err)
	}
}
