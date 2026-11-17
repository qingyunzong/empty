package formal

import (
	"errors"
	"fmt"
	"sort"
	"sync"
	"time"
)

// Coordinator owns the durable transaction state machine. All exported
// methods are safe for concurrent use.
//
// The durable log is the source of truth. Every state transition is appended
// and synced before it becomes visible in memory, so replay after a crash
// reconstructs exactly the state that survived storage.
type Coordinator struct {
	mu sync.Mutex

	store           Store
	now             func() time.Time
	defaultTimeout  time.Duration
	recheckInterval time.Duration
	maxChecks       int

	attempts  map[Ref]*attempt
	current   map[string]Ref
	order     []Ref
	delivered map[Ref]struct{}
	nextGen   uint64
	records   int
	tornTail  int
	broken    error
}

type attempt struct {
	ref        Ref
	message    Message
	state      State
	preparedAt time.Time
	deadline   time.Time
	checks     int
	lastCheck  time.Time
	decidedAt  time.Time
	reason     string
}

// Open replays store and returns a coordinator positioned after the last
// complete record. A torn tail left by a crash is truncated before the
// coordinator accepts new writes.
func Open(store Store, opts ...Option) (*Coordinator, error) {
	if store == nil {
		return nil, errors.New("formal: nil store")
	}
	cfg := defaultConfig()
	for _, opt := range opts {
		if opt != nil {
			opt(&cfg)
		}
	}
	if cfg.now == nil {
		return nil, fmt.Errorf("%w: nil clock", ErrInvalidOption)
	}
	if cfg.defaultTimeout <= 0 {
		return nil, fmt.Errorf("%w: default timeout must be positive", ErrInvalidOption)
	}
	if cfg.recheckInterval <= 0 {
		return nil, fmt.Errorf("%w: recheck interval must be positive", ErrInvalidOption)
	}
	if cfg.maxChecks < 0 {
		return nil, fmt.Errorf("%w: max checks must not be negative", ErrInvalidOption)
	}

	data, err := store.Read()
	if err != nil {
		return nil, fmt.Errorf("formal: read transaction log: %w", err)
	}
	parsed, err := parseJournal(data)
	if err != nil {
		return nil, err
	}
	if parsed.tail != 0 {
		if err := store.Truncate(int64(parsed.valid)); err != nil {
			return nil, fmt.Errorf("formal: truncate torn log tail: %w", err)
		}
	}

	c := &Coordinator{
		store:           store,
		now:             cfg.now,
		defaultTimeout:  cfg.defaultTimeout,
		recheckInterval: cfg.recheckInterval,
		maxChecks:       cfg.maxChecks,
		attempts:        make(map[Ref]*attempt),
		current:         make(map[string]Ref),
		delivered:       make(map[Ref]struct{}),
		tornTail:        parsed.tail,
	}
	for i, payload := range parsed.payloads {
		rec, err := decodeRecord(payload)
		if err != nil {
			return nil, fmt.Errorf("formal: replay record %d: %w", i, err)
		}
		if err := c.applyRecord(rec); err != nil {
			return nil, fmt.Errorf("formal: replay record %d: %w", i, err)
		}
		c.records++
	}
	return c, nil
}

