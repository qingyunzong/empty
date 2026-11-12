package dataeng

import (
	"container/heap"
	"context"
	"errors"
	"fmt"
)

// Merger merges several immutable, cursor-paginated snapshot sources into
// globally ordered, deduplicated batches with durable, resumable checkpoints.
//
// A Merger is not safe for concurrent use. Each Next call produces at most
// one batch; the caller decides when to request the next one.
type Merger struct {
	sources   []Source
	batchSize int
	tx        Transaction

	committed *Checkpoint
	last      *SortKey
	complete  bool

	// runtime holds prefetched working state derived from committed. It is
	// rebuilt lazily on the first Next call and after every reload.
	runtime []*sourceRuntime
	heads   mergeHeap

	// pending captures the last unconfirmed batch so it can be resent when a
	// durable checkpoint shows no progress.
	pending    []Record
	pendingCP  *Checkpoint
	hasPending bool
	needsLoad  bool
}

type sourceRuntime struct {
	source     Source
	cursor     string
	nextCursor string
	page       []Record
	consumed   int
	exhausted  bool
}

type heapItem struct {
	record Record
	source int
}

type mergeHeap []heapItem

func (h mergeHeap) Len() int { return len(h) }

func (h mergeHeap) Less(i, j int) bool {
	cmp := h[i].record.Key().Compare(h[j].record.Key())
	if cmp != 0 {
		return cmp < 0
	}
	// Equal keys only exist as cross-source duplicates; break ties
	// deterministically by source position.
	return h[i].source < h[j].source
}

func (h mergeHeap) Swap(i, j int) { h[i], h[j] = h[j], h[i] }

func (h *mergeHeap) Push(value any) {
	*h = append(*h, value.(heapItem))
}

func (h *mergeHeap) Pop() any {
	old := *h
	last := len(old) - 1
	item := old[last]
	*h = old[:last]
	return item
}

// NewMerger builds a Merger for the given sources. Every source must have a
// distinct, non-empty Name and a non-empty initial cursor. batchSize must be
// positive. tx performs the atomic batch-and-checkpoint commit.
func NewMerger(sources []Source, initialCursors map[string]string, batchSize int, tx Transaction) (*Merger, error) {
	if len(sources) == 0 {
		return nil, errors.New("dataeng: at least one source is required")
	}
	if batchSize <= 0 {
		return nil, errors.New("dataeng: batchSize must be positive")
	}
	if tx == nil {
		return nil, errors.New("dataeng: transaction is required")
	}

	seen := make(map[string]struct{}, len(sources))
	for _, source := range sources {
		if source == nil {
			return nil, errors.New("dataeng: nil source")
		}
		name := source.Name()
		if name == "" {
			return nil, errors.New("dataeng: source name must not be empty")
		}
		if _, ok := seen[name]; ok {
			return nil, fmt.Errorf("dataeng: duplicate source name %q", name)
		}
		seen[name] = struct{}{}
		if initialCursors != nil {
			cursor, ok := initialCursors[name]
			if !ok || cursor == "" {
				return nil, fmt.Errorf("dataeng: non-empty initial cursor required for source %q", name)
			}
		}
	}

	committed := &Checkpoint{Sources: make(map[string]SourceCheckpoint, len(sources))}
	for name, cursor := range initialCursors {
		committed.Sources[name] = SourceCheckpoint{Cursor: cursor}
	}

	return &Merger{
		sources:   append([]Source(nil), sources...),
		batchSize: batchSize,
		tx:        tx,
		committed: committed,
	}, nil
}

// ResumeMerger rebuilds a Merger from a durable checkpoint. Source names must
// match the checkpoint exactly; the saved cursors replace the initial cursors.
func ResumeMerger(sources []Source, checkpoint *Checkpoint, batchSize int, tx Transaction) (*Merger, error) {
	if checkpoint == nil {
		return nil, errors.New("dataeng: resume checkpoint must not be nil")
	}
	merger, err := NewMerger(sources, nil, batchSize, tx)
	if err != nil {
		return nil, err
	}
	if len(checkpoint.Sources) != len(sources) {
		return nil, errors.New("dataeng: resume checkpoint does not cover every source")
	}
	for _, source := range sources {
		if _, ok := checkpoint.Sources[source.Name()]; !ok {
			return nil, fmt.Errorf("dataeng: resume checkpoint missing source %q", source.Name())
		}
	}

	merger.committed = checkpoint.Clone()
	merger.last = cloneKey(checkpoint.LastDelivered)
	merger.complete = checkpoint.Complete
	return merger, nil
}

// CommittedCheckpoint returns a deep copy of the last durably confirmed
// checkpoint.
func (m *Merger) CommittedCheckpoint() *Checkpoint {
	return m.committed.Clone()
}

