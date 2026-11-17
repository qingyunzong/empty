package formal

import (
	"fmt"
	"sort"
	"sync"
	"time"
)

// Config configures a trace collector.
type Config struct {
	// Timeout is the collection window measured from the earliest span start
	// observed for a trace. It must be positive.
	Timeout time.Duration

	// MaxLateness is how long after the decision deadline fragments are still
	// accepted. Late fragments can only supplement retained traces. Fragments
	// older than MaxLateness are rejected and can never create a new trace.
	MaxLateness time.Duration

	// DefaultVerdict is used when no rule matches.
	DefaultVerdict Verdict

	Rules []Rule
}

// IngestStatus describes how a fragment affected the collector.
type IngestStatus uint8

const (
	IngestUnknown IngestStatus = iota
	// IngestNew means the fragment created a new pending trace.
	IngestNew
	// IngestMerged means the fragment joined an existing pending trace.
	IngestMerged
	// IngestDuplicate means the fragment identity was already present. It was
	// merged idempotently: span count is unchanged, while an error flag is
	// OR-merged into the existing span.
	IngestDuplicate
	// IngestSupplemented means a late fragment was merged into a retained
	// trace. The trace's verdict is unchanged.
	IngestSupplemented
	// IngestIgnoredDropped means a late fragment targeted a trace that was
	// already dropped. It is ignored and cannot revive the trace.
	IngestIgnoredDropped
	// IngestTooLate means the trace deadline had already passed before the
	// trace was ever observed. No trace was created.
	IngestTooLate
	// IngestExpired means the fragment arrived after the trace's lateness
	// window. No trace was created or changed.
	IngestExpired
)

// String returns a stable name for the status.
func (s IngestStatus) String() string {
	switch s {
	case IngestNew:
		return "new"
	case IngestMerged:
		return "merged"
	case IngestDuplicate:
		return "duplicate"
	case IngestSupplemented:
		return "supplemented"
	case IngestIgnoredDropped:
		return "ignored_dropped"
	case IngestTooLate:
		return "too_late"
	case IngestExpired:
		return "expired"
	default:
		return "unknown"
	}
}

// IngestResult reports the effect of one Ingest call.
type IngestResult struct {
	TraceID TraceID
	Status  IngestStatus

	// Verdict is the trace verdict after the ingest, or Undecided while the
	// trace is still collecting.
	Verdict Verdict
	RuleID  string

	// AddedSpans is 1 when the fragment introduced a new span.
	AddedSpans int
	// Duplicate is true when the fragment identity already existed.
	Duplicate bool
	// Finalized is true when this ingest caused the trace to be decided.
	Finalized bool
}

// Decision is a final, immutable tail-sampling decision. Each trace produces
// exactly one Decision.
type Decision struct {
	TraceID   TraceID
	Verdict   Verdict
	RuleID    string
	DecidedAt time.Time
	Summary   TraceSummary
}

// TraceSnapshot is the current state of a tracked trace.
type TraceSnapshot struct {
	TraceID TraceID
	Verdict Verdict
	RuleID  string
	Pending bool

	// Start and Deadline define the decision window. Summary.Start may become
	// earlier when a late retained fragment reports an earlier span.
	Start     time.Time
	Deadline  time.Time
	ExpiresAt time.Time
	DecidedAt time.Time
	Summary   TraceSummary

	LateFragments int
	LateSpans     int
	LateIgnored   int
}

// Stats reports live collector memory.
type Stats struct {
	Pending  int
	Retained int
	Dropped  int
	Tracked  int
	// Spans counts live per-span records. Dropped traces release their span
	// records immediately after the verdict.
	Spans int
}

// Collector aggregates out-of-order trace fragments and makes one deterministic
// tail-sampling decision per trace at its deadline.
//
// Lifecycle:
//   - Fragments arriving before the deadline merge into a pending trace.
//   - At the deadline the trace is decided exactly once. The collector keeps
//     the decision available for MaxLateness.
//   - During that window, late fragments supplement only retained traces.
//     They are ignored for dropped traces and cannot revive them.
//   - After the lateness window the trace state is reclaimed. Any later
//     fragment is rejected as expired.
//
// Collector is safe for concurrent use.
type Collector struct {
	mu sync.Mutex

	timeout     time.Duration
	maxLateness time.Duration
	policy      *Policy
	clock       Clock

	traces map[TraceID]*traceState
	outbox []Decision
}

