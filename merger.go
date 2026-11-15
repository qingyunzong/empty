package dataeng

import (
	"errors"
	"sort"
	"strconv"
	"sync"
)

var (
	// ErrUnknownShard is returned when an event names a shard that was not
	// configured and automatic shard discovery is disabled.
	ErrUnknownShard = errors.New("dataeng: unknown shard")
	// ErrFutureGeneration is returned when an event explicitly belongs to a
	// generation the merger has not reached yet.
	ErrFutureGeneration = errors.New("dataeng: event belongs to a future generation")
	// ErrBehindWatermark is returned when a shard is added below the durable
	// watermark. Backfill the shard before adding it.
	ErrBehindWatermark = errors.New("dataeng: shard checkpoint is behind watermark")
	// ErrPendingLimit is returned when accepting an event would exceed the
	// configured pending-event limit.
	ErrPendingLimit = errors.New("dataeng: pending event limit exceeded")
)

// MergerOptions configures a Merger.
type MergerOptions struct {
	// Shards is the initial active shard set. When it is empty, shards are
	// discovered from the events that are pushed.
	Shards []string

	// ShardWatermarks seeds each shard's processed frontier. A missing shard
	// starts at InitialWatermark (or zero).
	ShardWatermarks map[string]Timestamp

	// InitialWatermark is the durable position from which all shards start
	// when their individual checkpoint is not supplied.
	InitialWatermark Timestamp

	// InitialGeneration and InitialSequence seed the resumable sequence
	// coordinates. ResumeMerger overrides them from the checkpoint.
	InitialGeneration uint64
	InitialSequence   uint64

	// AllowUnknownShards permits shards that were not listed in Shards. It is
	// implied when Shards is empty.
	AllowUnknownShards bool

	// HoldTies delays events at the minimum shard frontier until every active
	// shard has moved strictly beyond that cluster time. It trades latency for
	// a guarantee that no event with an equal cluster time can arrive after
	// the group was emitted. By default equal-time events are emitted as soon
	// as every active shard has reached that time.
	HoldTies bool

	// DedupeRetention keeps duplicate-detection evidence for this many seconds
	// below the watermark. Zero keeps evidence at and above the watermark.
	DedupeRetention uint32

	// MaxPending bounds buffered, not-yet-emitted events. Zero means
	// unlimited. It is useful as a backpressure guard for a lagging shard.
	MaxPending int
}

type shardState struct {
	id     string
	active bool

	// frontier is the greatest cluster time accepted from this shard.
	frontier Timestamp
	// token is the resume token associated with frontier.
	token string

	// emitted is the greatest cluster time actually emitted for this shard,
	// and emittedToken is the corresponding resume token. It may be ahead of
	// the global watermark after Flush.
	emitted      Timestamp
	emittedToken string
}

type pendingEvent struct {
	event    Event
	inputSeq uint64
}

// InvalidateBoundary is the closed-generation marker persisted in a
// Checkpoint after an invalidate event.
type InvalidateBoundary struct {
	Generation  uint64    `json:"generation"`
	ClusterTime Timestamp `json:"clusterTime"`
	Database    string    `json:"database,omitempty"`
	Collection  string    `json:"collection,omitempty"`
}

// MergeResult describes the effect of accepting events. Events contains the
// events that became safe to emit, in global sequence order.
type MergeResult struct {
	Events []Event

	Accepted     int
	Duplicates   int
	Stale        int
	Late         int
	PendingLimit int
	Invalidated  bool

	// ClosedGeneration and ClosedWatermark are set when an invalidate event
	// closed a generation.
	ClosedGeneration uint64
	ClosedWatermark  Timestamp

	Watermark  Timestamp
	Generation uint64
	Sequence   uint64
	Position   Position
}