func (c *Coordinator) applyRecord(rec record) error {
	if !rec.Ref.valid() {
		return fmt.Errorf("%w: %s", ErrInvalidRef, rec.Ref)
	}
	switch rec.Kind {
	case recordPrepare:
		if rec.Message == nil {
			return fmt.Errorf("formal: prepare record %s has no message", rec.Ref)
		}
		msg := rec.Message.clone()
		if msg.ID == "" {
			return fmt.Errorf("%w: prepare record %s", ErrInvalidMessage, rec.Ref)
		}
		if existing, ok := c.attempts[rec.Ref]; ok {
			if !existing.message.equal(msg) {
				return fmt.Errorf("formal: duplicate prepare %s carries a different message", rec.Ref)
			}
			return nil
		}
		if rec.Ref.Gen <= c.nextGen {
			return fmt.Errorf("formal: prepare %s is not a monotonic generation (max %d)", rec.Ref, c.nextGen)
		}
		a := &attempt{
			ref:        rec.Ref,
			message:    msg,
			state:      StatePrepared,
			preparedAt: rec.At.Time,
			deadline:   rec.Deadline.Time,
		}
		c.attempts[rec.Ref] = a
		c.current[rec.Ref.ID] = rec.Ref
		c.nextGen = rec.Ref.Gen

	case recordCommit, recordRollback:
		a, ok := c.attempts[rec.Ref]
		if !ok {
			return fmt.Errorf("%w: final decision for %s", ErrUnknownTransaction, rec.Ref)
		}
		want := StateCommitted
		if rec.Kind == recordRollback {
			want = StateRolledBack
		}
		if a.state.Final() {
			// First final decision wins. This is what makes duplicate final
			// records harmless during replay.
			return nil
		}
		if a.state != StatePrepared {
			return fmt.Errorf("formal: final decision for %s in state %s", rec.Ref, a.state)
		}
		a.state = want
		a.decidedAt = rec.At.Time
		if want == StateRolledBack {
			a.reason = rec.Reason
		}
		if want == StateCommitted {
			c.addDeliveredLocked(rec.Ref)
		}

	case recordCheck:
		a, ok := c.attempts[rec.Ref]
		if !ok {
			return fmt.Errorf("%w: check for %s", ErrUnknownTransaction, rec.Ref)
		}
		if a.state == StatePrepared {
			a.checks++
			a.lastCheck = rec.At.Time
		}

	default:
		return fmt.Errorf("formal: unknown record kind %q", rec.Kind)
	}
	return nil
}

func (c *Coordinator) addDeliveredLocked(ref Ref) {
	if _, ok := c.delivered[ref]; ok {
		return
	}
	c.delivered[ref] = struct{}{}
	c.order = append(c.order, ref)
}

func (c *Coordinator) usableLocked() error {
	if c.broken != nil {
		return c.broken
	}
	return nil
}

func (c *Coordinator) appendLocked(rec record) error {
	if err := c.usableLocked(); err != nil {
		return err
	}
	frame, err := encodeFrame(rec)
	if err != nil {
		return err
	}
	if err := c.store.Append(frame); err != nil {
		c.broken = fmt.Errorf("formal: durable append failed: %w", err)
		return c.broken
	}
	c.records++
	return nil
}

// Prepare durably stores a half message and allocates a new generation.
//
// If the same transaction ID already has an unresolved generation, Prepare is
// idempotent for an identical message and returns the existing receipt. This
// makes a prepare retry after an ambiguous crash safe. A different message for
// an unresolved ID is rejected with InFlightError.
func (c *Coordinator) Prepare(req PrepareRequest) (Receipt, error) {
	c.mu.Lock()
	defer c.mu.Unlock()

	if err := c.usableLocked(); err != nil {
		return Receipt{}, err
	}
	msg := req.Message.clone()
	if msg.ID == "" {
		return Receipt{}, ErrInvalidMessage
	}
	timeout := req.Timeout
	if timeout == 0 {
		timeout = c.defaultTimeout
	}
	if timeout < 0 {
		return Receipt{}, ErrInvalidTimeout
	}
	if req.ID != "" {
		if cur, ok := c.current[req.ID]; ok {
			a := c.attempts[cur]
			if a.state == StatePrepared {
				if a.message.equal(msg) {
					return Receipt{Ref: cur, ExpiresAt: a.deadline, Duplicate: true}, nil
				}
				return Receipt{}, &InFlightError{Ref: cur}
			}
		}
	}

	gen := c.nextGen + 1
	id := req.ID
	if id == "" {
		// Auto-generated IDs must not collide with an ID that a caller has
		// already used, including one whose current generation is still
		// prepared. Skipping generations is harmless; only prepare records
		// need to advance the durable counter.
		for {
			id = fmt.Sprintf("txn-%d", gen)
			if _, exists := c.current[id]; !exists {
				break
			}
			gen++
		}
	}
	ref := Ref{ID: id, Gen: gen}
	now := c.now()
	rec := record{
		Version:  recordVersion,
		Kind:     recordPrepare,
		Ref:      ref,
		At:       jsonTime{now},
		Message:  &msg,
		Deadline: jsonTime{now.Add(timeout)},
	}
	if err := c.appendLocked(rec); err != nil {
		return Receipt{}, err
	}
	a := &attempt{
		ref:        ref,
		message:    msg,
		state:      StatePrepared,
		preparedAt: now,
		deadline:   now.Add(timeout),
	}
	c.attempts[ref] = a
	c.current[id] = ref
	c.nextGen = gen
	return Receipt{Ref: ref, ExpiresAt: a.deadline}, nil
}

