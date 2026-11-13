package dataeng_test

import (
	"context"
	"errors"
	"fmt"
	"reflect"
	"strconv"
	"strings"
	"testing"

	"example.org/dataeng13/q0017"
)

// numericVersionCompare is a caller-supplied comparator. It deliberately
// orders versions by their numeric suffix, so "v10" is newer than "v9" even
// though a lexical comparison would put "v10" first.
func numericVersionCompare(a, b string) int {
	na, errA := strconv.Atoi(strings.TrimPrefix(a, "v"))
	nb, errB := strconv.Atoi(strings.TrimPrefix(b, "v"))
	if errA != nil || errB != nil {
		return strings.Compare(a, b)
	}
	switch {
	case na < nb:
		return -1
	case na > nb:
		return 1
	default:
		return 0
	}
}

func requireChanges(t *testing.T, got, want []dataeng.Change) {
	t.Helper()
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("changes mismatch\n got: %#v\nwant: %#v", got, want)
	}
}

func requireCache(t *testing.T, follower *dataeng.Follower, want map[string]any) {
	t.Helper()
	if got := follower.Snapshot(); !reflect.DeepEqual(got, want) {
		t.Fatalf("cache mismatch\n got: %#v\nwant: %#v", got, want)
	}
}

func requireVersion(t *testing.T, follower *dataeng.Follower, want string) {
	t.Helper()
	if got := follower.ResourceVersion(); got != want {
		t.Fatalf("resource version = %q, want %q", got, want)
	}
}

func TestEventTypeValues(t *testing.T) {
	tests := []struct {
		eventType dataeng.EventType
		wire      string
	}{
		{dataeng.EventAdded, "ADDED"},
		{dataeng.EventModified, "MODIFIED"},
		{dataeng.EventDeleted, "DELETED"},
		{dataeng.EventBookmark, "BOOKMARK"},
		{dataeng.EventError, "ERROR"},
	}
	for _, test := range tests {
		if got := string(test.eventType); got != test.wire {
			t.Fatalf("event type = %q, want %q", got, test.wire)
		}
		if !test.eventType.Valid() {
			t.Fatalf("event type %q is not valid", test.wire)
		}
	}
	if dataeng.EventType("BOOKMARKED").Valid() {
		t.Fatal("unknown event type reported as valid")
	}
}

func TestObjectEventSequence(t *testing.T) {
	follower := dataeng.NewFollower(numericVersionCompare)

	changes, err := follower.Apply(dataeng.Event{
		Type:            dataeng.EventAdded,
		Key:             "a",
		Object:          "A1",
		ResourceVersion: "v3",
	})
	if err != nil {
		t.Fatalf("add a: %v", err)
	}
	requireChanges(t, changes, []dataeng.Change{{
		Type:            dataeng.EventAdded,
		Key:             "a",
		Object:          "A1",
		ResourceVersion: "v3",
	}})
	requireVersion(t, follower, "v3")
	requireCache(t, follower, map[string]any{"a": "A1"})

	changes, err = follower.Apply(dataeng.Event{
		Type:            dataeng.EventModified,
		Key:             "a",
		Object:          "A2",
		ResourceVersion: "v4",
	})
	if err != nil {
		t.Fatalf("modify a: %v", err)
	}
	requireChanges(t, changes, []dataeng.Change{{
		Type:            dataeng.EventModified,
		Key:             "a",
		Object:          "A2",
		Previous:        "A1",
		ResourceVersion: "v4",
	}})
	requireVersion(t, follower, "v4")

	// An older event must neither be delivered nor move the version back.
	changes, err = follower.Apply(dataeng.Event{
		Type:            dataeng.EventAdded,
		Key:             "b",
		Object:          "B1",
		ResourceVersion: "v2",
	})
	if err != nil {
		t.Fatalf("stale add: %v", err)
	}
	requireChanges(t, changes, nil)
	requireVersion(t, follower, "v4")
	requireCache(t, follower, map[string]any{"a": "A2"})

	// An object event at the current version is still delivered.
	changes, err = follower.Apply(dataeng.Event{
		Type:            dataeng.EventDeleted,
		Key:             "a",
		ResourceVersion: "v4",
	})
	if err != nil {
		t.Fatalf("delete a at current version: %v", err)
	}
	requireChanges(t, changes, []dataeng.Change{{
		Type:            dataeng.EventDeleted,
		Key:             "a",
		Object:          "A2",
		Previous:        "A2",
		ResourceVersion: "v4",
	}})
	requireVersion(t, follower, "v4")
	requireCache(t, follower, map[string]any{})

	changes, err = follower.Apply(dataeng.Event{
		Type:            dataeng.EventAdded,
		Key:             "c",
		Object:          "C1",
		ResourceVersion: "v5",
	})
	if err != nil {
		t.Fatalf("add c: %v", err)
	}
	requireChanges(t, changes, []dataeng.Change{{
		Type:            dataeng.EventAdded,
		Key:             "c",
		Object:          "C1",
		ResourceVersion: "v5",
	}})
	requireVersion(t, follower, "v5")
	requireCache(t, follower, map[string]any{"c": "C1"})
}