// Merger combines change stream events from several shards. Its methods are
// safe for concurrent use.
type Merger struct {
	mu sync.Mutex

	generation uint64
	sequence   uint64

	shards map[string]*shardState

	allowUnknown bool
	holdTies     bool
	retention    uint32
	maxPending   int

	pending      []pendingEvent
	nextInputSeq uint64

	// seen maps every duplicate-detection key to the cluster time at which
	// the evidence may be forgotten.
	seen map[string]Timestamp

	watermark Timestamp
	position  Position
	lastEvent Event

	closedGeneration uint64
	closedWatermark  Timestamp

	boundary          *InvalidateBoundary
	generationStarted bool
}

// NewMerger returns a merger for the supplied active shards. With no shards,
// shards are discovered from pushed events.
func NewMerger(shards ...string) *Merger {
	return NewMergerWithOptions(MergerOptions{Shards: shards})
}

// NewMergerWithOptions returns a configured Merger.
func NewMergerWithOptions(opts MergerOptions) *Merger {
	m := &Merger{
		shards:       make(map[string]*shardState, len(opts.Shards)),
		allowUnknown: opts.AllowUnknownShards || len(opts.Shards) == 0,
		holdTies:     opts.HoldTies,
		retention:    opts.DedupeRetention,
		maxPending:   opts.MaxPending,
		seen:         make(map[string]Timestamp),
		watermark:    opts.InitialWatermark,
		generation:   opts.InitialGeneration,
		sequence:     opts.InitialSequence,
	}
	for _, shard := range opts.Shards {
		frontier := opts.InitialWatermark
		if checkpoint, ok := opts.ShardWatermarks[shard]; ok {
			frontier = checkpoint
		}
		if current, ok := m.shards[shard]; !ok {
			m.shards[shard] = &shardState{id: shard, active: true, frontier: frontier, emitted: frontier}
		} else if frontier.After(current.frontier) {
			current.frontier = frontier
			if frontier.After(current.emitted) {
				current.emitted = frontier
			}
		}
	}
	m.advanceWatermarkLocked()
	return m
}

// Accept accepts one event and returns detailed information about the merge
// result. Duplicate, stale and already-emitted events are acknowledged but are
// not placed in Events.
func (m *Merger) Accept(event Event) (MergeResult, error) {
	m.mu.Lock()
	defer m.mu.Unlock()

	out, result, err := m.pushLocked(event, false)
	result.Events = out
	m.snapshotLocked(&result)
	return result, err
}

// Push is the convenience form of Accept that returns only the events that
// became safe to emit.
func (m *Merger) Push(event Event) ([]Event, error) {
	result, err := m.Accept(event)
	return result.Events, err
}

// PushBatch accepts a group of events before draining. It is the preferred way
// to feed a read round from several shards: equal-time events from the whole
// batch are ordered before any of them is emitted.
func (m *Merger) PushBatch(events []Event) (MergeResult, error) {
	m.mu.Lock()
	defer m.mu.Unlock()

	var result MergeResult
	var out []Event
	for _, event := range events {
		produced, part, err := m.pushLocked(event, true)
		if len(produced) != 0 {
			out = append(out, produced...)
		}
		result.Accepted += part.Accepted
		result.Duplicates += part.Duplicates
		result.Stale += part.Stale
		result.Late += part.Late
		result.PendingLimit += part.PendingLimit
		if part.Invalidated {
			result.Invalidated = true
			result.ClosedGeneration = part.ClosedGeneration
			result.ClosedWatermark = part.ClosedWatermark
		}
		if err != nil {
			out = append(out, m.drainSafeLocked()...)
			result.Events = out
			m.snapshotLocked(&result)
			return result, err
		}
	}
	out = append(out, m.drainSafeLocked()...)
	result.Events = out
	m.snapshotLocked(&result)
	return result, nil
}

// Drain emits every event that is currently safe.
func (m *Merger) Drain() MergeResult {
	m.mu.Lock()
	defer m.mu.Unlock()

	var result MergeResult
	result.Events = m.drainSafeLocked()
	m.snapshotLocked(&result)
	return result
}

// Flush emits all buffered events in global order. It is intended for stream
// shutdown or final drainage. The durable watermark still only advances to the
// minimum active shard frontier; events emitted beyond it will be replayed on
// resume and deduplicated.
func (m *Merger) Flush() MergeResult {
	m.mu.Lock()
	defer m.mu.Unlock()

	m.advanceWatermarkLocked()

	var result MergeResult
	result.Events = m.emitAllLocked()
	m.snapshotLocked(&result)
	return result
}

