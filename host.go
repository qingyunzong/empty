package dataeng

import (
	"errors"
	"fmt"
	"math/big"
	"sort"
)

var (
	ErrNoInputs                      = errors.New("dataeng: host requires at least one input")
	ErrInputIndex                    = errors.New("dataeng: input index out of range")
	ErrNilWeight                     = errors.New("dataeng: update weight is nil")
	ErrInputEnded                    = errors.New("dataeng: input has ended")
	ErrUpdateOutsideFrontier         = errors.New("dataeng: update time is outside the input frontier")
	ErrFrontierRegression            = errors.New("dataeng: new frontier is not at or after the old frontier")
	ErrDuplicateQueryID              = errors.New("dataeng: query ID is already live")
	ErrUnknownQueryID                = errors.New("dataeng: query ID is not live")
	ErrQueryNotAllowed               = errors.New("dataeng: query is not allowed by since")
	ErrSinceRegression               = errors.New("dataeng: new since is not at or after the old since")
	ErrSinceRejectsRegisteredQueries = errors.New("dataeng: since advance would disallow registered queries")
	ErrHostClosed                    = errors.New("dataeng: since is empty; host is closed to queries and updates")
	ErrInvalidSnapshot               = errors.New("dataeng: invalid host snapshot")
)

type inputState struct {
	frontier Antichain
}

type recordKey struct {
	key string
	at  Time
}

// Host is an embedded differential-dataflow state host over two-dimensional
// logical time. It is not safe for concurrent mutation.
type Host struct {
	inputs        []inputState
	since         Antichain
	registrations map[string]Time
	records       map[recordKey]*big.Int
}

// Outcome contains queries completed and delivered by one operation. A query
// appears at most once and is removed from the live registry before delivery.
type Outcome struct {
	Delivered []QueryResult
}

// QueryResult is the complete per-key weight sum for a query time.
type QueryResult struct {
	ID      string
	Query   Time
	Weights map[string]*big.Int
}

// Blocker identifies one input that can still send a time at or before a
// query, together with the frontier points that block the query.
type Blocker struct {
	Input  int
	Points []Time
}

// QueryStatus explains whether a live query is complete and, when it is not,
// which inputs and frontier points block it. AllowedBy lists the since points
// that individually allow the query.
type QueryStatus struct {
	ID        string
	Query     Time
	Allowed   bool
	AllowedBy []Time
	Complete  bool
	Blockers  []Blocker
}

// NewHost creates a host with a positive number of inputs. Every input starts
// with frontier {(0,0)}, and since starts as {(0,0)}.
func NewHost(inputs int) (*Host, error) {
	if inputs <= 0 {
		return nil, fmt.Errorf("%w: got %d", ErrNoInputs, inputs)
	}
	h := &Host{
		inputs:        make([]inputState, inputs),
		since:         NewAntichain(Time{}),
		registrations: make(map[string]Time),
		records:       make(map[recordKey]*big.Int),
	}
	for i := range h.inputs {
		h.inputs[i].frontier = NewAntichain(Time{})
	}
	return h, nil
}

// InputCount returns the number of inputs.
func (h *Host) InputCount() int {
	return len(h.inputs)
}

// Frontier returns a copy of an input's current frontier, sorted by (x,y) for
// presentation. An empty frontier means the input has ended.
func (h *Host) Frontier(input int) ([]Time, error) {
	if input < 0 || input >= len(h.inputs) {
		return nil, fmt.Errorf("%w: %d", ErrInputIndex, input)
	}
	return h.inputs[input].frontier.Points(), nil
}

// Since returns a copy of the current since antichain, sorted by (x,y).
func (h *Host) Since() []Time {
	return h.since.Points()
}