func TestBookmarkOnlyAdvancesVersion(t *testing.T) {
	follower := dataeng.NewFollower(numericVersionCompare)

	changes, err := follower.Apply(dataeng.Event{
		Type:            dataeng.EventAdded,
		Key:             "a",
		Object:          "A1",
		ResourceVersion: "v1",
	})
	if err != nil {
		t.Fatalf("add a: %v", err)
	}
	requireChanges(t, changes, []dataeng.Change{{
		Type:            dataeng.EventAdded,
		Key:             "a",
		Object:          "A1",
		ResourceVersion: "v1",
	}})
	requireVersion(t, follower, "v1")
	requireCache(t, follower, map[string]any{"a": "A1"})

	changes, err = follower.Apply(dataeng.Event{
		Type:            dataeng.EventBookmark,
		ResourceVersion: "v2",
	})
	if err != nil {
		t.Fatalf("new bookmark: %v", err)
	}
	if changes != nil {
		t.Fatalf("bookmark produced changes: %#v", changes)
	}
	requireVersion(t, follower, "v2")
	requireCache(t, follower, map[string]any{"a": "A1"})

	// An equal bookmark is ignored.
	changes, err = follower.Apply(dataeng.Event{
		Type:            dataeng.EventBookmark,
		ResourceVersion: "v2",
	})
	if err != nil {
		t.Fatalf("equal bookmark: %v", err)
	}
	if changes != nil {
		t.Fatalf("equal bookmark produced changes: %#v", changes)
	}
	requireVersion(t, follower, "v2")

	// An older bookmark is ignored and cannot move the version backwards.
	changes, err = follower.Apply(dataeng.Event{
		Type:            dataeng.EventBookmark,
		ResourceVersion: "v1",
	})
	if err != nil {
		t.Fatalf("stale bookmark: %v", err)
	}
	if changes != nil {
		t.Fatalf("stale bookmark produced changes: %#v", changes)
	}
	requireVersion(t, follower, "v2")

	// A bookmark advances the version, but an object event at that same
	// version is still delivered.
	changes, err = follower.Apply(dataeng.Event{
		Type:            dataeng.EventModified,
		Key:             "a",
		Object:          "A2",
		ResourceVersion: "v2",
	})
	if err != nil {
		t.Fatalf("modify at bookmark version: %v", err)
	}
	requireChanges(t, changes, []dataeng.Change{{
		Type:            dataeng.EventModified,
		Key:             "a",
		Object:          "A2",
		Previous:        "A1",
		ResourceVersion: "v2",
	}})
	requireVersion(t, follower, "v2")
	requireCache(t, follower, map[string]any{"a": "A2"})

	// Equal object events are delivered too.
	changes, err = follower.Apply(dataeng.Event{
		Type:            dataeng.EventModified,
		Key:             "a",
		Object:          "A3",
		ResourceVersion: "v2",
	})
	if err != nil {
		t.Fatalf("equal object event: %v", err)
	}
	requireChanges(t, changes, []dataeng.Change{{
		Type:            dataeng.EventModified,
		Key:             "a",
		Object:          "A3",
		Previous:        "A2",
		ResourceVersion: "v2",
	}})
	requireCache(t, follower, map[string]any{"a": "A3"})
}