// Watermark returns the highest cluster time that every active shard has
// reached. It never moves backwards.
func (m *Merger) Watermark() Timestamp {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.watermark
}

// DurableWatermark returns the watermark that Checkpoint will persist: the
// minimum position actually emitted by every active shard. It can be behind
// Watermark while an equal-time group is still buffered.
func (m *Merger) DurableWatermark() Timestamp {
	m.mu.Lock()
	defer m.mu.Unlock()
	if watermark, ok := m.durableWatermarkLocked(); ok {
		return watermark
	}
	return m.watermark
}

// Generation returns the current generation. It starts at zero and increases
// when an invalidate event closes a generation.
func (m *Merger) Generation() uint64 {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.generation
}

// ClosedGeneration returns the most recently closed generation and the safe
// watermark observed for it. The boolean is false before the first invalidate.
func (m *Merger) ClosedGeneration() (uint64, Timestamp, bool) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.boundary == nil {
		return 0, Timestamp{}, false
	}
	return m.closedGeneration, m.closedWatermark, true
}

// Sequence returns the sequence number of the last emitted event.
func (m *Merger) Sequence() uint64 {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.sequence
}

// Position returns the last emitted position.
func (m *Merger) Position() Position {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.position
}

// Pending returns the number of accepted but not yet emitted events.
func (m *Merger) Pending() int {
	m.mu.Lock()
	defer m.mu.Unlock()
	return len(m.pending)
}

// ShardWatermarks returns the accepted frontier for each active shard.
func (m *Merger) ShardWatermarks() map[string]Timestamp {
	m.mu.Lock()
	defer m.mu.Unlock()

	out := make(map[string]Timestamp, len(m.shards))
	for id, shard := range m.shards {
		if shard.active {
			out[id] = shard.frontier
		}
	}
	return out
}

// ActiveShards returns the configured active shards in sorted order.
func (m *Merger) ActiveShards() []string {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.activeShardsLocked()
}

// AddShard adds an active shard that starts at the current durable watermark.
func (m *Merger) AddShard(shard string) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.addShardLocked(shard, m.watermark)
}

// AddShardAt adds an active shard at an explicit read frontier. A checkpoint
// below the durable watermark is rejected because events before the watermark
// have already been committed.
func (m *Merger) AddShardAt(shard string, at Timestamp) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	if at.Before(m.watermark) {
		return ErrBehindWatermark
	}
	return m.addShardLocked(shard, at)
}

// RemoveShard deactivates a shard and drops its buffered events. Removing a
// lagging shard allows the watermark to advance; the caller is responsible for
// ensuring that the shard really is no longer active.
func (m *Merger) RemoveShard(shard string) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if _, ok := m.shards[shard]; !ok {
		return
	}
	delete(m.shards, shard)

	kept := m.pending[:0]
	for _, pending := range m.pending {
		if pending.event.ShardID != shard {
			kept = append(kept, pending)
		}
	}
	m.pending = kept
	m.advanceWatermarkLocked()
}

// SetShards replaces the active shard set. New shards start at the current
// durable watermark.
func (m *Merger) SetShards(shards ...string) error {
	m.mu.Lock()
	defer m.mu.Unlock()

	wanted := make(map[string]struct{}, len(shards))
	for _, shard := range shards {
		wanted[shard] = struct{}{}
	}
	for existing := range m.shards {
		if _, ok := wanted[existing]; !ok {
			delete(m.shards, existing)
		}
	}
	kept := m.pending[:0]
	for _, pending := range m.pending {
		if _, ok := wanted[pending.event.ShardID]; ok {
			kept = append(kept, pending)
		}
	}
	m.pending = kept
	for shard := range wanted {
		if state, ok := m.shards[shard]; ok {
			state.active = true
			continue
		}
		if err := m.addShardLocked(shard, m.watermark); err != nil {
			return err
		}
	}
	m.advanceWatermarkLocked()
	return nil
}

