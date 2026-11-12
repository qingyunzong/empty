package dataeng

import (
	"math/bits"
	"testing"
)

func TestMinWidthExact(t *testing.T) {
	for c := uint64(1); c <= 1_000_000; c++ {
		w := minWidth(c)
		if c == 1 {
			if w != 0 {
				t.Fatalf("minWidth(1)=%d want 0", w)
			}
			continue
		}
		if w == 0 {
			t.Fatalf("minWidth(%d)=0", c)
		}
		lower := uint64(1) << (w - 1)
		upper := uint64(1) << w
		if lower >= c || upper < c {
			t.Fatalf("minWidth(%d)=%d not minimal", c, w)
		}
	}

	for m := 0; m <= MaxBlockWidth; m++ {
		for c := 0; c <= m; c++ {
			combinations := binomial(m, c)
			w := minWidth(combinations)
			if combinations == 1 {
				if w != 0 {
					t.Fatalf("C(%d,%d)=1 has width %d", m, c, w)
				}
				continue
			}
			if uint64(1)<<w < combinations || uint64(1)<<(w-1) >= combinations {
				t.Fatalf("minWidth(C(%d,%d)=%d)=%d not minimal", m, c, combinations, w)
			}
		}
	}
}

func TestOrdinalAgainstIndependentEnumeration(t *testing.T) {
	for m := 0; m <= 12; m++ {
		limit := uint64(1) << uint(m)
		for c := 0; c <= m; c++ {
			var words []uint64
			for v := uint64(0); v < limit; v++ {
				if bits.OnesCount64(v) == c {
					words = append(words, v)
				}
			}
			if uint64(len(words)) != binomial(m, c) {
				t.Fatalf("m=%d c=%d enumerated %d words, C=%d",
					m, c, len(words), binomial(m, c))
			}
			for wantRank, word := range words {
				got, err := rankOrdinal(m, c, word)
				if err != nil {
					t.Fatalf("rankOrdinal(m=%d,c=%d,word=%#x): %v", m, c, word, err)
				}
				if got != uint64(wantRank) {
					t.Fatalf("m=%d c=%d word=%#x rank=%d want %d",
						m, c, word, got, wantRank)
				}
				back, err := unrankOrdinal(m, c, uint64(wantRank))
				if err != nil {
					t.Fatalf("unrankOrdinal(m=%d,c=%d,ord=%d): %v",
						m, c, wantRank, err)
				}
				if back != word {
					t.Fatalf("m=%d c=%d ord=%d -> %#x want %#x",
						m, c, wantRank, back, word)
				}
			}
			if _, err := unrankOrdinal(m, c, binomial(m, c)); err == nil {
				t.Fatalf("unrankOrdinal accepted invalid ordinal C(%d,%d)", m, c)
			}
		}
	}
}

func TestOrdinalIsNotColex(t *testing.T) {
	// For m=4,c=2, ordinary binary order is
	// 0011,0101,0110,1001,1010,1100.
	want := []uint64{0b0011, 0b0101, 0b0110, 0b1001, 0b1010, 0b1100}
	for rank, pattern := range want {
		got, err := rankOrdinal(4, 2, pattern)
		if err != nil {
			t.Fatal(err)
		}
		if got != uint64(rank) {
			t.Fatalf("pattern %04b has rank %d want %d", pattern, got, rank)
		}
	}
}

func TestLargeBinomialsFitAndWidths(t *testing.T) {
	for m := 0; m <= 63; m++ {
		var sum uint64
		for c := 0; c <= m; c++ {
			sum += binomial(m, c)
		}
		if sum != uint64(1)<<uint(m) {
			t.Fatalf("row %d sums to %d, want %d", m, sum, uint64(1)<<uint(m))
		}
	}
}
