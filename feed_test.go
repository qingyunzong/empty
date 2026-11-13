package dataeng_test

import (
	"errors"
	"testing"

	dataeng "example.org/dataeng13/q0013"
)

func change(key, value string) dataeng.Event {
	return dataeng.Event{Kind: dataeng.KindChange, Key: key, Value: value}
}

func remove(key string) dataeng.Event {
	return dataeng.Event{Kind: dataeng.KindDelete, Key: key, Reason: dataeng.ReasonRemoved}
}

func changed(key string) dataeng.Event {
	return dataeng.Event{Kind: dataeng.KindDelete, Key: key, Reason: dataeng.ReasonChanged}
}

// snapshot 手工核对视图，期望字面量写死在用例里，不调用被测包生成。
type snapshot struct {
	items      map[string]string
	tombstones map[string]bool
}

func checkView(t *testing.T, v *dataeng.View, want snapshot) {
	t.Helper()
	if v.Len() != len(want.items) {
		t.Fatalf("view size = %d, want %d", v.Len(), len(want.items))
	}
	for key, wantVal := range want.items {
		got, ok := v.Get(key)
		if !ok {
			t.Errorf("key %q missing from view, want %q", key, wantVal)
			continue
		}
		if got != wantVal {
			t.Errorf("view[%q] = %q, want %q", key, got, wantVal)
		}
	}
	for key, wantTomb := range want.tombstones {
		if got := v.Tombstoned(key); got != wantTomb {
			t.Errorf("tombstone[%q] = %v, want %v", key, got, wantTomb)
		}
	}
}

func TestEventSequences(t *testing.T) {
	cases := []struct {
		name   string
		events []dataeng.Event
		want   snapshot
	}{
		{
			name: "later change overrides earlier change",
			events: []dataeng.Event{
				change("a", "1"),
				change("a", "2"),
			},
			want: snapshot{
				items:      map[string]string{"a": "2"},
				tombstones: map[string]bool{"a": false},
			},
		},
		{
			name: "removed writes tombstone over earlier change",
			events: []dataeng.Event{
				change("a", "1"),
				remove("a"),
			},
			want: snapshot{
				items:      map[string]string{},
				tombstones: map[string]bool{"a": true},
			},
		},
		{
			name: "change after tombstone resurrects key",
			events: []dataeng.Event{
				change("a", "1"),
				remove("a"),
				change("a", "3"),
			},
			want: snapshot{
				items:      map[string]string{"a": "3"},
				tombstones: map[string]bool{"a": false},
			},
		},
		{
			name: "removed again after resurrection restores tombstone",
			events: []dataeng.Event{
				change("a", "1"),
				remove("a"),
				change("a", "3"),
				remove("a"),
			},
			want: snapshot{
				items:      map[string]string{},
				tombstones: map[string]bool{"a": true},
			},
		},
		{
			name: "changed drops from view without tombstone",
			events: []dataeng.Event{
				change("a", "1"),
				change("b", "x"),
				changed("a"),
			},
			want: snapshot{
				items:      map[string]string{"b": "x"},
				tombstones: map[string]bool{"a": false, "b": false},
			},
		},
		{
			name: "changed on absent key leaves no tombstone",
			events: []dataeng.Event{
				changed("ghost"),
			},
			want: snapshot{
				items:      map[string]string{},
				tombstones: map[string]bool{"ghost": false},
			},
		},
		{
			name: "removed then changed keeps tombstone",
			events: []dataeng.Event{
				change("a", "1"),
				remove("a"),
				changed("a"),
			},
			want: snapshot{
				items:      map[string]string{},
				tombstones: map[string]bool{"a": true},
			},
		},
		{
			name: "mixed keys interleave independently",
			events: []dataeng.Event{
				change("a", "1"),
				change("b", "1"),
				remove("a"),
				change("b", "2"),
				changed("b"),
				change("a", "9"),
			},
			want: snapshot{
				items:      map[string]string{"a": "9"},
				tombstones: map[string]bool{"a": false, "b": false},
			},
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			v := dataeng.NewView()
			for i, ev := range tc.events {
				if err := v.Apply(ev); err != nil {
					t.Fatalf("event %d: unexpected error: %v", i, err)
				}
			}
			checkView(t, v, tc.want)
		})
	}
}

func TestDeleteReasonValidation(t *testing.T) {
	v := dataeng.NewView()
	bad := dataeng.Event{Kind: dataeng.KindDelete, Key: "a", Reason: "purged"}
	if err := v.Apply(bad); !errors.Is(err, dataeng.ErrBadDeleteReason) {
		t.Fatalf("Apply(bad reason) err = %v, want ErrBadDeleteReason", err)
	}
	if err := v.Apply(dataeng.Event{Kind: dataeng.KindDelete, Key: "a"}); !errors.Is(err, dataeng.ErrBadDeleteReason) {
		t.Fatalf("Apply(empty reason) err = %v, want ErrBadDeleteReason", err)
	}
	if v.Len() != 0 || v.Tombstoned("a") {
		t.Fatal("rejected delete must not mutate the view")
	}
}

func TestLinkConflict(t *testing.T) {
	v := dataeng.NewView()
	page := dataeng.Page{
		Events:    []dataeng.Event{change("a", "1")},
		NextLink:  "https://example.test/feed?page=2",
		DeltaLink: "https://example.test/feed?delta=abc",
	}
	if err := v.ApplyPage(page); !errors.Is(err, dataeng.ErrConflictingLinks) {
		t.Fatalf("ApplyPage err = %v, want ErrConflictingLinks", err)
	}
	if v.Len() != 0 {
		t.Fatal("conflicting page must be rejected before applying events")
	}

	for name, page := range map[string]dataeng.Page{
		"next link only":  {Events: []dataeng.Event{change("a", "1")}, NextLink: "n"},
		"delta link only": {Events: []dataeng.Event{change("b", "2")}, DeltaLink: "d"},
		"no links":        {Events: []dataeng.Event{change("c", "3")}},
	} {
		fresh := dataeng.NewView()
		if err := fresh.ApplyPage(page); err != nil {
			t.Errorf("%s: unexpected error: %v", name, err)
		}
		if fresh.Len() != 1 {
			t.Errorf("%s: view size = %d, want 1", name, fresh.Len())
		}
	}
}