// Checkpoint is a durable restart point. Shards contains the last token emitted
// for each shard. A per-shard token can be ahead of Watermark when Flush has
// drained events beyond the globally safe prefix; those events were emitted,
// so resuming from the token does not replay them. Watermark itself is capped
// at the minimum emitted position, so it never skips an undelivered tie group.
type Checkpoint struct {
	Generation uint64                     `json:"generation"`
	Sequence   uint64                     `json:"sequence"`
	Watermark  Timestamp                  `json:"watermark"`
	Position   Position                   `json:"position"`
	Shards     map[string]ShardCheckpoint `json:"shards"`
	// GenerationStarted reports whether a non-invalidate event has been
	// accepted in the current generation.
	GenerationStarted bool `json:"generationStarted,omitempty"`
	// Invalidate identifies the generation boundary that closed most
	// recently. It prevents stale old-generation events from being accepted
	// after a restart.
	Invalidate *InvalidateBoundary `json:"invalidate,omitempty"`
}

// ShardCheckpoint is the last event emitted from one shard.
type ShardCheckpoint struct {
	Token       string    `json:"token"`
	ClusterTime Timestamp `json:"clusterTime"`
}

// Checkpoint returns a copy of the durable restart state.
func (m *Merger) Checkpoint() Checkpoint {
	m.mu.Lock()
	defer m.mu.Unlock()

	watermark := m.watermark
	if durable, ok := m.durableWatermarkLocked(); ok {
		watermark = durable
	}
	checkpoint := Checkpoint{
		Generation:        m.generation,
		Sequence:          m.sequence,
		Watermark:         watermark,
		Position:          m.position,
		Shards:            make(map[string]ShardCheckpoint, len(m.shards)),
		GenerationStarted: m.generationStarted,
	}
	if m.boundary != nil {
		boundary := *m.boundary
		checkpoint.Invalidate = &boundary
	}
	for id, shard := range m.shards {
		if !shard.active {
			continue
		}
		checkpoint.Shards[id] = ShardCheckpoint{
			Token:       shard.emittedToken,
			ClusterTime: shard.emitted,
		}
	}
	return checkpoint
}

// ResumeMerger restores a merger from Checkpoint. Streams should resume at the
// per-shard tokens in the checkpoint (or replay from Watermark when a token is
// empty). Omitted shards are taken from the checkpoint.
func ResumeMerger(checkpoint Checkpoint, opts MergerOptions) *Merger {
	if len(opts.Shards) == 0 {
		opts.Shards = make([]string, 0, len(checkpoint.Shards))
		for shard := range checkpoint.Shards {
			opts.Shards = append(opts.Shards, shard)
		}
	}
	if opts.ShardWatermarks == nil {
		opts.ShardWatermarks = make(map[string]Timestamp, len(checkpoint.Shards))
	}
	for shard, state := range checkpoint.Shards {
		if state.ClusterTime.After(opts.ShardWatermarks[shard]) {
			opts.ShardWatermarks[shard] = state.ClusterTime
		}
	}
	opts.InitialWatermark = checkpoint.Watermark

	m := NewMergerWithOptions(opts)
	m.generation = checkpoint.Generation
	m.sequence = checkpoint.Sequence
	m.position = checkpoint.Position
	m.watermark = checkpoint.Watermark
	m.generationStarted = checkpoint.GenerationStarted
	if checkpoint.Invalidate != nil {
		boundary := *checkpoint.Invalidate
		m.boundary = &boundary
		m.closedGeneration = boundary.Generation
		m.closedWatermark = boundary.ClusterTime
	}
	for shard, state := range checkpoint.Shards {
		current, ok := m.shards[shard]
		if !ok {
			continue
		}
		if state.ClusterTime.After(current.frontier) {
			current.frontier = state.ClusterTime
		}
		current.emitted = state.ClusterTime
		current.emittedToken = state.Token
		if state.Token != "" {
			// A resumed stream may replay the event at the checkpoint token.
			// Seed the token evidence so that replay is acknowledged rather
			// than emitted a second time.
			m.seen["g"+strconv.FormatUint(checkpoint.Generation, 10)+"|token|"+state.Token] = state.ClusterTime
		}
	}
	m.advanceWatermarkLocked()
	return m
}

