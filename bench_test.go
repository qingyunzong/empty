package dataeng

import "testing"

func BenchmarkPlanSplitMaxScale(b *testing.B) {
	req := Request{Slots: 128, MaxPairs: 1_000_000_000_000}
	for i := 0; i < MaxKeys; i++ {
		key := string(rune('a'+i/26)) + string(rune('a'+i%26))
		req.Left = append(req.Left, KeyCount{key, 1_000_000_000_000})
		req.Right = append(req.Right, KeyCount{key, 1})
	}
	b.ResetTimer()
	for n := 0; n < b.N; n++ {
		plan, err := PlanSplit(req)
		if err != nil {
			b.Fatal(err)
		}
		if len(plan.Splits) != MaxKeys {
			b.Fatalf("want %d splits", MaxKeys)
		}
	}
}

func BenchmarkPlanSplitWorstOptionFanout(b *testing.B) {
	req := Request{Slots: 128, MaxPairs: 1_000_000_000_000}
	for i := 0; i < MaxKeys; i++ {
		key := string(rune('a'+i/26)) + string(rune('a'+i%26))
		req.Left = append(req.Left, KeyCount{key, 100})
		req.Right = append(req.Right, KeyCount{key, 100})
	}
	b.ResetTimer()
	for n := 0; n < b.N; n++ {
		if _, err := PlanSplit(req); err != nil {
			b.Fatal(err)
		}
	}
}