// NewCollector creates a collector using the real clock.
func NewCollector(cfg Config) (*Collector, error) {
	return NewCollectorWithClock(cfg, RealClock{})
}

// NewCollectorWithClock creates a collector using clock.
func NewCollectorWithClock(cfg Config, clock Clock) (*Collector, error) {
	if clock == nil {
		return nil, fmt.Errorf("%w: nil clock", ErrInvalidConfig)
	}
	if cfg.Timeout <= 0 {
		return nil, fmt.Errorf("%w: timeout must be positive", ErrInvalidConfig)
	}
	if cfg.MaxLateness < 0 {
		return nil, fmt.Errorf("%w: max lateness cannot be negative", ErrInvalidConfig)
	}
	policy, err := NewPolicy(cfg.DefaultVerdict, cfg.Rules)
	if err != nil {
		return nil, err
	}
	return &Collector{
		timeout:     cfg.Timeout,
		maxLateness: cfg.MaxLateness,
		policy:      policy,
		clock:       clock,
		traces:      make(map[TraceID]*traceState),
	}, nil
}

// Ingest merges one fragment into its trace.
//
// The returned error is reserved for malformed fragments. Expired, dropped,
// and unknown-trace fragments are reported through IngestResult.Status.
func (c *Collector) Ingest(f Fragment) (IngestResult, error) {
	c.mu.Lock()
	defer c.mu.Unlock()

	now := c.clock.Now()
	fragment, err := normalizeFragment(f, now)
	if err != nil {
		return IngestResult{TraceID: f.TraceID, Status: IngestUnknown}, err
	}

	state := c.traces[fragment.TraceID]
	created := false
	if state == nil {
		deadline := fragment.Start.Add(c.timeout)
		expiresAt := deadline.Add(c.maxLateness)
		switch {
		case now.After(expiresAt):
			return IngestResult{TraceID: fragment.TraceID, Status: IngestExpired}, nil
		case !now.Before(deadline):
			// The trace would have been decided before this fragment was
			// ever observed. Creating it now would make the decision depend
			// on late, incomplete data.
			return IngestResult{TraceID: fragment.TraceID, Status: IngestTooLate}, nil
		}
		state = newTraceState(fragment.TraceID, fragment.Start, c.timeout, c.maxLateness)
		c.traces[fragment.TraceID] = state
		created = true
	}

	// Finalize only the target trace here. A full sweep on every fragment
	// would make ingestion O(tracked traces); Collect and Advance perform the
	// global sweep and reclamation instead.
	finalizedNow := false
	if state.verdict == Undecided && !now.Before(state.deadline) {
		c.finishLocked(state, now)
		finalizedNow = true
	}
	if state.verdict != Undecided && now.After(state.expiresAt) {
		delete(c.traces, fragment.TraceID)
		return IngestResult{TraceID: fragment.TraceID, Status: IngestExpired}, nil
	}

	if state.verdict == Drop {
		state.lateIgnored++
		return IngestResult{
			TraceID:   fragment.TraceID,
			Status:    IngestIgnoredDropped,
			Verdict:   Drop,
			RuleID:    state.ruleID,
			Finalized: finalizedNow,
		}, nil
	}

	added, duplicate := state.apply(fragment)

	if state.verdict == Keep {
		state.lateFragments++
		if added {
			state.lateSpans++
		}
		state.summary = state.buildSummary()
		return IngestResult{
			TraceID:    fragment.TraceID,
			Status:     IngestSupplemented,
			Verdict:    Keep,
			RuleID:     state.ruleID,
			AddedSpans: boolToInt(added),
			Duplicate:  duplicate,
			Finalized:  finalizedNow,
		}, nil
	}

	// Pending trace. An earlier start moves the deadline earlier.
	if fragment.Start.Before(state.start) {
		state.start = fragment.Start
		state.deadline = state.start.Add(c.timeout)
		state.expiresAt = state.deadline.Add(c.maxLateness)
	}

	status := IngestMerged
	if created {
		status = IngestNew
	} else if duplicate {
		status = IngestDuplicate
	}

	finalized := finalizedNow
	if !now.Before(state.deadline) {
		c.finishLocked(state, now)
		finalized = true
	}

	return IngestResult{
		TraceID:    fragment.TraceID,
		Status:     status,
		Verdict:    state.verdict,
		RuleID:     state.ruleID,
		AddedSpans: boolToInt(added),
		Duplicate:  duplicate,
		Finalized:  finalized,
	}, nil
}