func (m *Merger) addShardLocked(shard string, at Timestamp) error {
	if shard == "" {
		return ErrUnknownShard
	}
	if current, ok := m.shards[shard]; ok {
		current.active = true
		if at.After(current.frontier) {
			current.frontier = at
		}
		if at.After(current.emitted) {
			current.emitted = at
		}
		return nil
	}
	m.shards[shard] = &shardState{id: shard, active: true, frontier: at, emitted: at}
	return nil
}

func (m *Merger) activeShardsLocked() []string {
	shards := make([]string, 0, len(m.shards))
	for shard, state := range m.shards {
		if state.active {
			shards = append(shards, shard)
		}
	}
	sort.Strings(shards)
	return shards
}

func (m *Merger) resolveShardLocked(shard string) (*shardState, error) {
	if state, ok := m.shards[shard]; ok {
		return state, nil
	}
	if !m.allowUnknown {
		return nil, ErrUnknownShard
	}
	state := &shardState{id: shard, active: true, frontier: m.watermark, emitted: m.watermark}
	m.shards[shard] = state
	return state, nil
}

func (m *Merger) pushLocked(event Event, deferDrain bool) ([]Event, MergeResult, error) {
	var result MergeResult
	event = normalizeEvent(event)

	if event.Generation != 0 {
		if event.Generation < m.generation {
			result.Stale++
			return nil, result, nil
		}
		if event.Generation > m.generation {
			return nil, result, ErrFutureGeneration
		}
	}

	shard, err := m.resolveShardLocked(event.ShardID)
	if err != nil {
		return nil, result, err
	}

	if event.Invalidate {
		return m.invalidateLocked(event, shard, deferDrain, &result)
	}

	// Events that predate the invalidate boundary belong to the closed
	// generation even when a producer did not stamp Generation on them.
	if m.boundary != nil &&
		!event.ClusterTime.After(m.boundary.ClusterTime) &&
		sameStream(m.boundary.Database, event.Database) &&
		sameStream(m.boundary.Collection, event.Collection) {
		result.Stale++
		var out []Event
		if !deferDrain {
			out = m.drainSafeLocked()
		}
		return out, result, nil
	}

	keys := dedupeKeys(m.generation, event)
	if len(keys) != 0 {
		for _, key := range keys {
			if _, found := m.seen[key]; found {
				m.advanceShardLocked(shard, event)
				result.Duplicates++
				var out []Event
				if !deferDrain {
					out = m.drainSafeLocked()
				}
				return out, result, nil
			}
		}
	}

	if m.isLateLocked(event) {
		m.advanceShardLocked(shard, event)
		result.Late++
		var out []Event
		if !deferDrain {
			out = m.drainSafeLocked()
		}
		return out, result, nil
	}

	if m.maxPending > 0 && len(m.pending) >= m.maxPending {
		result.PendingLimit++
		return nil, result, ErrPendingLimit
	}

	for _, key := range keys {
		m.seen[key] = event.ClusterTime
	}
	m.advanceShardLocked(shard, event)
	m.generationStarted = true
	m.nextInputSeq++
	m.pending = append(m.pending, pendingEvent{event: event, inputSeq: m.nextInputSeq})
	result.Accepted++

	if deferDrain {
		return nil, result, nil
	}
	return m.drainSafeLocked(), result, nil
}