// Commit durably records a committed decision. Repeating a commit returns the
// stored decision with Duplicate set. A commit for a reference that was already
// rolled back returns the stored rollback decision with Conflict set; it never
// changes the final outcome.
func (c *Coordinator) Commit(ref Ref) (Decision, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.decideLocked(ref, StateCommitted, "")
}

// Rollback durably records a rolled-back decision. It is idempotent in the same
// way as Commit.
func (c *Coordinator) Rollback(ref Ref, reason string) (Decision, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.decideLocked(ref, StateRolledBack, reason)
}

func (c *Coordinator) decideLocked(ref Ref, want State, reason string) (Decision, error) {
	if err := c.usableLocked(); err != nil {
		return Decision{}, err
	}
	a, err := c.lookupOrErrorLocked(ref)
	if err != nil {
		return Decision{}, err
	}
	if a.state.Final() {
		return Decision{
			Ref:       ref,
			State:     a.state,
			DecidedAt: a.decidedAt,
			Reason:    a.reason,
			Duplicate: true,
			Conflict:  a.state != want,
		}, nil
	}
	if a.state != StatePrepared {
		return Decision{}, fmt.Errorf("formal: %s is in state %s", ref, a.state)
	}

	now := c.now()
	kind := recordCommit
	if want == StateRolledBack {
		kind = recordRollback
	}
	rec := record{
		Version: recordVersion,
		Kind:    kind,
		Ref:     ref,
		At:      jsonTime{now},
		Reason:  reason,
	}
	if err := c.appendLocked(rec); err != nil {
		return Decision{}, err
	}
	a.state = want
	a.decidedAt = now
	if want == StateRolledBack {
		a.reason = reason
	}
	if want == StateCommitted {
		c.addDeliveredLocked(ref)
	}
	return Decision{
		Ref:       ref,
		State:     want,
		DecidedAt: now,
		Reason:    a.reason,
	}, nil
}

func (c *Coordinator) lookupOrErrorLocked(ref Ref) (*attempt, error) {
	if !ref.valid() {
		return nil, fmt.Errorf("%w: %s", ErrInvalidRef, ref)
	}
	if a, ok := c.attempts[ref]; ok {
		return a, nil
	}
	if cur, ok := c.current[ref.ID]; ok && cur.Gen > ref.Gen {
		return nil, &StaleConfirmationError{Ref: ref, Current: cur}
	}
	return nil, fmt.Errorf("%w: %s", ErrUnknownTransaction, ref)
}

// MarkChecked durably records one transaction check for a prepared attempt and
// returns the updated check schedule. The caller is expected to ask the
// business for its local outcome and then call Commit or Rollback. If the
// business is still undecided, the caller simply waits for the next Due result
// and calls MarkChecked again.
func (c *Coordinator) MarkChecked(ref Ref) (CheckRequest, error) {
	c.mu.Lock()
	defer c.mu.Unlock()

	if err := c.usableLocked(); err != nil {
		return CheckRequest{}, err
	}
	a, err := c.lookupOrErrorLocked(ref)
	if err != nil {
		return CheckRequest{}, err
	}
	if a.state.Final() {
		return CheckRequest{}, fmt.Errorf("%w: %s is %s", ErrAlreadyDecided, ref, a.state)
	}
	now := c.now()
	rec := record{
		Version: recordVersion,
		Kind:    recordCheck,
		Ref:     ref,
		At:      jsonTime{now},
	}
	if err := c.appendLocked(rec); err != nil {
		return CheckRequest{}, err
	}
	a.checks++
	a.lastCheck = now
	return c.checkRequestLocked(a), nil
}