// Next delivers the next ordered, deduplicated batch and asks the
// Transaction to atomically commit it with its checkpoint.
//
// ErrComplete is returned once all sources are exhausted and the completion
// checkpoint is confirmed. A source read error aborts the batch without any
// delivery or position change. An explicit rejection leaves the position
// untouched so the same batch can be retried. An unknown confirmation outcome
// triggers a checkpoint reload; if the reload fails, Next returns the error
// without delivering anything.
func (m *Merger) Next(ctx context.Context) ([]Record, error) {
	if m.needsLoad {
		if err := m.reload(ctx); err != nil {
			return nil, err
		}
	}
	if m.complete {
		return nil, ErrComplete
	}

	if err := m.ensureRuntime(ctx); err != nil {
		m.resetRuntime()
		return nil, err
	}

	records, snapshot, err := m.buildBatch(ctx)
	if err != nil {
		// Read failure: discard tentative progress and stay at the committed
		// position, so nothing from this batch is delivered.
		m.resetRuntime()
		return nil, err
	}
	if err := m.commit(ctx, records, snapshot); err != nil {
		return nil, err
	}
	if len(records) == 0 {
		// All sources are exhausted and only duplicates remained: the
		// completion marker is durable, so report completion without an
		// empty batch.
		return nil, ErrComplete
	}
	return cloneRecords(records), nil
}

// commit runs the transactional confirmation and applies the required
// recovery semantics for explicit rejection and unknown outcomes.
func (m *Merger) commit(ctx context.Context, records []Record, snapshot *Checkpoint) error {
	if err := m.tx.Confirm(ctx, cloneRecords(records), snapshot); err != nil {
		m.resetRuntime()
		m.rememberPending(records, snapshot)
		if errors.Is(err, ErrRejected) {
			// Explicit failure: nothing was committed. Keep the committed
			// position; the next call rebuilds and resends the same batch.
			m.needsLoad = false
			return err
		}
		// Unknown outcome: trust only the durable checkpoint.
		if loadErr := m.reload(ctx); loadErr != nil {
			return loadErr
		}
		return err
	}

	m.committed = snapshot
	m.last = cloneKey(snapshot.LastDelivered)
	m.complete = snapshot.Complete
	m.hasPending = false
	m.pending = nil
	m.pendingCP = nil
	m.resetRuntime()
	return nil
}

func (m *Merger) rememberPending(records []Record, checkpoint *Checkpoint) {
	m.pending = cloneRecords(records)
	m.pendingCP = checkpoint.Clone()
	m.hasPending = true
	m.needsLoad = true
}

// reload reads the durable checkpoint and adopts it when it represents
// progress at or beyond the unconfirmed batch. Otherwise the unconfirmed
// batch remains pending for redelivery.
func (m *Merger) reload(ctx context.Context) error {
	store, ok := m.tx.(CheckpointStore)
	if !ok {
		return errors.New("dataeng: transaction must implement CheckpointStore to recover")
	}
	checkpoint, err := store.Load(ctx)
	if err != nil {
		// Durable state is unreadable: stop rather than risk redelivery.
		return fmt.Errorf("dataeng: checkpoint load failed: %w", err)
	}
	m.needsLoad = false
	if checkpoint == nil {
		// Nothing durable was saved: the unconfirmed batch was not committed.
		return nil
	}
	if !m.hasPending || advancedBeyond(checkpoint, m.pendingCP) {
		m.committed = checkpoint.Clone()
		m.last = cloneKey(checkpoint.LastDelivered)
		m.complete = checkpoint.Complete
		m.hasPending = false
		m.pending = nil
		m.pendingCP = nil
	}
	// Otherwise the durable checkpoint still matches the position before the
	// pending batch, so resend the same records on the next call.
	return nil
}

// advancedBeyond reports whether durable represents progress at least as far
// as pending, including a completed merge.
func advancedBeyond(durable, pending *Checkpoint) bool {
	if durable.Complete {
		return true
	}
	if durable.LastDelivered == nil {
		return false
	}
	if pending == nil || pending.LastDelivered == nil {
		return true
	}
	return durable.LastDelivered.Compare(*pending.LastDelivered) >= 0
}

// ensureRuntime rebuilds prefetched pages and the merge heap from the
// committed checkpoint.
func (m *Merger) ensureRuntime(ctx context.Context) error {
	if m.runtime != nil {
		return nil
	}
	m.runtime = make([]*sourceRuntime, len(m.sources))
	m.heads = nil

	for index, source := range m.sources {
		state, ok := m.committed.Sources[source.Name()]
		if !ok {
			return fmt.Errorf("dataeng: checkpoint missing source %q", source.Name())
		}
		rt := &sourceRuntime{
			source:     source,
			cursor:     state.Cursor,
			nextCursor: state.NextCursor,
			consumed:   state.Consumed,
			exhausted:  state.Cursor == "",
		}
		m.runtime[index] = rt
		if rt.exhausted {
			continue
		}
		if err := m.fetchPage(ctx, rt); err != nil {
			return err
		}
		// Defensive handling for a checkpoint positioned exactly at a page
		// boundary: advance until the next unconsumed record is available.
		for rt.consumed >= len(rt.page) && !rt.exhausted {
			if err := m.advance(ctx, rt); err != nil {
				return err
			}
		}
		if !rt.exhausted {
			heap.Push(&m.heads, heapItem{record: rt.page[rt.consumed], source: index})
		}
	}
	return nil
}

