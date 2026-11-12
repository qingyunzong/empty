package dataeng

import (
	"errors"
	"math/rand"
	"sort"
	"testing"
)

// naive is the plain-column reference the wavelet matrix is checked against.
type naive struct {
	vals []uint64
}

func (nv naive) rank(value uint64, end int) int {
	c := 0
	for i := 0; i < end; i++ {
		if nv.vals[i] == value {
			c++
		}
	}
	return c
}

func (nv naive) selectK(value uint64, k int) (int, bool) {
	for i, v := range nv.vals {
		if v == value {
			if k == 0 {
				return i, true
			}
			k--
		}
	}
	return 0, false
}

func (nv naive) rangeKth(l, r, k int) uint64 {
	buf := make([]uint64, r-l)
	copy(buf, nv.vals[l:r])
	sort.Slice(buf, func(i, j int) bool { return buf[i] < buf[j] })
	return buf[k]
}

func build(t *testing.T, vals []uint64, b int) *WaveletMatrix {
	t.Helper()
	wm, err := NewWaveletMatrix(vals, b)
	if err != nil {
		t.Fatalf("NewWaveletMatrix: %v", err)
	}
	return wm
}

// checkAll cross-checks At, Rank, Select and RangeKth against the naive
// reference, including absent values and values outside the b-bit domain.
func checkAll(t *testing.T, wm *WaveletMatrix, vals []uint64, b int, probes []uint64) {
	t.Helper()
	nv := naive{vals: vals}
	n := len(vals)
	var limit uint64 = 1 << uint(b)

	for i := 0; i < n; i++ {
		got, err := wm.At(i)
		if err != nil || got != vals[i] {
			t.Fatalf("At(%d) = %d, %v; want %d", i, got, err, vals[i])
		}
	}

	for _, v := range probes {
		for end := 0; end <= n; end++ {
			got, err := wm.Rank(v, end)
			if err != nil {
				t.Fatalf("Rank(%d, %d): %v", v, end, err)
			}
			want := 0
			if v < limit {
				want = nv.rank(v, end)
			}
			if got != want {
				t.Fatalf("Rank(%d, %d) = %d; want %d", v, end, got, want)
			}
		}
		for k := 0; k <= n; k++ {
			got, err := wm.Select(v, k)
			wantPos, ok := nv.selectK(v, k)
			if v >= limit || !ok {
				if !errors.Is(err, ErrNotFound) {
					t.Fatalf("Select(%d, %d) err = %v; want ErrNotFound", v, k, err)
				}
				continue
			}
			if err != nil || got != wantPos {
				t.Fatalf("Select(%d, %d) = %d, %v; want %d", v, k, got, err, wantPos)
			}
		}
	}

	for l := 0; l < n; l++ {
		for r := l + 1; r <= n; r++ {
			for k := 0; k < r-l; k++ {
				got, err := wm.RangeKth(l, r, k)
				want := nv.rangeKth(l, r, k)
				if err != nil || got != want {
					t.Fatalf("RangeKth(%d, %d, %d) = %d, %v; want %d", l, r, k, got, err, want)
				}
			}
		}
	}
}

func probeSet(vals []uint64, b int) []uint64 {
	var limit uint64 = 1 << uint(b)
	set := map[uint64]bool{}
	var probes []uint64
	add := func(v uint64) {
		if !set[v] {
			set[v] = true
			probes = append(probes, v)
		}
	}
	for _, v := range vals {
		add(v)
	}
	add(0)
	add(limit - 1)
	if limit > 1 {
		add(1)
		add(limit / 2)
	}
	if b < 32 {
		add(limit)     // just outside the domain
		add(limit + 7) // further outside
	} else {
		add(limit) // 2^32 is outside the b=32 domain
	}
	return probes
}

func TestExhaustiveSmallColumns(t *testing.T) {
	rng := rand.New(rand.NewSource(42))
	for _, b := range []int{1, 2, 3, 5, 8, 16, 31, 32} {
		for _, n := range []int{0, 1, 2, 3, 7, 16, 33} {
			var limit uint64 = 1 << uint(b)
			vals := make([]uint64, n)
			for i := range vals {
				if n > 4 && rng.Intn(2) == 0 {
					// Force heavy duplication.
					vals[i] = uint64(rng.Intn(3)) % limit
				} else {
					vals[i] = uint64(rng.Int63n(int64(limit)))
				}
			}
			wm := build(t, vals, b)
			checkAll(t, wm, vals, b, probeSet(vals, b))
		}
	}
}

