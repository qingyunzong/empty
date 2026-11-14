package dataeng

import (
	"errors"
	"fmt"
	"reflect"
	"strconv"
	"sync"
	"time"
)

var (
	// ErrFactClosed is returned when a fact that has already been finalized is
	// updated again.
	ErrFactClosed = errors.New("dataeng: fact is already closed")

	// ErrFactNotFound is returned when a requested fact is not present.
	ErrFactNotFound = errors.New("dataeng: fact not found")

	// ErrWatermarkRegression is returned by strict watermark updates.
	ErrWatermarkRegression = errors.New("dataeng: watermark cannot move backwards")
)

// Fact is an event that is joined to a dimension version using its own
// EventTime. ID is the stable identity used for result revisions; when empty,
// an ID is derived from Key and EventTime.
type Fact struct {
	ID        string    `json:"id"`
	Key       string    `json:"key"`
	EventTime time.Time `json:"event_time"`
	Value     any       `json:"value,omitempty"`
}

// FactEvent is an alias for Fact.
type FactEvent = Fact

// FactRecord is an alias for Fact.
type FactRecord = Fact

// FactRow is an alias for Fact.
type FactRow = Fact

// Event is an alias for Fact.
type Event = Fact

// Result is the current lookup-join result for one fact. Version is a snapshot:
// once a result is finalized, later dimension changes do not alter it.
type Result struct {
	FactID    string         `json:"fact_id"`
	Key       string         `json:"key"`
	EventTime time.Time      `json:"event_time"`
	Matched   bool           `json:"matched"`
	Version   Version        `json:"version"`
	Fact      any            `json:"fact,omitempty"`
	Value     any            `json:"value,omitempty"`
	Fields    map[string]any `json:"fields,omitempty"`
	Revision  uint64         `json:"revision"`
	Finalized bool           `json:"finalized"`
}

// JoinResult is an alias for Result.
type JoinResult = Result

// LookupResult is an alias for Result.
type LookupResult = Result

// JoinedRow is an alias for Result.
type JoinedRow = Result

// RevisionKind identifies why a result was emitted again.
type RevisionKind int

const (
	// RevisionInsert is the first result for a fact.
	RevisionInsert RevisionKind = iota
	// RevisionUpdate is a result changed by a late dimension version or by a
	// repeated fact update.
	RevisionUpdate
	// RevisionFinalize marks the result as closed by the watermark.
	RevisionFinalize
)

// RevisionRevised is an alias for RevisionUpdate.
const RevisionRevised = RevisionUpdate

func (k RevisionKind) String() string {
	switch k {
	case RevisionInsert:
		return "insert"
	case RevisionUpdate:
		return "update"
	case RevisionFinalize:
		return "finalize"
	default:
		return fmt.Sprintf("RevisionKind(%d)", int(k))
	}
}

// Revision is an output record for a downstream pipeline. Previous is nil for
// RevisionInsert and contains the superseded result for RevisionUpdate and
// RevisionFinalize.
type Revision struct {
	Kind     RevisionKind `json:"kind"`
	Result   Result       `json:"result"`
	Previous *Result      `json:"previous,omitempty"`
}

type factState struct {
	fact      Fact
	result    Result
	finalized bool
}

// LookupJoin is the stateful temporal lookup-join component. It owns a
// versioned dimension Table, all joined facts, and the event-time watermark.
// It is safe for concurrent use.
type LookupJoin struct {
	mu           sync.Mutex
	table        *Table
	watermark    time.Time
	hasWatermark bool
	facts        map[string]*factState
	order        []string
	history      map[string][]Result
	revisions    []Revision
}

// NewLookupJoin returns a lookup-join state backed by the optional table. With
// no table (or a nil table) it creates its own dimension table.
func NewLookupJoin(tables ...*Table) *LookupJoin {
	var table *Table
	if len(tables) > 0 {
		table = tables[0]
	}
	if table == nil {
		table = NewTable()
	}
	return &LookupJoin{
		table:   table,
		facts:   make(map[string]*factState),
		history: make(map[string][]Result),
	}
}

