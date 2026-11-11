package batchresp

import (
	"fmt"
	"sort"
)

// statusError marks a segment whose own response status indicates failure.
type statusError struct {
	id     string
	status int
}

func (e *statusError) Error() string {
	return fmt.Sprintf("batchresp: segment %q failed with status %d", e.id, e.status)
}

// Resolve materializes the group. It is deterministic: segments may have
// arrived in any order but the returned values, failures and cycles are
// identical for the same input set.
//
// The group must be closed (every referenced segment is present). Direct
// status failures block all transitive dependents; cycles are reported in
// Result.Cycles and their transitive dependents fail; only fully
// successful segments appear in Result.Values. A budget breach rejects the
// entire group via Result.Err.
func (g *Group) Resolve() Result {
	result := Result{GroupID: g.id}

	if pending := g.Pending(); len(pending) > 0 {
		result.Err = fmt.Errorf("%w: missing segment(s) %v", ErrPending, pending)
		return result
	}

	ids := make([]string, 0, len(g.segments))
	for id := range g.segments {
		ids = append(ids, id)
	}
	sort.Strings(ids)

	reverse := g.reverseEdges(ids)
	blocked := make(map[string]error, len(ids))

	for _, id := range ids {
		state := g.segments[id]
		if state.segment.StatusCode >= g.failThreshold {
			blocked[id] = &statusError{id: id, status: state.segment.StatusCode}
		}
	}

	cycles := g.detectCycles()
	result.Cycles = cycles
	for _, cycle := range cycles {
		for _, id := range cycle.Members {
			if _, already := blocked[id]; !already {
				blocked[id] = fmt.Errorf("%w: %v", ErrCycle, cycle.Members)
			}
		}
	}

	g.propagate(blocked, reverse, ids)

	expander := &expander{
		group:      g,
		nodeBudget: g.nodeBudget,
		blocked:    blocked,
	}
	values := make(map[string]any)
	for _, id := range ids {
		if _, bad := blocked[id]; bad {
			continue
		}
		value, err := expander.expandRoot(id)
		if err != nil {
			g.failTree(id, err, blocked, reverse, ids)
			continue
		}
		values[id] = value
	}

	if expander.groupErr != nil {
		result.Err = expander.groupErr
		return result
	}

	if len(blocked) > 0 {
		result.Failed = make(map[string]error, len(blocked))
		for id, err := range blocked {
			result.Failed[id] = err
		}
	}
	if len(values) > 0 {
		result.Values = values
	}
	return result
}

// reverseEdges builds a deterministic reverse dependency map:
// reverse[id] holds every segment that references id.
func (g *Group) reverseEdges(ids []string) map[string][]string {
	reverse := make(map[string][]string, len(ids))
	for _, id := range ids {
		reverse[id] = nil
	}
	for _, id := range ids {
		for dep := range g.segments[id].deps {
			reverse[dep] = append(reverse[dep], id)
		}
	}
	for id := range reverse {
		sort.Strings(reverse[id])
	}
	return reverse
}

// propagate expands the blocked set along reverse edges, so every
// transitive dependent of a failed or cyclic segment fails as well.
func (g *Group) propagate(blocked map[string]error, reverse map[string][]string, ids []string) {
	queue := make([]string, 0, len(blocked))
	queued := make(map[string]bool, len(blocked))
	for id := range blocked {
		queue = append(queue, id)
		queued[id] = true
	}
	sort.Strings(queue)

	for head := 0; head < len(queue); head++ {
		id := queue[head]
		for _, dependent := range reverse[id] {
			if _, already := blocked[dependent]; already {
				continue
			}
			blocked[dependent] = fmt.Errorf("batchresp: segment %q transitively depends on failed segment %q: %w",
				dependent, id, blocked[id])
			if !queued[dependent] {
				queued[dependent] = true
				queue = append(queue, dependent)
			}
		}
	}
}

// failTree marks an expansion-failed segment and propagates the failure
// to all of its transitive dependents.
func (g *Group) failTree(id string, cause error, blocked map[string]error,
	reverse map[string][]string, ids []string) {
	blocked[id] = cause
	g.propagate(blocked, reverse, ids)
}

// expander turns stored values and reference markers into fully
// materialized, independent deep copies while enforcing the node budget
// and a descendant expansion stack.
type expander struct {
	group      *Group
	nodeBudget int
	nodes      int
	groupErr   error
	blocked    map[string]error
	stack      []string
}

// expandRoot materializes one successful root segment.
func (e *expander) expandRoot(id string) (any, error) {
	e.stack = append(e.stack[:0], id)
	return e.walk(e.group.segments[id].value)
}

// walk produces a fresh deep copy of value, replacing ref markers with
// materialized targets. Every produced JSON node counts toward the
// budget.
func (e *expander) walk(value any) (any, error) {
	if e.groupErr != nil {
		return nil, e.groupErr
	}
	e.nodes++
	if e.nodeBudget > 0 && e.nodes > e.nodeBudget {
		e.groupErr = fmt.Errorf("%w: %d nodes produced (budget %d)",
			ErrBudgetExceeded, e.nodes, e.nodeBudget)
		return nil, e.groupErr
	}

	switch node := value.(type) {
	case refMarker:
		return e.expandRef(node.ref)
	case map[string]any:
		out := make(map[string]any, len(node))
		keys := make([]string, 0, len(node))
		for key := range node {
			keys = append(keys, key)
		}
		sort.Strings(keys)
		for _, key := range keys {
			child, err := e.walk(node[key])
			if err != nil {
				return nil, err
			}
			out[key] = child
		}
		return out, nil
	case []any:
		out := make([]any, len(node))
		for i, child := range node {
			expanded, err := e.walk(child)
			if err != nil {
				return nil, err
			}
			out[i] = expanded
		}
		return out, nil
	default:
		return value, nil
	}
}

// expandRef resolves one marker against the target segment's stored
// document and materializes the addressed subtree.
func (e *expander) expandRef(ref Ref) (any, error) {
	if e.onStack(ref.ID) {
		return nil, fmt.Errorf("%w: %q already being expanded", ErrInfiniteExpansion, ref.ID)
	}
	state, ok := e.group.segments[ref.ID]
	if !ok {
		return nil, fmt.Errorf("%w: unknown target %q", ErrUnresolvedRef, ref.ID)
	}
	if _, bad := e.blocked[ref.ID]; bad {
		return nil, fmt.Errorf("%w: target %q is unavailable: %w",
			ErrUnresolvedRef, ref.ID, e.blocked[ref.ID])
	}

	subtree, err := evalPointer(state.value, ref.tokens)
	if err != nil {
		return nil, fmt.Errorf("%w: %q: %w", ErrUnresolvedRef, ref.ID, err)
	}

	e.stack = append(e.stack, ref.ID)
	expanded, err := e.walk(subtree)
	e.stack = e.stack[:len(e.stack)-1]
	if err != nil {
		return nil, err
	}
	return expanded, nil
}

func (e *expander) onStack(id string) bool {
	for _, existing := range e.stack {
		if existing == id {
			return true
		}
	}
	return false
}
