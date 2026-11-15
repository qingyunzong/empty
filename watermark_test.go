package dataeng

import (
	"sync"
	"testing"
)

func TestWatermarkBlocksAtGap(t *testing.T) {
	wm := NewWatermark(0)
	wm.Mark(2)
	if got := wm.Value(); got != 0 {
		t.Fatalf("watermark = %d, want 0", got)
	}
	wm.Mark(0)
	if got := wm.Value(); got != 1 {
		t.Fatalf("watermark = %d, want 1", got)
	}
	wm.Mark(1)
	if got := wm.Value(); got != 3 {
		t.Fatalf("watermark = %d, want 3", got)
	}
	wm.Mark(5)
	if got := wm.Value(); got != 3 {
		t.Fatalf("watermark = %d, want 3", got)
	}
	wm.Mark(3)
	wm.Mark(4)
	if got := wm.Value(); got != 6 {
		t.Fatalf("watermark = %d, want 6", got)
	}
}

func TestWatermarkConcurrentMarks(t *testing.T) {
	const n = 200
	wm := NewWatermark(0)
	var wg sync.WaitGroup
	for i := int64(0); i < n; i++ {
		wg.Add(1)
		go func(seq int64) {
			defer wg.Done()
			wm.Mark(seq)
		}(i)
	}
	wg.Wait()
	if got := wm.Value(); got != n {
		t.Fatalf("watermark = %d, want %d", got, n)
	}
}
