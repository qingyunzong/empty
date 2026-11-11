// Package batchresp assembles out-of-order segments of a batch response
// into materialized transaction results.
//
// A segment carries a Content-ID, an HTTP-style status code, a decoded
// JSON value and optional references to other segments. References are
// strings of the form "<Content-ID>#<RFC 6901 JSON Pointer>" (for example
// "abc#/items/2/name") and may either appear explicitly in segment refs
// or be embedded in JSON values as {"<refKey>": "<reference>"}.
//
// A transaction group is only handed to the caller once every dependency
// is present and closed. Failed segments transitively fail every segment
// that depends on them, dependency cycles are reported separately, and an
// expansion node budget allows an otherwise unbounded group to be rejected
// as a whole. Materialized values are independent deep copies, so callers
// cannot mutate stored state and shared/diamond dependencies produce
// independent subtrees.
package batchresp

import (
	"errors"
	"fmt"
	"sort"
)

// DefaultRefKey is the JSON object key used to mark an embedded reference
// when no custom key is configured.
const DefaultRefKey = "$ref"

var (
	// ErrDuplicateID is returned when two segments in one group share a
	// Content-ID.
	ErrDuplicateID = errors.New("batchresp: duplicate Content-ID")
	// ErrPending indicates that the group still references segments which
	// have not arrived.
	ErrPending = errors.New("batchresp: group has unresolved inbound dependencies")
	// ErrInvalidRef indicates a malformed reference or JSON Pointer.
	ErrInvalidRef = errors.New("batchresp: invalid reference")
	// ErrUnresolvedRef indicates that a reference could not be resolved at
	// materialization time (missing target, bad pointer, unusable target).
	ErrUnresolvedRef = errors.New("batchresp: unresolved reference")
	// ErrCycle indicates a dependency cycle. The originating segments are
	// listed in Result.Cycles.
	ErrCycle = errors.New("batchresp: dependency cycle")
	// ErrInfiniteExpansion indicates reference expansion descended into its
	// own descendant tree. The dependency graph is checked first, so this
	// is the defensive expansion-stack guard.
	ErrInfiniteExpansion = errors.New("batchresp: reference would expand its own descendant")
	// ErrBudgetExceeded indicates that materializing the group would
	// produce more than the configured number of JSON nodes; the whole
	// group is rejected without partial delivery.
	ErrBudgetExceeded = errors.New("batchresp: node expansion budget exceeded")
	// ErrGroupClosed indicates that a streaming group has already been
	// delivered and no longer accepts segments.
	ErrGroupClosed = errors.New("batchresp: group already closed and delivered")
)

// Segment is one already-parsed batch response part.
type Segment struct {
	// ContentID uniquely identifies the segment inside its group.
	ContentID string
	// StatusCode is the response status code for the segment.
	StatusCode int
	// Value is the decoded JSON value. It is deep-copied on ingestion, so
	// later caller mutations never affect the group.
	Value any
	// Refs optionally lists outgoing references in addition to embedded
	// refKey markers inside Value.
	Refs []string
}

// Cycle reports one dependency cycle as the ordered Content-IDs forming it.
type Cycle struct {
	// Members contains the cycle's Content-IDs in sorted order, independent
	// of segment arrival order.
	Members []string
}

// Result is the materialized outcome of a closed group.
type Result struct {
	// GroupID identifies the transaction group.
	GroupID string
	// Values contains one fully materialized deep copy per successful
	// segment, keyed by Content-ID.
	Values map[string]any
	// Failed contains an error for every failed segment, including
	// directly failed segments and their transitive dependents.
	Failed map[string]error
	// Cycles reports every detected dependency cycle independently of
	// failures.
	Cycles []Cycle
	// Err carries a group-wide rejection (for example ErrBudgetExceeded);
	// when set, Values is nil and the group is not delivered partially.
	Err error
}

// Option customizes a Group.
type Option func(*Group)

// WithRefKey overrides the JSON object key that marks embedded
// references. The default is DefaultRefKey.
func WithRefKey(key string) Option {
	return func(g *Group) { g.refKey = key }
}

// WithFailStatusThreshold sets the minimum status code treated as a
// segment failure. The default is 400.
func WithFailStatusThreshold(code int) Option {
	return func(g *Group) { g.failThreshold = code }
}

// WithNodeBudget caps the number of JSON nodes produced while
// materializing the group. Zero or negative means unlimited. Exceeding
// the budget rejects the whole group with ErrBudgetExceeded.
func WithNodeBudget(budget int) Option {
	return func(g *Group) { g.nodeBudget = budget }
}