// NewLookupJoinState is an alias for NewLookupJoin.
func NewLookupJoinState(tables ...*Table) *LookupJoin { return NewLookupJoin(tables...) }

// NewTemporalJoinState is an alias for NewLookupJoin.
func NewTemporalJoinState(tables ...*Table) *LookupJoin { return NewLookupJoin(tables...) }

// NewTemporalLookupJoin is an alias for NewLookupJoin.
func NewTemporalLookupJoin(tables ...*Table) *LookupJoin { return NewLookupJoin(tables...) }

// NewTemporalLookupJoinState is an alias for NewLookupJoin.
func NewTemporalLookupJoinState(tables ...*Table) *LookupJoin {
	return NewLookupJoin(tables...)
}

// NewState returns a lookup-join state. With no argument it creates its own
// dimension table; with one argument it uses that table.
func NewState(tables ...*Table) *LookupJoin {
	return NewLookupJoin(tables...)
}

// NewTemporalState is an alias for NewState.
func NewTemporalState(tables ...*Table) *LookupJoin { return NewState(tables...) }

// LookupJoinState is an alias for LookupJoin.
type LookupJoinState = LookupJoin

// TemporalJoinState is an alias for LookupJoin.
type TemporalJoinState = LookupJoin

// TemporalLookupJoin is an alias for LookupJoin.
type TemporalLookupJoin = LookupJoin

// State is an alias for LookupJoin.
type State = LookupJoin

// Table returns the underlying temporal table.
func (j *LookupJoin) Table() *Table { return j.table }

// Apply applies a dimension change and immediately revises all still-open
// facts whose joined version changed. Quarantined changes do not alter results.
func (j *LookupJoin) Apply(change DimensionChange) error {
	return j.ApplyDimension(change)
}

// ApplyDimension is the stateful form of Table.Apply. It emits revisions for
// open facts affected by the new version.
func (j *LookupJoin) ApplyDimension(change DimensionChange) error {
	j.mu.Lock()
	defer j.mu.Unlock()

	if err := j.table.Apply(change); err != nil {
		return err
	}
	for _, id := range j.order {
		state := j.facts[id]
		if state == nil || state.finalized {
			continue
		}
		next := j.joinLocked(state.fact, state.result.Revision)
		next.Finalized = false
		if sameJoinResult(state.result, next) {
			continue
		}
		if sameJoinPayload(state.result, next) {
			// Only the version provenance changed (for example a higher source
			// sequence with an identical payload). Keep downstream quiet while
			// refreshing the current snapshot.
			state.result = next
			j.history[id] = append(j.history[id], copyResult(next))
			continue
		}
		previous := copyResult(state.result)
		next.Revision = state.result.Revision + 1
		state.result = next
		j.history[id] = append(j.history[id], copyResult(next))
		j.revisions = append(j.revisions, Revision{
			Kind:     RevisionUpdate,
			Result:   copyResult(next),
			Previous: &previous,
		})
	}
	return nil
}

// ProcessDimension is an alias for ApplyDimension.
func (j *LookupJoin) ProcessDimension(change DimensionChange) error {
	return j.ApplyDimension(change)
}