// IngestBatch ingests fragments in order. It stops at the first malformed
// fragment and returns the results accumulated so far.
func (c *Collector) IngestBatch(fragments []Fragment) ([]IngestResult, error) {
	results := make([]IngestResult, 0, len(fragments))
	for _, fragment := range fragments {
		result, err := c.Ingest(fragment)
		if err != nil {
			return results, err
		}
		results = append(results, result)
	}
	return results, nil
}

// Collect finalizes all traces whose deadline has passed and returns decisions
// made since the previous call. A decision is returned exactly once.
func (c *Collector) Collect() []Decision {
	c.mu.Lock()
	defer c.mu.Unlock()

	c.sweepLocked(c.clock.Now())
	if len(c.outbox) == 0 {
		return nil
	}
	out := c.outbox
	c.outbox = nil
	return out
}

// Advance moves an advanceable clock forward and then collects decisions.
// When the collector uses RealClock, Advance simply collects due traces at the
// current time.
func (c *Collector) Advance(d time.Duration) []Decision {
	if advancer, ok := c.clock.(interface {
		Advance(time.Duration) time.Time
	}); ok {
		advancer.Advance(d)
	}
	return c.Collect()
}

// Snapshot returns the current state of a tracked trace. It does not advance
// the clock or create decisions.
func (c *Collector) Snapshot(id TraceID) (TraceSnapshot, bool) {
	c.mu.Lock()
	defer c.mu.Unlock()

	state, ok := c.traces[id]
	if !ok {
		return TraceSnapshot{}, false
	}
	return TraceSnapshot{
		TraceID:       state.id,
		Verdict:       state.verdict,
		RuleID:        state.ruleID,
		Pending:       state.verdict == Undecided,
		Start:         state.start,
		Deadline:      state.deadline,
		ExpiresAt:     state.expiresAt,
		DecidedAt:     state.decidedAt,
		Summary:       state.currentSummary(),
		LateFragments: state.lateFragments,
		LateSpans:     state.lateSpans,
		LateIgnored:   state.lateIgnored,
	}, true
}

// Stats returns live trace and span counts.
func (c *Collector) Stats() Stats {
	c.mu.Lock()
	defer c.mu.Unlock()

	var stats Stats
	for _, state := range c.traces {
		switch state.verdict {
		case Undecided:
			stats.Pending++
		case Keep:
			stats.Retained++
		case Drop:
			stats.Dropped++
		}
		stats.Spans += len(state.spans)
	}
	stats.Tracked = len(c.traces)
	return stats
}

// Policy returns the collector's immutable rule policy.
func (c *Collector) Policy() *Policy {
	return c.policy
}

func (c *Collector) sweepLocked(now time.Time) {
	due := make([]*traceState, 0)
	for _, state := range c.traces {
		if state.verdict == Undecided && !now.Before(state.deadline) {
			due = append(due, state)
		}
	}
	sort.Slice(due, func(i, j int) bool {
		if !due[i].deadline.Equal(due[j].deadline) {
			return due[i].deadline.Before(due[j].deadline)
		}
		return due[i].id < due[j].id
	})
	for _, state := range due {
		c.finishLocked(state, now)
	}

	for id, state := range c.traces {
		if state.verdict != Undecided && now.After(state.expiresAt) {
			delete(c.traces, id)
		}
	}
}

