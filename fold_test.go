package dataeng

import (
	"reflect"
	"testing"
	"time"
)

// All expectations in this file are written by hand from the folding
// rules; none of them are derived from the package under test.

var base = time.Date(2026, 11, 13, 10, 0, 0, 0, time.UTC)

func at(seconds int) time.Time { return base.Add(time.Duration(seconds) * time.Second) }

func snapshot(id string, t time.Time, attrs map[string]string, rels ...Relation) Event {
	return Event{ResourceID: id, CapturedAt: t, Kind: EventSnapshot, Attributes: attrs, Relations: rels}
}

func relEvent(id string, t time.Time, op RelationOp, rel Relation) Event {
	return Event{ResourceID: id, CapturedAt: t, Kind: EventRelation, Op: op, Relation: rel}
}

func findResource(t *testing.T, got FoldResult, id string) ResourceState {
	t.Helper()
	for _, res := range got.Resources {
		if res.ResourceID == id {
			return res
		}
	}
	t.Fatalf("resource %q missing from fold result", id)
	return ResourceState{}
}

// 并列: events captured at the same instant must apply the full snapshot
// before the relationship change, regardless of input order.
func TestFoldTieSnapshotBeforeRelationChange(t *testing.T) {
	same := at(30)
	events := []Event{
		// The removal is listed first on purpose: input order must not
		// decide the outcome of a tie.
		relEvent("app", same, RelationRemove, Relation{Kind: "depends-on", TargetID: "db"}),
		relEvent("app", same, RelationAdd, Relation{Kind: "depends-on", TargetID: "cache"}),
		snapshot("app", same, map[string]string{"image": "app:2"}, Relation{Kind: "depends-on", TargetID: "db"}),
	}

	got := Fold(events)
	res := findResource(t, got, "app")

	wantAttrs := map[string]string{"image": "app:2"}
	if !reflect.DeepEqual(res.Attributes, wantAttrs) {
		t.Errorf("attributes = %v, want %v", res.Attributes, wantAttrs)
	}

	// The snapshot re-mentions depends-on/db, but the removal at the same
	// instant applies after the snapshot, so db is gone; cache is added
	// after the snapshot, so it stays.
	wantRels := []Relation{{Kind: "depends-on", TargetID: "cache"}}
	if !reflect.DeepEqual(res.Relations, wantRels) {
		t.Errorf("relations = %v, want %v", res.Relations, wantRels)
	}

	// cache never appears as a resource, so the surviving relation is
	// dangling and must be reported.
	wantDangling := []DanglingRelation{
		{SourceID: "app", Relation: Relation{Kind: "depends-on", TargetID: "cache"}},
	}
	if !reflect.DeepEqual(got.Dangling, wantDangling) {
		t.Errorf("dangling = %v, want %v", got.Dangling, wantDangling)
	}
}

// 悬挂关系: a relation whose target never appears in the input is kept in
// the resource state and reported as dangling.
func TestFoldDanglingRelationKeptAndReported(t *testing.T) {
	events := []Event{
		snapshot("db", at(0), map[string]string{"engine": "postgres"}),
		snapshot("app", at(1), map[string]string{"image": "app:1"},
			Relation{Kind: "depends-on", TargetID: "db"},
			Relation{Kind: "depends-on", TargetID: "ghost"},
		),
	}

	got := Fold(events)
	res := findResource(t, got, "app")

	wantRels := []Relation{
		{Kind: "depends-on", TargetID: "db"},
		{Kind: "depends-on", TargetID: "ghost"},
	}
	if !reflect.DeepEqual(res.Relations, wantRels) {
		t.Errorf("relations = %v, want %v", res.Relations, wantRels)
	}

	wantDangling := []DanglingRelation{
		{SourceID: "app", Relation: Relation{Kind: "depends-on", TargetID: "ghost"}},
	}
	if !reflect.DeepEqual(got.Dangling, wantDangling) {
		t.Errorf("dangling = %v, want %v", got.Dangling, wantDangling)
	}
}