// ApplyFact inserts or updates a fact, joins it at its own EventTime, and
// returns the current result. An update to a finalized fact is rejected.
func (j *LookupJoin) ApplyFact(fact Fact) (Result, error) {
	j.mu.Lock()
	defer j.mu.Unlock()

	fact.ID = factID(fact)
	fact = cloneFact(fact)

	if state, ok := j.facts[fact.ID]; ok {
		if state.finalized {
			return copyResult(state.result), ErrFactClosed
		}
		next := j.joinLocked(fact, state.result.Revision)
		next.Finalized = false
		if sameJoinResult(state.result, next) {
			state.fact = fact
			return copyResult(state.result), nil
		}
		if sameJoinPayload(state.result, next) {
			state.fact = fact
			state.result = next
			j.history[fact.ID] = append(j.history[fact.ID], copyResult(next))
			return copyResult(next), nil
		}
		previous := copyResult(state.result)
		next.Revision = state.result.Revision + 1
		state.fact = fact
		state.result = next
		j.history[fact.ID] = append(j.history[fact.ID], copyResult(next))
		j.revisions = append(j.revisions, Revision{
			Kind:     RevisionUpdate,
			Result:   copyResult(next),
			Previous: &previous,
		})
		return copyResult(next), nil
	}

	result := j.joinLocked(fact, 1)
	result.Finalized = j.isClosedLocked(fact.EventTime)
	state := &factState{
		fact:      fact,
		result:    result,
		finalized: result.Finalized,
	}
	j.facts[fact.ID] = state
	j.order = append(j.order, fact.ID)
	j.history[fact.ID] = append(j.history[fact.ID], copyResult(result))
	j.revisions = append(j.revisions, Revision{
		Kind:   RevisionInsert,
		Result: copyResult(result),
	})
	return copyResult(result), nil
}

// ProcessFact is an alias for ApplyFact.
func (j *LookupJoin) ProcessFact(fact Fact) (Result, error) { return j.ApplyFact(fact) }

// AddFact is an alias for ApplyFact.
func (j *LookupJoin) AddFact(fact Fact) (Result, error) { return j.ApplyFact(fact) }

// JoinFact is an alias for ApplyFact.
func (j *LookupJoin) JoinFact(fact Fact) (Result, error) { return j.ApplyFact(fact) }

// Join performs a pure as-of join without storing the fact. The bool reports
// whether a dimension version matched.
func (j *LookupJoin) Join(fact Fact) (Result, bool) {
	j.mu.Lock()
	defer j.mu.Unlock()
	fact.ID = factID(fact)
	result := j.joinLocked(fact, 1)
	return result, result.Matched
}

// Lookup exposes the underlying as-of dimension lookup.
func (j *LookupJoin) Lookup(key string, at time.Time) (Version, bool) {
	return j.table.Lookup(key, at)
}

func (j *LookupJoin) joinLocked(fact Fact, revision uint64) Result {
	result := Result{
		FactID:    fact.ID,
		Key:       fact.Key,
		EventTime: fact.EventTime,
		Fact:      cloneValue(fact.Value),
		Revision:  revision,
	}
	version, ok := j.table.Lookup(fact.Key, fact.EventTime)
	if !ok {
		return result
	}
	result.Matched = true
	result.Version = version
	result.Value = cloneValue(version.Value)
	result.Fields = mergeFields(fact.Value, version.Value)
	return result
}

// AdvanceWatermark closes every fact whose EventTime is at or before at and
// returns the newly finalized results. A backwards watermark is ignored; use
// AdvanceWatermarkStrict to receive ErrWatermarkRegression instead.
func (j *LookupJoin) AdvanceWatermark(at time.Time) []Result {
	j.mu.Lock()
	defer j.mu.Unlock()
	if j.hasWatermark && at.Before(j.watermark) {
		return nil
	}
	return j.advanceWatermarkLocked(at)
}

// SetWatermark is an alias for AdvanceWatermark.
func (j *LookupJoin) SetWatermark(at time.Time) []Result { return j.AdvanceWatermark(at) }

// Finalize is an alias for AdvanceWatermark.
func (j *LookupJoin) Finalize(at time.Time) []Result { return j.AdvanceWatermark(at) }

// AdvanceWatermarkStrict is AdvanceWatermark with regression detection.
func (j *LookupJoin) AdvanceWatermarkStrict(at time.Time) ([]Result, error) {
	j.mu.Lock()
	defer j.mu.Unlock()
	if j.hasWatermark && at.Before(j.watermark) {
		return nil, ErrWatermarkRegression
	}
	return j.advanceWatermarkLocked(at), nil
}