func TestExpiredErrorPreservesCacheAndVersion(t *testing.T) {
	follower := dataeng.NewFollower(numericVersionCompare)
	if _, err := follower.Apply(dataeng.Event{
		Type:            dataeng.EventAdded,
		Key:             "a",
		Object:          "A1",
		ResourceVersion: "v2",
	}); err != nil {
		t.Fatalf("add a: %v", err)
	}
	if _, err := follower.Apply(dataeng.Event{
		Type:            dataeng.EventAdded,
		Key:             "b",
		Object:          "B1",
		ResourceVersion: "v3",
	}); err != nil {
		t.Fatalf("add b: %v", err)
	}

	before := map[string]any{"a": "A1", "b": "B1"}
	wrappedExpired := fmt.Errorf("server says: %w", dataeng.ErrExpired)
	changes, err := follower.Apply(dataeng.Event{
		Type: dataeng.EventError,
		Err:  wrappedExpired,
	})
	if !errors.Is(err, dataeng.ErrExpired) {
		t.Fatalf("expired error = %v, want ErrExpired", err)
	}
	if changes != nil {
		t.Fatalf("expired error produced changes: %#v", changes)
	}
	requireVersion(t, follower, "v3")
	requireCache(t, follower, before)

	// The explicit Expired flag has the same effect even without an Err.
	changes, err = follower.Apply(dataeng.Event{
		Type:    dataeng.EventError,
		Expired: true,
	})
	if !errors.Is(err, dataeng.ErrExpired) {
		t.Fatalf("flagged expired error = %v, want ErrExpired", err)
	}
	if changes != nil {
		t.Fatalf("flagged expired error produced changes: %#v", changes)
	}
	requireVersion(t, follower, "v3")
	requireCache(t, follower, before)
}

func TestNonExpiredErrorStopsWithoutMutation(t *testing.T) {
	follower := dataeng.NewFollower(numericVersionCompare)
	if _, err := follower.Apply(dataeng.Event{
		Type:            dataeng.EventAdded,
		Key:             "a",
		Object:          "A1",
		ResourceVersion: "v1",
	}); err != nil {
		t.Fatalf("add a: %v", err)
	}

	stopErr := errors.New("watch failed")
	changes, err := follower.Apply(dataeng.Event{
		Type:            dataeng.EventError,
		Err:             stopErr,
		ResourceVersion: "v9",
	})
	if err != stopErr {
		t.Fatalf("non-expired error = %v, want %v", err, stopErr)
	}
	if changes != nil {
		t.Fatalf("non-expired error produced changes: %#v", changes)
	}
	requireVersion(t, follower, "v1")
	requireCache(t, follower, map[string]any{"a": "A1"})
}

func TestDeleteUnknownKeyIsReported(t *testing.T) {
	follower := dataeng.NewFollower(numericVersionCompare)
	if _, err := follower.Apply(dataeng.Event{
		Type:            dataeng.EventAdded,
		Key:             "a",
		Object:          "A1",
		ResourceVersion: "v1",
	}); err != nil {
		t.Fatalf("add a: %v", err)
	}

	changes, err := follower.Apply(dataeng.Event{
		Type:            dataeng.EventDeleted,
		Key:             "missing",
		ResourceVersion: "v2",
	})
	if !errors.Is(err, dataeng.ErrUnknownKey) {
		t.Fatalf("delete unknown key error = %v, want ErrUnknownKey", err)
	}
	if changes != nil {
		t.Fatalf("delete unknown key produced changes: %#v", changes)
	}
	requireVersion(t, follower, "v1")
	requireCache(t, follower, map[string]any{"a": "A1"})

	// A later valid deletion at the same version is still accepted.
	changes, err = follower.Apply(dataeng.Event{
		Type:            dataeng.EventDeleted,
		Key:             "a",
		ResourceVersion: "v2",
	})
	if err != nil {
		t.Fatalf("delete a: %v", err)
	}
	requireChanges(t, changes, []dataeng.Change{{
		Type:            dataeng.EventDeleted,
		Key:             "a",
		Object:          "A1",
		Previous:        "A1",
		ResourceVersion: "v2",
	}})
	requireVersion(t, follower, "v2")
	requireCache(t, follower, map[string]any{})
}