// Due returns all prepared attempts whose first deadline or next re-check time
// has elapsed, ordered by check time and then by reference.
func (c *Coordinator) Due() []CheckRequest {
	c.mu.Lock()
	defer c.mu.Unlock()

	now := c.now()
	var out []CheckRequest
	for _, a := range c.attempts {
		if a.state == StatePrepared && !c.nextCheckLocked(a).After(now) {
			out = append(out, c.checkRequestLocked(a))
		}
	}
	sort.Slice(out, func(i, j int) bool {
		if !out[i].NextCheck.Equal(out[j].NextCheck) {
			return out[i].NextCheck.Before(out[j].NextCheck)
		}
		return refLess(out[i].Ref, out[j].Ref)
	})
	return out
}

// Pending returns all prepared attempts, whether or not they are due for a
// check. This is useful immediately after Open to resume check scheduling.
func (c *Coordinator) Pending() []Attempt {
	c.mu.Lock()
	defer c.mu.Unlock()

	var out []Attempt
	for _, a := range c.attempts {
		if a.state == StatePrepared {
			out = append(out, a.snapshot(c))
		}
	}
	sort.Slice(out, func(i, j int) bool {
		if !out[i].Deadline.Equal(out[j].Deadline) {
			return out[i].Deadline.Before(out[j].Deadline)
		}
		return refLess(out[i].Ref, out[j].Ref)
	})
	return out
}

func (c *Coordinator) nextCheckLocked(a *attempt) time.Time {
	if !a.lastCheck.IsZero() {
		return a.lastCheck.Add(c.recheckInterval)
	}
	return a.deadline
}

func (c *Coordinator) checkRequestLocked(a *attempt) CheckRequest {
	return CheckRequest{
		Ref:        a.ref,
		Message:    a.message.clone(),
		PreparedAt: a.preparedAt,
		Deadline:   a.deadline,
		Checks:     a.checks,
		LastCheck:  a.lastCheck,
		NextCheck:  c.nextCheckLocked(a),
		Exhausted:  c.maxChecks > 0 && a.checks >= c.maxChecks,
	}
}

func (a *attempt) snapshot(c *Coordinator) Attempt {
	return Attempt{
		Ref:        a.ref,
		Message:    a.message.clone(),
		State:      a.state,
		PreparedAt: a.preparedAt,
		Deadline:   a.deadline,
		Checks:     a.checks,
		LastCheck:  a.lastCheck,
		NextCheck:  c.nextCheckLocked(a),
		DecidedAt:  a.decidedAt,
		Reason:     a.reason,
	}
}

// Deliverable returns a snapshot of the deliverable set in commit order. A
// reference appears at most once even if its commit record was replayed more
// than once.
func (c *Coordinator) Deliverable() []Delivery {
	c.mu.Lock()
	defer c.mu.Unlock()

	out := make([]Delivery, 0, len(c.order))
	for _, ref := range c.order {
		a := c.attempts[ref]
		out = append(out, Delivery{
			Ref:         ref,
			Message:     a.message.clone(),
			CommittedAt: a.decidedAt,
		})
	}
	return out
}

// Get returns a snapshot of an exact reference.
func (c *Coordinator) Get(ref Ref) (Attempt, bool) {
	c.mu.Lock()
	defer c.mu.Unlock()
	a, ok := c.attempts[ref]
	if !ok {
		return Attempt{}, false
	}
	return a.snapshot(c), true
}

// Lookup returns the current generation for a transaction ID.
func (c *Coordinator) Lookup(id string) (Attempt, bool) {
	c.mu.Lock()
	defer c.mu.Unlock()
	ref, ok := c.current[id]
	if !ok {
		return Attempt{}, false
	}
	return c.attempts[ref].snapshot(c), true
}

// Stats returns a point-in-time summary. It is primarily useful for monitoring
// and for asserting recovery behavior in tests.
func (c *Coordinator) Stats() Stats {
	c.mu.Lock()
	defer c.mu.Unlock()

	prepared := 0
	for _, a := range c.attempts {
		if a.state == StatePrepared {
			prepared++
		}
	}
	return Stats{
		Records:        c.records,
		NextGeneration: c.nextGen,
		Attempts:       len(c.attempts),
		Prepared:       prepared,
		Delivered:      len(c.order),
		TornTailBytes:  c.tornTail,
		Broken:         c.broken != nil,
	}
}

func refLess(a, b Ref) bool {
	if a.ID != b.ID {
		return a.ID < b.ID
	}
	return a.Gen < b.Gen
}