// Update adds a signed weight for key at logical time at. The original time is
// validated against the input frontier before since compaction is applied.
// Records are merged by key and stored time, and a zero sum removes the entry.
func (h *Host) Update(input int, key string, at Time, weight *big.Int) (Outcome, error) {
	if err := h.checkOpen(); err != nil {
		return Outcome{}, err
	}
	if input < 0 || input >= len(h.inputs) {
		return Outcome{}, fmt.Errorf("%w: %d", ErrInputIndex, input)
	}
	if weight == nil {
		return Outcome{}, ErrNilWeight
	}

	frontier := h.inputs[input].frontier
	if frontier.IsEmpty() {
		return Outcome{}, fmt.Errorf("%w: input %d", ErrInputEnded, input)
	}
	if !frontier.Dominates(at) {
		return Outcome{}, fmt.Errorf("%w: input %d, time %s, frontier %v",
			ErrUpdateOutsideFrontier, input, at, frontier.Points())
	}

	stored := h.since.Compact(at)
	h.addRecord(key, stored, weight)
	return Outcome{}, nil
}

// UpdateInt is a convenience wrapper for Update with an int64 weight.
func (h *Host) UpdateInt(input int, key string, at Time, weight int64) (Outcome, error) {
	return h.Update(input, key, at, big.NewInt(weight))
}

// AdvanceFrontier replaces an input's frontier. Every normalized point in the
// new frontier must be at or after some point of the old frontier. An empty
// frontier is allowed and permanently ends the input. Queries completed by the
// advance are delivered in registration-ID byte order.
func (h *Host) AdvanceFrontier(input int, frontier []Time) (Outcome, error) {
	if input < 0 || input >= len(h.inputs) {
		return Outcome{}, fmt.Errorf("%w: %d", ErrInputIndex, input)
	}

	next := NewAntichain(frontier...)
	old := h.inputs[input].frontier
	if old.IsEmpty() {
		if !next.IsEmpty() {
			return Outcome{}, fmt.Errorf("%w: input %d cannot be restored", ErrInputEnded, input)
		}
	} else {
		for _, p := range next.Points() {
			if !old.Dominates(p) {
				return Outcome{}, fmt.Errorf("%w: input %d, point %s, old frontier %v",
					ErrFrontierRegression, input, p, old.Points())
			}
		}
	}

	h.inputs[input].frontier = next
	return h.deliverCompleted(), nil
}

// RegisterQuery registers q under id. A query is allowed only when some since
// point is at or before q. If it is already complete it is delivered
// immediately instead of remaining live. Registering a live ID is rejected.
func (h *Host) RegisterQuery(id string, q Time) (Outcome, error) {
	if err := h.checkOpen(); err != nil {
		return Outcome{}, err
	}
	if _, exists := h.registrations[id]; exists {
		return Outcome{}, fmt.Errorf("%w: %q", ErrDuplicateQueryID, id)
	}
	if !h.since.Dominates(q) {
		return Outcome{}, fmt.Errorf("%w: query %s, since %v", ErrQueryNotAllowed, q, h.since.Points())
	}

	if len(h.blockingInputs(q)) == 0 {
		result := QueryResult{ID: id, Query: q, Weights: h.weightsAt(q)}
		return Outcome{Delivered: []QueryResult{result}}, nil
	}

	h.registrations[id] = q
	return Outcome{}, nil
}

// AdvanceSince advances the query-retention frontier and compacts all stored
// records. Every normalized point of the new since must be at or after some
// point of the old since. If the advance would disallow any live query, the
// whole operation is rejected and no state changes. Advancing to the empty
// antichain is allowed only with no live queries; it clears history and closes
// the host to new queries and updates.
func (h *Host) AdvanceSince(since []Time) (Outcome, error) {
	next := NewAntichain(since...)

	if h.since.IsEmpty() {
		if !next.IsEmpty() {
			return Outcome{}, ErrHostClosed
		}
		return Outcome{}, nil
	}

	if !next.IsEmpty() {
		for _, p := range next.Points() {
			if !h.since.Dominates(p) {
				return Outcome{}, fmt.Errorf("%w: point %s, old since %v",
					ErrSinceRegression, p, h.since.Points())
			}
		}
	}

	disallowed := make([]string, 0)
	for id, q := range h.registrations {
		if !next.Dominates(q) {
			disallowed = append(disallowed, id)
		}
	}
	if len(disallowed) > 0 {
		sort.Strings(disallowed)
		return Outcome{}, fmt.Errorf("%w: %v", ErrSinceRejectsRegisteredQueries, disallowed)
	}

	if next.IsEmpty() {
		h.since = next
		h.records = make(map[recordKey]*big.Int)
		return Outcome{}, nil
	}

	h.recompact(next)
	h.since = next
	return h.deliverCompleted(), nil
}