// 快照范围: a snapshot replaces every attribute, but relations it does
// not mention survive.
func TestFoldSnapshotScope(t *testing.T) {
	events := []Event{
		snapshot("app", at(0),
			map[string]string{"image": "app:1", "replicas": "2"},
			Relation{Kind: "runs-on", TargetID: "host1"},
		),
		relEvent("app", at(10), RelationAdd, Relation{Kind: "depends-on", TargetID: "db"}),
		snapshot("app", at(20),
			map[string]string{"image": "app:2"},
			Relation{Kind: "runs-on", TargetID: "host2"},
		),
	}

	got := Fold(events)
	res := findResource(t, got, "app")

	// The second snapshot wipes image:app:1 and replicas entirely.
	wantAttrs := map[string]string{"image": "app:2"}
	if !reflect.DeepEqual(res.Attributes, wantAttrs) {
		t.Errorf("attributes = %v, want %v", res.Attributes, wantAttrs)
	}

	// runs-on/host1 and depends-on/db are not mentioned by the second
	// snapshot, so they must survive alongside runs-on/host2.
	wantRels := []Relation{
		{Kind: "depends-on", TargetID: "db"},
		{Kind: "runs-on", TargetID: "host1"},
		{Kind: "runs-on", TargetID: "host2"},
	}
	if !reflect.DeepEqual(res.Relations, wantRels) {
		t.Errorf("relations = %v, want %v", res.Relations, wantRels)
	}
}

// 时间线重放: events are replayed in capture-time order even when the
// input lists them out of order.
func TestFoldReplaysByCaptureTime(t *testing.T) {
	events := []Event{
		// Newer events are deliberately listed before older ones.
		snapshot("app", at(20), map[string]string{"image": "app:2"}),
		relEvent("app", at(15), RelationRemove, Relation{Kind: "depends-on", TargetID: "db"}),
		snapshot("app", at(0), map[string]string{"image": "app:1"}, Relation{Kind: "depends-on", TargetID: "db"}),
		relEvent("app", at(5), RelationAdd, Relation{Kind: "depends-on", TargetID: "db"}),
	}

	got := Fold(events)
	res := findResource(t, got, "app")

	wantAttrs := map[string]string{"image": "app:2"}
	if !reflect.DeepEqual(res.Attributes, wantAttrs) {
		t.Errorf("attributes = %v, want %v", res.Attributes, wantAttrs)
	}

	// Replay order: snapshot mentions db (t=0), add db (t=5), remove db
	// (t=15), final snapshot mentions no relations (t=20) and must not
	// resurrect db.
	if res.Relations != nil {
		t.Errorf("relations = %v, want none", res.Relations)
	}

	wantDangling := []DanglingRelation(nil)
	if !reflect.DeepEqual(got.Dangling, wantDangling) {
		t.Errorf("dangling = %v, want none", got.Dangling)
	}
}

// Removing a relation that was never added is a no-op, and resources are
// reported sorted by ID.
func TestFoldRemoveMissingRelationAndResourceOrder(t *testing.T) {
	events := []Event{
		relEvent("zeta", at(0), RelationRemove, Relation{Kind: "depends-on", TargetID: "db"}),
		snapshot("alpha", at(0), map[string]string{"image": "alpha:1"}),
	}

	got := Fold(events)

	var ids []string
	for _, res := range got.Resources {
		ids = append(ids, res.ResourceID)
	}
	wantIDs := []string{"alpha", "zeta"}
	if !reflect.DeepEqual(ids, wantIDs) {
		t.Errorf("resource order = %v, want %v", ids, wantIDs)
	}

	zeta := findResource(t, got, "zeta")
	if zeta.Relations != nil {
		t.Errorf("zeta relations = %v, want none", zeta.Relations)
	}
	if len(got.Dangling) != 0 {
		t.Errorf("dangling = %v, want none", got.Dangling)
	}
}
