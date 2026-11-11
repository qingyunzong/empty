package batchresp

import (
	"errors"
	"sync"
	"testing"
)

func TestResolverConcurrentAdd(t *testing.T) {
	var mu sync.Mutex
	var delivered []Result
	resolver := NewResolver(func(result Result) {
		mu.Lock()
		delivered = append(delivered, result)
		mu.Unlock()
	})

	segments := []Segment{
		{ContentID: "a", StatusCode: 200, Value: map[string]any{"$ref": "b#"}},
		{ContentID: "b", StatusCode: 200, Value: map[string]any{"$ref": "c#"}},
		{ContentID: "c", StatusCode: 200, Value: map[string]any{"ok": true}},
	}

	var wg sync.WaitGroup
	for attempt := 0; attempt < 20; attempt++ {
		for _, seg := range segments {
			wg.Add(1)
			go func(seg Segment) {
				defer wg.Done()
				if err := resolver.Add("concurrent", seg); err != nil {
					if !errors.Is(err, ErrDuplicateID) && !errors.Is(err, ErrGroupClosed) {
						t.Errorf("Add: %v", err)
					}
				}
			}(seg)
		}
	}
	wg.Wait()

	mu.Lock()
	defer mu.Unlock()
	if len(delivered) == 0 {
		t.Fatalf("group never delivered under concurrent adds")
	}
	groupIDs := map[string]bool{}
	for _, result := range delivered {
		if result.GroupID != "concurrent" {
			t.Fatalf("unexpected group %q", result.GroupID)
		}
		if result.Err != nil {
			t.Fatalf("delivered group error: %v", result.Err)
		}
		groupIDs[result.GroupID] = true
	}
	if len(groupIDs) != 1 {
		t.Fatalf("deliveries span unexpected groups: %v", groupIDs)
	}
}