func (m *Merger) invalidateLocked(event Event, shard *shardState, deferDrain bool, result *MergeResult) ([]Event, MergeResult, error) {
	if m.boundary != nil &&
		sameStream(m.boundary.Database, event.Database) &&
		sameStream(m.boundary.Collection, event.Collection) &&
		(!m.generationStarted || !event.ClusterTime.After(m.boundary.ClusterTime)) {
		result.Stale++
		var out []Event
		if !deferDrain {
			out = m.drainSafeLocked()
		}
		return out, *result, nil
	}

	oldGeneration := m.generation
	cutoff := event.ClusterTime
	if cutoff.Before(m.watermark) {
		// A late invalidate cannot rewind the already-committed prefix. Close
		// the generation at the current watermark instead.
		cutoff = m.watermark
		event.ClusterTime = cutoff
	}
	m.advanceShardLocked(shard, event)

	var before []pendingEvent
	dropped := 0
	for _, pending := range m.pending {
		if !pending.event.ClusterTime.After(cutoff) {
			before = append(before, pending)
		} else {
			dropped++
		}
	}
	sort.SliceStable(before, func(i, j int) bool {
		return eventLess(before[i].event, before[j].event, before[i].inputSeq, before[j].inputSeq)
	})
	m.pending = nil

	out := make([]Event, 0, len(before)+1)
	for _, pending := range before {
		out = append(out, m.emitLocked(pending.event, oldGeneration, true))
	}

	event.Generation = oldGeneration
	event.Sequence = 0
	out = append(out, m.emitLocked(event, oldGeneration, true))

	m.closedGeneration = oldGeneration
	m.closedWatermark = m.candidateLocked()
	result.Invalidated = true
	result.ClosedGeneration = oldGeneration
	result.ClosedWatermark = m.closedWatermark
	result.Accepted++
	result.Stale += dropped

	m.generation++
	m.lastEvent = Event{}
	m.boundary = &InvalidateBoundary{
		Generation:  m.generation - 1,
		ClusterTime: cutoff,
		Database:    event.Database,
		Collection:  event.Collection,
	}
	m.generationStarted = false
	m.seen = make(map[string]Timestamp)
	m.pending = nil
	for _, state := range m.shards {
		state.frontier = Timestamp{}
		state.token = ""
		state.emitted = m.watermark
		state.emittedToken = ""
	}
	return out, *result, nil
}

func (m *Merger) advanceShardLocked(shard *shardState, event Event) {
	if event.ClusterTime.After(shard.frontier) ||
		shard.frontier.IsZero() ||
		(event.ClusterTime == shard.frontier && event.ResumeToken > shard.token) {
		shard.frontier = event.ClusterTime
		shard.token = event.ResumeToken
	}
}

func (m *Merger) isLateLocked(event Event) bool {
	if event.ClusterTime.Before(m.watermark) {
		return true
	}
	if m.lastEvent.Sequence != 0 && eventLess(event, m.lastEvent, 0, m.lastEvent.Sequence) {
		return true
	}
	return false
}

func (m *Merger) candidateLocked() Timestamp {
	var candidate Timestamp
	first := true
	for _, shard := range m.shards {
		if !shard.active {
			continue
		}
		if first || shard.frontier.Before(candidate) {
			candidate = shard.frontier
			first = false
		}
	}
	if first {
		return Timestamp{}
	}
	return candidate
}

func (m *Merger) durableWatermarkLocked() (Timestamp, bool) {
	var watermark Timestamp
	first := true
	for _, shard := range m.shards {
		if !shard.active {
			continue
		}
		if first || shard.emitted.Before(watermark) {
			watermark = shard.emitted
			first = false
		}
	}
	return watermark, !first
}

func (m *Merger) advanceWatermarkLocked() {
	candidate := m.candidateLocked()
	if candidate.After(m.watermark) {
		m.watermark = candidate
		m.pruneSeenLocked()
	}
}

func (m *Merger) pruneSeenLocked() {
	if m.watermark.IsZero() {
		return
	}
	for key, seenAt := range m.seen {
		if m.retention == 0 {
			if seenAt.Before(m.watermark) {
				delete(m.seen, key)
			}
			continue
		}
		// Retention is expressed in seconds. Keep everything inside the
		// window [watermark-retention, watermark].
		if uint64(seenAt.T)+uint64(m.retention) < uint64(m.watermark.T) {
			delete(m.seen, key)
		}
	}
}