// fetchPage loads the page at rt.cursor and validates source invariants.
func (m *Merger) fetchPage(ctx context.Context, rt *sourceRuntime) error {
	records, nextCursor, err := rt.source.Fetch(ctx, rt.cursor)
	if err != nil {
		return fmt.Errorf("dataeng: source %q fetch failed: %w", rt.source.Name(), err)
	}
	if len(records) == 0 {
		return fmt.Errorf("dataeng: source %q returned an empty page", rt.source.Name())
	}
	rt.page = records
	rt.nextCursor = nextCursor
	rt.consumed = 0
	return nil
}

// advance moves past a fully consumed page and, when another page exists,
// fetches it. An empty next cursor exhausts the source.
func (m *Merger) advance(ctx context.Context, rt *sourceRuntime) error {
	if rt.nextCursor == "" {
		rt.exhausted = true
		rt.cursor = ""
		rt.nextCursor = ""
		rt.page = nil
		rt.consumed = 0
		return nil
	}
	rt.cursor = rt.nextCursor
	return m.fetchPage(ctx, rt)
}

// buildBatch pulls up to batchSize unique, globally ordered records. Any read
// error aborts the whole batch before delivery.
func (m *Merger) buildBatch(ctx context.Context) ([]Record, *Checkpoint, error) {
	records := make([]Record, 0, m.batchSize)

	// The heap holds the current head record of every non-exhausted source.
	// Popping a record and immediately refilling its source keeps the heap
	// populated whenever any source still has data, so duplicate-only pulls
	// never look like completion.
	for len(records) < m.batchSize {
		for m.heads.Len() == 0 && !m.allExhausted() {
			if err := m.refillHeaps(ctx); err != nil {
				return nil, nil, err
			}
		}
		if m.heads.Len() == 0 {
			break
		}
		item := heap.Pop(&m.heads).(heapItem)
		rt := m.runtime[item.source]
		rt.consumed++

		key := item.record.Key()
		skip := false
		if m.last != nil && key.Compare(*m.last) <= 0 {
			// Record already delivered in an earlier confirmed batch.
			skip = true
		}
		if len(records) > 0 && records[len(records)-1].Key().Compare(key) == 0 {
			// Cross-source duplicate within the merged stream.
			skip = true
		}
		if !skip {
			records = append(records, item.record)
		}

		if rt.consumed >= len(rt.page) {
			if err := m.advance(ctx, rt); err != nil {
				return nil, nil, err
			}
		}
		if !rt.exhausted {
			heap.Push(&m.heads, heapItem{record: rt.page[rt.consumed], source: item.source})
		}
	}

	checkpoint := m.snapshot()
	if m.allExhausted() {
		checkpoint.Complete = true
	}
	if len(records) > 0 {
		key := records[len(records)-1].Key()
		checkpoint.LastDelivered = &key
	} else {
		checkpoint.LastDelivered = cloneKey(m.last)
	}
	if len(records) == 0 {
		// Every remaining record was an already-delivered duplicate and all
		// sources are drained: completion is the only state to report. The
		// checkpoint keeps the previously confirmed LastDelivered key.
		return nil, checkpoint, nil
	}
	return records, checkpoint, nil
}

// allExhausted reports whether every source runtime is physically drained.
func (m *Merger) allExhausted() bool {
	for _, rt := range m.runtime {
		if rt == nil || !rt.exhausted {
			return false
		}
	}
	return true
}

// refillHeaps advances page-boundary sources and pushes the next head
// record of every non-exhausted source missing from the heap.
func (m *Merger) refillHeaps(ctx context.Context) error {
	inHeap := make(map[int]bool, m.heads.Len())
	for _, item := range m.heads {
		inHeap[item.source] = true
	}
	for index, rt := range m.runtime {
		if inHeap[index] {
			continue
		}
		if rt.exhausted {
			continue
		}
		if rt.consumed >= len(rt.page) {
			if err := m.advance(ctx, rt); err != nil {
				return err
			}
		}
		if !rt.exhausted {
			heap.Push(&m.heads, heapItem{record: rt.page[rt.consumed], source: index})
		}
	}
	return nil
}

// snapshot converts the tentative runtime positions into a checkpoint.
func (m *Merger) snapshot() *Checkpoint {
	checkpoint := &Checkpoint{Sources: make(map[string]SourceCheckpoint, len(m.runtime))}
	for _, rt := range m.runtime {
		if rt.exhausted {
			checkpoint.Sources[rt.source.Name()] = SourceCheckpoint{}
			continue
		}
		checkpoint.Sources[rt.source.Name()] = SourceCheckpoint{
			Cursor:     rt.cursor,
			NextCursor: rt.nextCursor,
			Consumed:   rt.consumed,
		}
	}
	return checkpoint
}

func (m *Merger) resetRuntime() {
	m.runtime = nil
	m.heads = nil
}

func cloneKey(key *SortKey) *SortKey {
	if key == nil {
		return nil
	}
	clone := *key
	return &clone
}

func cloneRecords(records []Record) []Record {
	if records == nil {
		return nil
	}
	clone := make([]Record, len(records))
	copy(clone, records)
	return clone
}