func TestCallerComparatorDefinesVersionOrder(t *testing.T) {
	follower := dataeng.NewFollower(numericVersionCompare)

	changes, err := follower.Apply(dataeng.Event{
		Type:            dataeng.EventAdded,
		Key:             "a",
		Object:          "A1",
		ResourceVersion: "v10",
	})
	if err != nil {
		t.Fatalf("add a: %v", err)
	}
	requireChanges(t, changes, []dataeng.Change{{
		Type:            dataeng.EventAdded,
		Key:             "a",
		Object:          "A1",
		ResourceVersion: "v10",
	}})
	requireVersion(t, follower, "v10")

	// Lexically "v9" is greater than "v10", but the caller's comparator says
	// it is older, so this event must be ignored.
	changes, err = follower.Apply(dataeng.Event{
		Type:            dataeng.EventAdded,
		Key:             "b",
		Object:          "B1",
		ResourceVersion: "v9",
	})
	if err != nil {
		t.Fatalf("add b: %v", err)
	}
	if changes != nil {
		t.Fatalf("lexically greater but numerically stale event was delivered: %#v", changes)
	}
	requireVersion(t, follower, "v10")
	requireCache(t, follower, map[string]any{"a": "A1"})

	changes, err = follower.Apply(dataeng.Event{
		Type:            dataeng.EventAdded,
		Key:             "c",
		Object:          "C1",
		ResourceVersion: "v12",
	})
	if err != nil {
		t.Fatalf("add c: %v", err)
	}
	requireChanges(t, changes, []dataeng.Change{{
		Type:            dataeng.EventAdded,
		Key:             "c",
		Object:          "C1",
		ResourceVersion: "v12",
	}})
	requireVersion(t, follower, "v12")
	requireCache(t, follower, map[string]any{"a": "A1", "c": "C1"})
}

func TestFollowStopsOnNonExpiredError(t *testing.T) {
	follower := dataeng.NewFollower(numericVersionCompare)
	stopErr := errors.New("stream broke")
	events := make(chan dataeng.Event, 3)
	events <- dataeng.Event{Type: dataeng.EventAdded, Key: "a", Object: "A1", ResourceVersion: "v1"}
	events <- dataeng.Event{Type: dataeng.EventError, Err: stopErr}
	events <- dataeng.Event{Type: dataeng.EventAdded, Key: "b", Object: "B1", ResourceVersion: "v2"}
	close(events)

	var changes []dataeng.Change
	sink := func(change dataeng.Change) error {
		changes = append(changes, change)
		return nil
	}

	err := follower.Follow(context.Background(), events, sink)
	if err != stopErr {
		t.Fatalf("Follow error = %v, want %v", err, stopErr)
	}
	requireChanges(t, changes, []dataeng.Change{{
		Type:            dataeng.EventAdded,
		Key:             "a",
		Object:          "A1",
		ResourceVersion: "v1",
	}})
	requireVersion(t, follower, "v1")
	requireCache(t, follower, map[string]any{"a": "A1"})
}