func (j *LookupJoin) advanceWatermarkLocked(at time.Time) []Result {
	j.watermark = at
	j.hasWatermark = true
	var closed []Result
	for _, id := range j.order {
		state := j.facts[id]
		if state == nil || state.finalized || factAfter(state.fact.EventTime, at) {
			continue
		}
		previous := copyResult(state.result)
		state.finalized = true
		state.result.Finalized = true
		j.history[id] = append(j.history[id], copyResult(state.result))
		j.revisions = append(j.revisions, Revision{
			Kind:     RevisionFinalize,
			Result:   copyResult(state.result),
			Previous: &previous,
		})
		closed = append(closed, copyResult(state.result))
	}
	return closed
}

func factAfter(eventTime, watermark time.Time) bool {
	return eventTime.After(watermark)
}

func (j *LookupJoin) isClosedLocked(eventTime time.Time) bool {
	return j.hasWatermark && !eventTime.After(j.watermark)
}

// Watermark returns the current watermark. A zero value means no watermark has
// been set yet; use HasWatermark to distinguish that from an epoch watermark.
func (j *LookupJoin) Watermark() time.Time {
	j.mu.Lock()
	defer j.mu.Unlock()
	return j.watermark
}

// HasWatermark reports whether a watermark has been set.
func (j *LookupJoin) HasWatermark() bool {
	j.mu.Lock()
	defer j.mu.Unlock()
	return j.hasWatermark
}

// Result returns the current or final result for a fact.
func (j *LookupJoin) Result(id string) (Result, bool) {
	j.mu.Lock()
	defer j.mu.Unlock()
	state, ok := j.facts[id]
	if !ok {
		return Result{}, false
	}
	return copyResult(state.result), true
}

// Query is an alias for Result.
func (j *LookupJoin) Query(id string) (Result, bool) { return j.Result(id) }

// Results returns all facts in insertion order.
func (j *LookupJoin) Results() []Result {
	j.mu.Lock()
	defer j.mu.Unlock()
	out := make([]Result, 0, len(j.order))
	for _, id := range j.order {
		if state := j.facts[id]; state != nil {
			out = append(out, copyResult(state.result))
		}
	}
	return out
}

// Conflicts returns the dimension-table quarantine list.
func (j *LookupJoin) Conflicts() []Conflict { return j.table.Conflicts() }

// TakeConflicts returns and clears the dimension-table quarantine list.
func (j *LookupJoin) TakeConflicts() []Conflict { return j.table.TakeConflicts() }

// History returns the result snapshots for a fact, oldest first.
func (j *LookupJoin) History(id string) []Result {
	j.mu.Lock()
	defer j.mu.Unlock()
	snapshots := j.history[id]
	out := make([]Result, len(snapshots))
	for i := range snapshots {
		out[i] = copyResult(snapshots[i])
	}
	return out
}

// Revisions returns all emitted revisions in order.
func (j *LookupJoin) Revisions() []Revision {
	j.mu.Lock()
	defer j.mu.Unlock()
	return copyRevisions(j.revisions)
}

// TakeRevisions returns and clears the revision log.
func (j *LookupJoin) TakeRevisions() []Revision {
	j.mu.Lock()
	defer j.mu.Unlock()
	out := copyRevisions(j.revisions)
	j.revisions = nil
	return out
}

// Compact compacts the dimension history. Current and historical query results
// are unchanged because only adjacent versions with identical payloads are
// merged. It returns the number of dimension versions removed.
func (j *LookupJoin) Compact() int {
	// Table locks are acquired without holding the join lock so a concurrent
	// lookup cannot create a lock-order cycle.
	return j.table.Compact()
}

