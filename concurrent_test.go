package dataeng

import (
	"sync"
	"testing"
)

func TestConcurrentIngestIsSafe(t *testing.T) {
	s := New()
	var wg sync.WaitGroup

	for regionIndex := 0; regionIndex < 8; regionIndex++ {
		region := string(rune('a' + regionIndex))
		wg.Add(1)
		go func() {
			defer wg.Done()
			for counter := uint64(1); counter <= 25; counter++ {
				record := rec("hot", region,
					VersionVector{region: counter},
					"v", false, region+"-"+itoa(counter))
				if _, err := s.Apply(record); err != nil {
					t.Errorf("apply: %v", err)
					return
				}
				_, _ = s.Versions("hot")
			}
		}()
	}

	wg.Wait()

	versions, ok := s.Versions("hot")
	if !ok || len(versions) != 8 {
		t.Fatalf("expected one retained version per forked region, got %d", len(versions))
	}

	snapshot := s.Snapshot()
	snapshot["hot"][0].Value[0] = 'Z'
	again, _ := s.Versions("hot")
	if again[0].Value[0] == 'Z' {
		t.Fatal("Snapshot must return deep copies isolated from store state")
	}

	resolved := s.ResolveAll(RegionPriorityPolicy{Priority: []string{"a"}})
	if len(resolved) != 1 || resolved[0] != "hot" || s.HasConflict("hot") {
		t.Fatalf("ResolveAll did not converge conflict: %v", resolved)
	}
}

func itoa(n uint64) string {
	if n == 0 {
		return "0"
	}
	var buf [20]byte
	i := len(buf)
	for n > 0 {
		i--
		buf[i] = byte('0' + n%10)
		n /= 10
	}
	return string(buf[i:])
}
