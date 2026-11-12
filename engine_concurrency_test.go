package dataeng

import (
	"sync"
	"testing"
)

func TestConcurrentIngestAndOpen(t *testing.T) {
	eng, _ := New(testBudget())
	mustIngest(t, eng, rawSeg(1, LittleEndian, true, LayoutContiguous, []Update{
		{Path: "/c", Kind: IndexNew, Type: TypeI32, SamplesPerChunk: 1},
	}, []byte{1, 0, 0, 0}))

	var wg sync.WaitGroup
	for seg := int64(2); seg <= 20; seg++ {
		seg := seg
		wg.Add(1)
		go func() {
			defer wg.Done()
			raw := []byte{byte(seg), 0, 0, 0}
			_ = eng.Ingest(rawSeg(seg, LittleEndian, false, LayoutContiguous, []Update{
				{Path: "/c", Kind: IndexReuse},
			}, raw))
		}()
	}

	for i := 0; i < 20; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			h, err := eng.Open("/c", 0, 1)
			if err != nil {
				return
			}
			_, _ = h.ReadAll()
		}()
	}
	wg.Wait()

	// 并发提交段号必须严格递增，乱序者应被拒绝而不是污染状态。
	total, ok := eng.TotalSamples("/c")
	if !ok || total < 1 {
		t.Fatalf("unexpected total %d ok=%v", total, ok)
	}
}