func TestDuplicatesAndAbsentValues(t *testing.T) {
	vals := []uint64{5, 5, 5, 1, 5, 1, 0, 0, 7, 5}
	b := 3
	wm := build(t, vals, b)
	checkAll(t, wm, vals, b, probeSet(vals, b))

	// Absent but valid value: rank 0 everywhere, select not found.
	for end := 0; end <= len(vals); end++ {
		got, err := wm.Rank(6, end)
		if err != nil || got != 0 {
			t.Fatalf("Rank(6, %d) = %d, %v; want 0", end, got, err)
		}
	}
	if _, err := wm.Select(6, 0); !errors.Is(err, ErrNotFound) {
		t.Fatalf("Select(6, 0) err = %v; want ErrNotFound", err)
	}
	// Present value, k beyond its frequency.
	if _, err := wm.Select(1, 2); !errors.Is(err, ErrNotFound) {
		t.Fatalf("Select(1, 2) err = %v; want ErrNotFound", err)
	}
}

func TestFullWidth32(t *testing.T) {
	vals := []uint64{
		0, 1<<32 - 1, 1 << 31, 1<<31 - 1, 0,
		1<<32 - 1, 123456789, 1 << 31, 42, 1<<32 - 2,
	}
	wm := build(t, vals, 32)
	checkAll(t, wm, vals, 32, probeSet(vals, 32))

	// 2^32 is outside the domain: rank 0, select not found.
	got, err := wm.Rank(1<<32, len(vals))
	if err != nil || got != 0 {
		t.Fatalf("Rank(2^32, n) = %d, %v; want 0", got, err)
	}
	if _, err := wm.Select(1<<32, 0); !errors.Is(err, ErrNotFound) {
		t.Fatalf("Select(2^32, 0) err = %v; want ErrNotFound", err)
	}
}

func TestAllShortRanges(t *testing.T) {
	rng := rand.New(rand.NewSource(7))
	for _, b := range []int{1, 4, 9, 32} {
		n := 48
		limit := int64(uint64(1) << uint(b))
		vals := make([]uint64, n)
		for i := range vals {
			vals[i] = uint64(rng.Int63n(limit))
		}
		wm := build(t, vals, b)
		nv := naive{vals: vals}
		for l := 0; l < n; l++ {
			for r := l + 1; r <= n && r-l <= 6; r++ {
				for k := 0; k < r-l; k++ {
					got, err := wm.RangeKth(l, r, k)
					want := nv.rangeKth(l, r, k)
					if err != nil || got != want {
						t.Fatalf("b=%d RangeKth(%d,%d,%d) = %d,%v; want %d",
							b, l, r, k, got, err, want)
					}
				}
			}
		}
	}
}

func TestQueryErrors(t *testing.T) {
	vals := []uint64{3, 1, 2}
	wm := build(t, vals, 2)

	if _, err := wm.At(-1); !errors.Is(err, ErrOutOfBounds) {
		t.Fatalf("At(-1) err = %v", err)
	}
	if _, err := wm.At(3); !errors.Is(err, ErrOutOfBounds) {
		t.Fatalf("At(3) err = %v", err)
	}
	if _, err := wm.Rank(1, -1); !errors.Is(err, ErrOutOfBounds) {
		t.Fatalf("Rank end=-1 err = %v", err)
	}
	if _, err := wm.Rank(1, 4); !errors.Is(err, ErrOutOfBounds) {
		t.Fatalf("Rank end=4 err = %v", err)
	}
	if _, err := wm.Select(1, -1); !errors.Is(err, ErrOutOfBounds) {
		t.Fatalf("Select k=-1 err = %v", err)
	}
	for _, tc := range [][3]int{{-1, 2, 0}, {0, 4, 0}, {2, 1, 0}} {
		if _, err := wm.RangeKth(tc[0], tc[1], tc[2]); !errors.Is(err, ErrOutOfBounds) {
			t.Fatalf("RangeKth%v err = %v", tc, err)
		}
	}
	if _, err := wm.RangeKth(1, 1, 0); !errors.Is(err, ErrEmptyRange) {
		t.Fatalf("RangeKth empty err = %v", err)
	}
	if _, err := wm.RangeKth(0, 3, -1); !errors.Is(err, ErrOutOfBounds) {
		t.Fatalf("RangeKth k=-1 err = %v", err)
	}
	if _, err := wm.RangeKth(0, 3, 3); !errors.Is(err, ErrOutOfBounds) {
		t.Fatalf("RangeKth k=len err = %v", err)
	}
	// Out-of-domain value: rank 0 without error, select not found.
	got, err := wm.Rank(4, 2)
	if err != nil || got != 0 {
		t.Fatalf("Rank(4, 2) = %d, %v; want 0", got, err)
	}
	if _, err := wm.Select(4, 0); !errors.Is(err, ErrNotFound) {
		t.Fatalf("Select(4, 0) err = %v; want ErrNotFound", err)
	}
}