func (c *Collector) finishLocked(state *traceState, now time.Time) {
	if state.verdict != Undecided {
		return
	}
	summary := state.buildSummary()
	verdict, ruleID := c.policy.Decide(summary)
	state.verdict = verdict
	state.ruleID = ruleID
	state.decidedAt = now
	state.summary = summary

	if verdict == Drop {
		// A dropped trace needs only a compact tombstone until the lateness
		// window closes.
		state.spans = nil
		state.attributes = nil
		state.services = nil
		state.errorCount = 0
	}

	c.outbox = append(c.outbox, Decision{
		TraceID:   state.id,
		Verdict:   verdict,
		RuleID:    ruleID,
		DecidedAt: now,
		Summary:   summary.clone(),
	})
}

type attributeState struct {
	value   string
	start   time.Time
	spanKey string
}

type traceState struct {
	id        TraceID
	start     time.Time
	deadline  time.Time
	expiresAt time.Time

	// spans maps fragment identity to whether that span reported an error.
	spans      map[string]bool
	attributes map[string]attributeState
	services   map[string]struct{}

	minStart   time.Time
	maxEnd     time.Time
	errorCount int

	verdict   Verdict
	ruleID    string
	decidedAt time.Time
	summary   TraceSummary

	lateFragments int
	lateSpans     int
	lateIgnored   int
}

func newTraceState(id TraceID, start time.Time, timeout, maxLateness time.Duration) *traceState {
	deadline := start.Add(timeout)
	return &traceState{
		id:         id,
		start:      start,
		deadline:   deadline,
		expiresAt:  deadline.Add(maxLateness),
		spans:      make(map[string]bool),
		attributes: make(map[string]attributeState),
		services:   make(map[string]struct{}),
	}
}

func (s *traceState) apply(f Fragment) (added, duplicate bool) {
	key := f.key()
	hadError, ok := s.spans[key]
	if !ok {
		s.spans[key] = f.Error
		if f.Error {
			s.errorCount++
		}
		added = true
	} else {
		duplicate = true
		if f.Error && !hadError {
			s.spans[key] = true
			s.errorCount++
		}
	}

	if s.minStart.IsZero() || f.Start.Before(s.minStart) {
		s.minStart = f.Start
	}
	if s.maxEnd.IsZero() || f.End.After(s.maxEnd) {
		s.maxEnd = f.End
	}
	if f.Service != "" {
		s.services[f.Service] = struct{}{}
	}
	for attr, value := range f.Attributes {
		s.mergeAttribute(attr, value, f.Start, key)
	}
	return added, duplicate
}

func (s *traceState) mergeAttribute(key, value string, start time.Time, spanKey string) {
	candidate := attributeState{value: value, start: start, spanKey: spanKey}
	current, ok := s.attributes[key]
	if !ok || attributeBefore(candidate, current) {
		s.attributes[key] = candidate
	}
}

func attributeBefore(a, b attributeState) bool {
	if !a.start.Equal(b.start) {
		return a.start.Before(b.start)
	}
	if a.spanKey != b.spanKey {
		return a.spanKey < b.spanKey
	}
	return a.value < b.value
}

func (s *traceState) buildSummary() TraceSummary {
	summary := TraceSummary{
		TraceID:    s.id,
		Start:      s.minStart,
		End:        s.maxEnd,
		SpanCount:  len(s.spans),
		ErrorCount: s.errorCount,
		HasError:   s.errorCount > 0,
	}
	if !summary.End.IsZero() && !summary.Start.IsZero() {
		summary.Duration = summary.End.Sub(summary.Start)
		if summary.Duration < 0 {
			summary.Duration = 0
		}
	}
	if len(s.services) != 0 {
		summary.Services = make([]string, 0, len(s.services))
		for service := range s.services {
			summary.Services = append(summary.Services, service)
		}
		sort.Strings(summary.Services)
	}
	if len(s.attributes) != 0 {
		summary.Attributes = make(map[string]string, len(s.attributes))
		for key, attr := range s.attributes {
			summary.Attributes[key] = attr.value
		}
	}
	return summary
}

func (s *traceState) currentSummary() TraceSummary {
	if s.verdict != Undecided {
		return s.summary.clone()
	}
	return s.buildSummary().clone()
}

func boolToInt(v bool) int {
	if v {
		return 1
	}
	return 0
}