// Group accumulates the segments of one transaction group, accepting them
// in any arrival order. A Group is not safe for concurrent use; use
// Resolver for concurrent streaming ingestion.
type Group struct {
	id            string
	segments      map[string]*segmentState
	order         []string
	refKey        string
	failThreshold int
	nodeBudget    int
}

type segmentState struct {
	segment Segment
	deps    map[string]struct{}
	value   any
}

// refMarker is the internal representation of an embedded reference
// marker, replacing the user-visible map[string]any during ingestion so
// it can never be confused with an ordinary JSON object.
type refMarker struct {
	ref Ref
}

// NewGroup creates an empty transaction group.
func NewGroup(groupID string, opts ...Option) *Group {
	g := &Group{
		id:            groupID,
		segments:      make(map[string]*segmentState),
		refKey:        DefaultRefKey,
		failThreshold: 400,
	}
	for _, opt := range opts {
		opt(g)
	}
	return g
}

// Add ingests one segment. The segment value is deep-copied and all of
// its references (explicit and embedded) are parsed up front. A
// duplicated Content-ID is rejected with ErrDuplicateID.
func (g *Group) Add(seg Segment) error {
	if seg.ContentID == "" {
		return fmt.Errorf("%w: empty Content-ID", ErrInvalidRef)
	}
	if _, exists := g.segments[seg.ContentID]; exists {
		return fmt.Errorf("%w: %q already present in group %q",
			ErrDuplicateID, seg.ContentID, g.id)
	}

	state := &segmentState{
		segment: Segment{ContentID: seg.ContentID, StatusCode: seg.StatusCode},
		deps:    make(map[string]struct{}),
	}

	copied, err := g.ingest(seg.Value, state)
	if err != nil {
		return err
	}
	for _, raw := range seg.Refs {
		ref, err := ParseRef(raw)
		if err != nil {
			return err
		}
		state.deps[ref.ID] = struct{}{}
	}
	state.value = copied
	g.segments[seg.ContentID] = state
	g.order = append(g.order, seg.ContentID)
	return nil
}

// ingest deep-copies a decoded JSON value, parses embedded ref markers
// and records every target segment as a dependency.
func (g *Group) ingest(v any, state *segmentState) (any, error) {
	switch node := v.(type) {
	case map[string]any:
		if ref, ok, err := g.scanMarker(node, state); err != nil {
			return nil, err
		} else if ok {
			return refMarker{ref: ref}, nil
		}
		out := make(map[string]any, len(node))
		for key, child := range node {
			copied, err := g.ingest(child, state)
			if err != nil {
				return nil, err
			}
			out[key] = copied
		}
		return out, nil
	case []any:
		out := make([]any, len(node))
		for i, child := range node {
			copied, err := g.ingest(child, state)
			if err != nil {
				return nil, err
			}
			out[i] = copied
		}
		return out, nil
	default:
		// Strings, numbers, booleans, nil and json.Number are immutable
		// decoded-JSON leaf values and can be shared safely.
		return v, nil
	}
}

// scanMarker returns ok=true when the object is exactly
// {"<refKey>": "<reference>"}. Multi-key objects are ordinary JSON.
func (g *Group) scanMarker(node map[string]any, state *segmentState) (Ref, bool, error) {
	if len(node) != 1 {
		return Ref{}, false, nil
	}
	raw, ok := node[g.refKey]
	if !ok {
		return Ref{}, false, nil
	}
	text, ok := raw.(string)
	if !ok {
		return Ref{}, false, fmt.Errorf("%w: %s marker must contain a string",
			ErrInvalidRef, g.refKey)
	}
	ref, err := ParseRef(text)
	if err != nil {
		return Ref{}, false, err
	}
	state.deps[ref.ID] = struct{}{}
	return ref, true, nil
}

// Pending reports the Content-IDs referenced by the group but not yet
// added, in deterministic order. The group cannot be resolved until this
// is empty.
func (g *Group) Pending() []string {
	seen := make(map[string]struct{})
	for _, state := range g.segments {
		for dep := range state.deps {
			if _, ok := g.segments[dep]; !ok {
				seen[dep] = struct{}{}
			}
		}
	}
	pending := make([]string, 0, len(seen))
	for id := range seen {
		pending = append(pending, id)
	}
	sort.Strings(pending)
	return pending
}

// DeepCopy returns an independent deep copy of a decoded JSON value.
func DeepCopy(v any) any {
	switch node := v.(type) {
	case map[string]any:
		out := make(map[string]any, len(node))
		for key, child := range node {
			out[key] = DeepCopy(child)
		}
		return out
	case []any:
		out := make([]any, len(node))
		for i, child := range node {
			out[i] = DeepCopy(child)
		}
		return out
	default:
		return v
	}
}
