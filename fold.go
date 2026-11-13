package dataeng

import (
	"cmp"
	"slices"
	"time"
)

// EventKind distinguishes the two kinds of capture events the folder
// understands. The declaration order matters: EventSnapshot sorts before
// EventRelation so that, at equal capture times, a full snapshot is
// applied before a relationship change.
type EventKind int

const (
	// EventSnapshot is a full snapshot of a resource's attributes. It
	// replaces all previously known attributes and upserts the relations
	// it mentions, but never removes relations it does not mention.
	EventSnapshot EventKind = iota
	// EventRelation is a single relationship change (add or remove).
	EventRelation
)

// RelationOp selects whether a relation event adds or removes a relation.
type RelationOp int

const (
	RelationAdd RelationOp = iota
	RelationRemove
)

// Relation identifies a typed edge from one resource to another.
type Relation struct {
	Kind     string
	TargetID string
}

// Event is one captured observation about a resource. Exactly one payload
// is meaningful, selected by Kind:
//   - EventSnapshot: Attributes and Relations.
//   - EventRelation: Op and Relation.
type Event struct {
	ResourceID string
	CapturedAt time.Time
	Kind       EventKind

	// Snapshot payload.
	Attributes map[string]string
	Relations  []Relation

	// Relationship-change payload.
	Op       RelationOp
	Relation Relation
}

// ResourceState is the folded state of one resource after replaying its
// timeline.
type ResourceState struct {
	ResourceID string
	Attributes map[string]string
	Relations  []Relation
}

// DanglingRelation is a relation that survived folding while pointing at
// a resource that never appeared in the input. Dangling relations are
// kept in the resource state and reported here.
type DanglingRelation struct {
	SourceID string
	Relation Relation
}

// FoldResult is the outcome of folding a batch of events.
type FoldResult struct {
	Resources []ResourceState
	Dangling  []DanglingRelation
}

// Fold replays every resource's events as a timeline, ordered by capture
// time; events captured at the same instant apply snapshots before
// relationship changes. It performs no I/O and never consults an asset
// source: the events are the whole input.
func Fold(events []Event) FoldResult {
	byResource := make(map[string][]Event)
	order := make([]string, 0)
	for _, ev := range events {
		if _, seen := byResource[ev.ResourceID]; !seen {
			order = append(order, ev.ResourceID)
		}
		byResource[ev.ResourceID] = append(byResource[ev.ResourceID], ev)
	}

	known := make(map[string]bool, len(byResource))
	for id := range byResource {
		known[id] = true
	}

	result := FoldResult{}
	for _, id := range order {
		timeline := byResource[id]
		slices.SortStableFunc(timeline, func(a, b Event) int {
			if c := a.CapturedAt.Compare(b.CapturedAt); c != 0 {
				return c
			}
			return cmp.Compare(a.Kind, b.Kind)
		})

		state := ResourceState{ResourceID: id, Attributes: map[string]string{}}
		relations := make(map[Relation]struct{})
		for _, ev := range timeline {
			switch ev.Kind {
			case EventSnapshot:
				state.Attributes = make(map[string]string, len(ev.Attributes))
				for k, v := range ev.Attributes {
					state.Attributes[k] = v
				}
				for _, rel := range ev.Relations {
					relations[rel] = struct{}{}
				}
			case EventRelation:
				switch ev.Op {
				case RelationAdd:
					relations[ev.Relation] = struct{}{}
				case RelationRemove:
					delete(relations, ev.Relation)
				}
			}
		}

		state.Relations = sortedRelations(relations)
		result.Resources = append(result.Resources, state)
		for _, rel := range state.Relations {
			if !known[rel.TargetID] {
				result.Dangling = append(result.Dangling, DanglingRelation{SourceID: id, Relation: rel})
			}
		}
	}

	slices.SortFunc(result.Resources, func(a, b ResourceState) int {
		return cmp.Compare(a.ResourceID, b.ResourceID)
	})
	slices.SortFunc(result.Dangling, func(a, b DanglingRelation) int {
		if c := cmp.Compare(a.SourceID, b.SourceID); c != 0 {
			return c
		}
		return compareRelation(a.Relation, b.Relation)
	})
	return result
}

func sortedRelations(set map[Relation]struct{}) []Relation {
	var out []Relation
	for rel := range set {
		out = append(out, rel)
	}
	slices.SortFunc(out, compareRelation)
	return out
}

func compareRelation(a, b Relation) int {
	if c := cmp.Compare(a.Kind, b.Kind); c != 0 {
		return c
	}
	return cmp.Compare(a.TargetID, b.TargetID)
}
