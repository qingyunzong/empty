package dataeng

import (
	"math"
	"testing"
)

func TestDeltaBitWidth(t *testing.T) {
	cases := []struct {
		delta int64
		want  int
	}{
		{0, 0},
		{1, 2}, {-1, 1},
		{2, 3}, {-2, 2},
		{3, 3}, {-3, 3},
		{4, 4}, {-4, 3},
		{7, 4}, {-7, 4},
		{8, 5}, {-8, 4},
		{63, 7}, {-64, 7},
		{64, 8}, {-65, 8},
		{math.MaxInt64, 64},
		{math.MinInt64, 64},
	}
	for _, tc := range cases {
		if got := deltaBitWidth(tc.delta); got != tc.want {
			t.Errorf("deltaBitWidth(%d) = %d, want %d", tc.delta, got, tc.want)
		}
	}
}

func TestIntDeltaOverflow(t *testing.T) {
	// 正溢出差：MaxInt64 - MinInt64 = 2^64-1，需要 65 位。
	if d, ok := intDelta(math.MinInt64, math.MaxInt64); ok {
		t.Fatalf("expected overflow, got delta=%d ok=true", d)
	}
	// 负溢出差：MinInt64 - MaxInt64 = -(2^64-1)，需要 65 位。
	if d, ok := intDelta(math.MaxInt64, math.MinInt64); ok {
		t.Fatalf("expected underflow, got delta=%d ok=true", d)
	}
	// 普通差值不溢出。
	if d, ok := intDelta(-5, 5); !ok || d != 10 {
		t.Fatalf("intDelta(-5,5) = %d,%v", d, ok)
	}
	if d, ok := intDelta(5, -5); !ok || d != -10 {
		t.Fatalf("intDelta(5,-5) = %d,%v", d, ok)
	}
}

func TestBlockBitWidthExtremes(t *testing.T) {
	if got := blockBitWidth([]int64{math.MinInt64, math.MaxInt64}); got != 65 {
		t.Fatalf("positive extreme width = %d, want 65", got)
	}
	if got := blockBitWidth([]int64{math.MaxInt64, math.MinInt64}); got != 65 {
		t.Fatalf("negative extreme width = %d, want 65", got)
	}
	if got := blockBitWidth([]int64{42, 42, 42}); got != 0 {
		t.Fatalf("constant width = %d, want 0", got)
	}
}

func TestBitWriterReaderRoundTrip(t *testing.T) {
	widths := []int{1, 2, 3, 5, 7, 8, 13, 16, 31, 32, 63, 64}
	for _, width := range widths {
		writer := bitWriter{}
		values := []uint64{0, 1, lowMask(width), lowMask(width) / 2}
		for _, value := range values {
			writer.writeBits(value, width)
		}
		payload := writer.finish()
		if want := (width*len(values) + 7) / 8; len(payload) != want {
			t.Fatalf("width=%d payload len=%d, want %d", width, len(payload), want)
		}
		reader := newBitReader(payload)
		for i, want := range values {
			if got := reader.readBits(width); got != want {
				t.Errorf("width=%d index=%d got=%d want=%d", width, i, got, want)
			}
		}
	}
}