func (m *Merger) drainSafeLocked() []Event {
	m.advanceWatermarkLocked()
	if len(m.pending) == 0 {
		return nil
	}
	candidate := m.candidateLocked()
	sort.SliceStable(m.pending, func(i, j int) bool {
		return eventLess(m.pending[i].event, m.pending[j].event, m.pending[i].inputSeq, m.pending[j].inputSeq)
	})

	cut := 0
	for cut < len(m.pending) {
		cluster := m.pending[cut].event.ClusterTime
		if m.holdTies {
			if !cluster.Before(candidate) {
				break
			}
		} else if cluster.After(candidate) {
			break
		}
		cut++
	}
	return m.emitPrefixLocked(cut, m.generation)
}

func (m *Merger) emitPrefixLocked(count int, generation uint64) []Event {
	if count <= 0 {
		return nil
	}
	out := make([]Event, 0, count)
	for _, pending := range m.pending[:count] {
		out = append(out, m.emitLocked(pending.event, generation, false))
	}
	m.pending = append([]pendingEvent(nil), m.pending[count:]...)
	return out
}

func (m *Merger) emitAllLocked() []Event {
	if len(m.pending) == 0 {
		return nil
	}
	sort.SliceStable(m.pending, func(i, j int) bool {
		return eventLess(m.pending[i].event, m.pending[j].event, m.pending[i].inputSeq, m.pending[j].inputSeq)
	})
	out := make([]Event, 0, len(m.pending))
	for _, pending := range m.pending {
		out = append(out, m.emitLocked(pending.event, m.generation, false))
	}
	m.pending = nil
	return out
}

func (m *Merger) emitLocked(event Event, generation uint64, forceGeneration bool) Event {
	event = event.clone()
	m.sequence++
	event.Sequence = m.sequence
	if forceGeneration || event.Generation == 0 {
		event.Generation = generation
	}
	m.lastEvent = event
	m.position = event.Position()

	if shard, ok := m.shards[event.ShardID]; ok && shard.active {
		m.advanceShardLocked(shard, event)
		if !event.ClusterTime.Before(shard.emitted) {
			shard.emitted = event.ClusterTime
			shard.emittedToken = event.ResumeToken
		}
	}
	return event.clone()
}

func (m *Merger) snapshotLocked(result *MergeResult) {
	result.Watermark = m.watermark
	result.Generation = m.generation
	result.Sequence = m.sequence
	result.Position = m.position
}

func dedupeKeys(generation uint64, event Event) []string {
	keys := make([]string, 0, 2)
	if event.ResumeToken != "" {
		keys = append(keys, "g"+strconv.FormatUint(generation, 10)+"|token|"+event.ResumeToken)
	}
	if event.DocumentKey != "" {
		base := "g" + strconv.FormatUint(generation, 10) +
			"|doc|" + strconv.Itoa(len(event.DocumentKey)) + ":" + event.DocumentKey +
			"|op|" + strconv.Itoa(len(event.OperationType)) + ":" + event.OperationType
		txn := event.transaction()
		if txn.hasEvidence() {
			// Transaction identity is stronger than cluster time: a replayed
			// transaction operation has the same session, transaction number
			// and operation index even if it arrives with a different token or
			// cluster-time stamp.
			base += "|txn|" + txn.key()
		} else {
			base += "|" + event.ClusterTime.String()
			if !txn.IsZero() {
				base += "|txn|" + txn.key()
			}
		}
		keys = append(keys, base)
	}
	return keys
}

func sameStream(boundary, event string) bool {
	return boundary == "" || event == "" || boundary == event
}

// Merge is a batch convenience function. It accepts all events, sorts and
// deduplicates them, handles invalidate boundaries, flushes the final
// generation and returns the emitted sequence. When shards is empty they are
// discovered from the events.
func Merge(events []Event, shards ...string) ([]Event, error) {
	merger := NewMerger(shards...)
	result, err := merger.PushBatch(events)
	if err != nil {
		return result.Events, err
	}
	flushed := merger.Flush()
	result.Events = append(result.Events, flushed.Events...)
	return result.Events, nil
}