func TestConstructionValidation(t *testing.T) {
	if _, err := NewWaveletMatrix([]uint64{1}, 0); err == nil {
		t.Fatal("b=0 accepted")
	}
	if _, err := NewWaveletMatrix([]uint64{1}, 33); err == nil {
		t.Fatal("b=33 accepted")
	}
	if _, err := NewWaveletMatrix([]uint64{4}, 2); err == nil {
		t.Fatal("value 4 accepted for b=2")
	}
}

// TestLayerStructureIntegrity verifies the exposed layer structure: every
// layer's bitmap matches the bit of the current sequence, the recorded zero
// counts are exact, each step is a stable 0-before-1 partition, and the
// total number of bitmap bits is exactly n*b.
func TestLayerStructureIntegrity(t *testing.T) {
	rng := rand.New(rand.NewSource(99))
	for _, b := range []int{1, 2, 5, 17, 32} {
		n := 61
		limit := int64(uint64(1) << uint(b))
		vals := make([]uint64, n)
		for i := range vals {
			vals[i] = uint64(rng.Int63n(limit))
		}
		wm := build(t, vals, b)

		if wm.NumLevels() != b {
			t.Fatalf("b=%d NumLevels = %d", b, wm.NumLevels())
		}
		if wm.TotalBits() != n*b {
			t.Fatalf("b=%d TotalBits = %d; want %d", b, wm.TotalBits(), n*b)
		}

		seq := make([]uint64, n)
		copy(seq, vals)
		for d := 0; d < b; d++ {
			shift := uint(b - 1 - d)
			zeros := 0
			for i, v := range seq {
				bit := int((v >> shift) & 1)
				if got := wm.Bit(d, i); got != bit {
					t.Fatalf("b=%d level %d bit %d = %d; want %d", b, d, i, got, bit)
				}
				if bit == 0 {
					zeros++
				}
			}
			if wm.Zeros(d) != zeros {
				t.Fatalf("b=%d level %d zeros = %d; want %d", b, d, wm.Zeros(d), zeros)
			}
			// Stable partition: zeros in original relative order, then ones.
			next := make([]uint64, 0, n)
			for _, v := range seq {
				if (v>>shift)&1 == 0 {
					next = append(next, v)
				}
			}
			for _, v := range seq {
				if (v>>shift)&1 == 1 {
					next = append(next, v)
				}
			}
			seq = next
		}
		// A genuine MSB-first stable-partition cascade leaves the sequence
		// ordered by bit-reversed value; verify against an independent sort.
		want := make([]uint64, n)
		copy(want, vals)
		sort.SliceStable(want, func(i, j int) bool {
			return reverseBits(want[i], b) < reverseBits(want[j], b)
		})
		for i := range seq {
			if seq[i] != want[i] {
				t.Fatalf("b=%d: final sequence diverges at %d: got %d want %d",
					b, i, seq[i], want[i])
			}
		}
	}
}

func reverseBits(v uint64, b int) uint64 {
	var r uint64
	for i := 0; i < b; i++ {
		r = (r << 1) | ((v >> uint(i)) & 1)
	}
	return r
}