// QueryStatus returns the live query's allowed/completeness state and the
// specific blocking inputs and frontier points.
func (h *Host) QueryStatus(id string) (QueryStatus, error) {
	q, ok := h.registrations[id]
	if !ok {
		return QueryStatus{}, fmt.Errorf("%w: %q", ErrUnknownQueryID, id)
	}
	status := QueryStatus{
		ID:      id,
		Query:   q,
		Allowed: h.since.Dominates(q),
	}
	for _, p := range h.since.Points() {
		if p.LessOrEqual(q) {
			status.AllowedBy = append(status.AllowedBy, p)
		}
	}
	status.Blockers = h.blockingInputs(q)
	status.Complete = len(status.Blockers) == 0
	return status, nil
}

// PendingQueries returns statuses for all live queries in registration-ID
// byte order.
func (h *Host) PendingQueries() []QueryStatus {
	ids := make([]string, 0, len(h.registrations))
	for id := range h.registrations {
		ids = append(ids, id)
	}
	sort.Strings(ids)
	out := make([]QueryStatus, 0, len(ids))
	for _, id := range ids {
		status, _ := h.QueryStatus(id)
		out = append(out, status)
	}
	return out
}

func (h *Host) checkOpen() error {
	if h.since.IsEmpty() {
		return ErrHostClosed
	}
	return nil
}

func (h *Host) addRecord(key string, at Time, weight *big.Int) {
	if weight.Sign() == 0 {
		return
	}
	record := recordKey{key: key, at: at}
	if current, ok := h.records[record]; ok {
		current.Add(current, weight)
		if current.Sign() == 0 {
			delete(h.records, record)
		}
		return
	}
	h.records[record] = new(big.Int).Set(weight)
}

func (h *Host) recompact(next Antichain) {
	old := h.records
	h.records = make(map[recordKey]*big.Int, len(old))
	for record, weight := range old {
		h.addRecord(record.key, next.Compact(record.at), weight)
	}
}

func (h *Host) blockingInputs(q Time) []Blocker {
	blockers := make([]Blocker, 0)
	for i, input := range h.inputs {
		var points []Time
		for _, p := range input.frontier.Points() {
			if p.LessOrEqual(q) {
				points = append(points, p)
			}
		}
		if len(points) > 0 {
			blockers = append(blockers, Blocker{Input: i, Points: points})
		}
	}
	return blockers
}

func (h *Host) deliverCompleted() Outcome {
	ids := make([]string, 0)
	for id, q := range h.registrations {
		if len(h.blockingInputs(q)) == 0 {
			ids = append(ids, id)
		}
	}
	if len(ids) == 0 {
		return Outcome{}
	}
	sort.Strings(ids)
	delivered := make([]QueryResult, 0, len(ids))
	for _, id := range ids {
		q := h.registrations[id]
		delivered = append(delivered, QueryResult{
			ID:      id,
			Query:   q,
			Weights: h.weightsAt(q),
		})
		delete(h.registrations, id)
	}
	return Outcome{Delivered: delivered}
}

func (h *Host) weightsAt(q Time) map[string]*big.Int {
	sums := make(map[string]*big.Int)
	for record, weight := range h.records {
		if !record.at.LessOrEqual(q) {
			continue
		}
		if sum, ok := sums[record.key]; ok {
			sum.Add(sum, weight)
		} else {
			sums[record.key] = new(big.Int).Set(weight)
		}
	}
	for key, sum := range sums {
		if sum.Sign() == 0 {
			delete(sums, key)
		}
	}
	return sums
}