func TestFollowExpiredKeepsCacheThenRelist(t *testing.T) {
	follower := dataeng.NewFollower(numericVersionCompare)
	events := make(chan dataeng.Event, 3)
	events <- dataeng.Event{Type: dataeng.EventAdded, Key: "a", Object: "A1", ResourceVersion: "v1"}
	events <- dataeng.Event{Type: dataeng.EventError, Err: dataeng.ErrExpired}
	events <- dataeng.Event{Type: dataeng.EventAdded, Key: "b", Object: "B1", ResourceVersion: "v2"}
	close(events)

	var changes []dataeng.Change
	sink := func(change dataeng.Change) error {
		changes = append(changes, change)
		return nil
	}

	err := follower.Follow(context.Background(), events, sink)
	if !errors.Is(err, dataeng.ErrExpired) {
		t.Fatalf("Follow error = %v, want ErrExpired", err)
	}
	requireChanges(t, changes, []dataeng.Change{{
		Type:            dataeng.EventAdded,
		Key:             "a",
		Object:          "A1",
		ResourceVersion: "v1",
	}})
	requireVersion(t, follower, "v1")
	requireCache(t, follower, map[string]any{"a": "A1"})

	// The relist is a separate, explicit operation performed by the caller.
	relisted, err := follower.Relist([]dataeng.Entry{
		{Key: "a", Object: "A2"},
		{Key: "c", Object: "C1"},
	}, "v7")
	if err != nil {
		t.Fatalf("relist: %v", err)
	}
	requireChanges(t, relisted, []dataeng.Change{
		{
			Type:            dataeng.EventModified,
			Key:             "a",
			Object:          "A2",
			Previous:        "A1",
			ResourceVersion: "v7",
		},
		{
			Type:            dataeng.EventAdded,
			Key:             "c",
			Object:          "C1",
			ResourceVersion: "v7",
		},
	})
	requireVersion(t, follower, "v7")
	requireCache(t, follower, map[string]any{"a": "A2", "c": "C1"})
}

func TestRelistCannotMoveVersionBackwards(t *testing.T) {
	follower := dataeng.NewFollower(numericVersionCompare)
	if _, err := follower.Apply(dataeng.Event{
		Type:            dataeng.EventAdded,
		Key:             "a",
		Object:          "A1",
		ResourceVersion: "v5",
	}); err != nil {
		t.Fatalf("add a: %v", err)
	}
	before := map[string]any{"a": "A1"}

	changes, err := follower.Relist([]dataeng.Entry{{Key: "b", Object: "B1"}}, "v4")
	if !errors.Is(err, dataeng.ErrStaleResourceVersion) {
		t.Fatalf("stale relist error = %v, want ErrStaleResourceVersion", err)
	}
	if changes != nil {
		t.Fatalf("stale relist produced changes: %#v", changes)
	}
	requireVersion(t, follower, "v5")
	requireCache(t, follower, before)
}

func TestInvalidEventsAndComparator(t *testing.T) {
	follower := dataeng.NewFollower(nil)
	changes, err := follower.Apply(dataeng.Event{Type: dataeng.EventAdded, Key: "a", Object: "A1"})
	if !errors.Is(err, dataeng.ErrInvalidComparator) {
		t.Fatalf("nil comparator error = %v, want ErrInvalidComparator", err)
	}
	if changes != nil {
		t.Fatalf("nil comparator produced changes: %#v", changes)
	}

	follower = dataeng.NewFollower(numericVersionCompare)
	changes, err = follower.Apply(dataeng.Event{Type: dataeng.EventType("ADDED_EVENT"), Key: "a"})
	if !errors.Is(err, dataeng.ErrInvalidEvent) {
		t.Fatalf("unknown event type error = %v, want ErrInvalidEvent", err)
	}
	if changes != nil {
		t.Fatalf("unknown event type produced changes: %#v", changes)
	}

	changes, err = follower.Apply(dataeng.Event{Type: dataeng.EventError})
	if !errors.Is(err, dataeng.ErrInvalidEvent) {
		t.Fatalf("empty error event error = %v, want ErrInvalidEvent", err)
	}
	if changes != nil {
		t.Fatalf("empty error event produced changes: %#v", changes)
	}
}