// Clone returns an independent copy of the join state. The copy observes the
// same open facts up to the current watermark.
func (j *LookupJoin) Clone() *LookupJoin {
	j.mu.Lock()
	defer j.mu.Unlock()

	out := NewLookupJoin(j.table.Clone())
	out.watermark = j.watermark
	out.hasWatermark = j.hasWatermark
	out.order = append([]string(nil), j.order...)
	for id, state := range j.facts {
		cp := &factState{
			fact:      cloneFact(state.fact),
			result:    copyResult(state.result),
			finalized: state.finalized,
		}
		out.facts[id] = cp
	}
	for id, snapshots := range j.history {
		out.history[id] = make([]Result, len(snapshots))
		for i := range snapshots {
			out.history[id][i] = copyResult(snapshots[i])
		}
	}
	out.revisions = copyRevisions(j.revisions)
	return out
}

func factID(fact Fact) string {
	if fact.ID != "" {
		return fact.ID
	}
	return fact.Key + "\x00" + strconv.FormatInt(fact.EventTime.UnixNano(), 10)
}

func cloneFact(fact Fact) Fact {
	fact.Value = cloneValue(fact.Value)
	return fact
}

func copyResult(result Result) Result {
	result.Fact = cloneValue(result.Fact)
	result.Value = cloneValue(result.Value)
	result.Version = copyVersion(result.Version, result.Version.ValidTo)
	result.Fields = cloneStringMap(result.Fields)
	return result
}

func copyRevisions(in []Revision) []Revision {
	out := make([]Revision, len(in))
	for i, revision := range in {
		out[i] = Revision{
			Kind:   revision.Kind,
			Result: copyResult(revision.Result),
		}
		if revision.Previous != nil {
			previous := copyResult(*revision.Previous)
			out[i].Previous = &previous
		}
	}
	return out
}

func sameJoinResult(a, b Result) bool {
	if a.FactID != b.FactID ||
		a.Key != b.Key ||
		!a.EventTime.Equal(b.EventTime) ||
		a.Matched != b.Matched ||
		!reflect.DeepEqual(a.Fact, b.Fact) ||
		!reflect.DeepEqual(a.Value, b.Value) ||
		!reflect.DeepEqual(a.Fields, b.Fields) {
		return false
	}
	if !a.Matched && !b.Matched {
		return true
	}
	return a.Version.Key == b.Version.Key &&
		a.Version.ValidFrom.Equal(b.Version.ValidFrom) &&
		a.Version.SourceSequence == b.Version.SourceSequence &&
		reflect.DeepEqual(a.Version.Value, b.Version.Value)
}

func sameJoinPayload(a, b Result) bool {
	return a.FactID == b.FactID &&
		a.Key == b.Key &&
		a.EventTime.Equal(b.EventTime) &&
		a.Matched == b.Matched &&
		reflect.DeepEqual(a.Fact, b.Fact) &&
		reflect.DeepEqual(a.Value, b.Value) &&
		reflect.DeepEqual(a.Fields, b.Fields)
}

func cloneStringMap(in map[string]any) map[string]any {
	if in == nil {
		return nil
	}
	out := make(map[string]any, len(in))
	for key, value := range in {
		out[key] = cloneValue(value)
	}
	return out
}

// mergeFields builds a join row for the common map-based pipeline payload. The
// dimension payload wins on name collisions.
func mergeFields(fact, dimension any) map[string]any {
	factFields := asFields(fact)
	dimensionFields := asFields(dimension)
	if factFields == nil && dimensionFields == nil {
		return nil
	}
	out := make(map[string]any, len(factFields)+len(dimensionFields))
	for key, value := range factFields {
		out[key] = cloneValue(value)
	}
	for key, value := range dimensionFields {
		out[key] = cloneValue(value)
	}
	return out
}

func asFields(value any) map[string]any {
	if value == nil {
		return nil
	}
	if m, ok := value.(map[string]any); ok {
		return m
	}
	rv := reflect.ValueOf(value)
	if rv.Kind() != reflect.Map || rv.Type().Key().Kind() != reflect.String {
		return nil
	}
	out := make(map[string]any, rv.Len())
	iter := rv.MapRange()
	for iter.Next() {
		out[iter.Key().String()] = iter.Value().Interface()
	}
	return out
}
