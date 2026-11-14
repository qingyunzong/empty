package dataeng

import (
	"fmt"
	"sort"
	"sync"
)

type entryKey struct {
	ledgerID int64
	entryID  int64
}

type indexSet map[int32]struct{}

// Tracker stores Pulsar batch acknowledgement state together with a separate
// output-commit ledger.
//
// The two states intentionally have different lifetimes:
//
//   - Topic unloads and subscription generation changes invalidate broker
//     acknowledgements. Otherwise an old ack could hide a redelivered message.
//   - Output commits remain recorded across those events. If the broker
//     redelivers a batch, a committed index is reported as NeedsAckOnly and is
//     never published twice.
//
// A zero Tracker is ready for use. All methods are safe for concurrent use.
type Tracker struct {
	mu sync.Mutex

	topic        string
	subscription string
	token        Token

	cumulative *MessageID
	acked      map[entryKey]indexSet
	published  map[entryKey]indexSet
}

// AckTracker, AckState and BatchAckTracker are aliases for Tracker.
type AckTracker = Tracker
type AckState = Tracker
type BatchAckTracker = Tracker

// NewTracker creates an empty tracker. It accepts an optional topic and
// subscription as its first two arguments.
func NewTracker(scope ...string) *Tracker {
	return newTracker(Options{}, scope)
}

// New is an alias for NewTracker.
func New(scope ...string) *Tracker {
	return NewTracker(scope...)
}

// NewAckTracker is an alias for NewTracker.
func NewAckTracker(scope ...string) *Tracker {
	return NewTracker(scope...)
}

// NewAckState is an alias for NewTracker.
func NewAckState(scope ...string) *Tracker {
	return NewTracker(scope...)
}

// NewWithOptions creates a tracker with explicit scope and generations.
func NewWithOptions(opts Options) *Tracker {
	t := &Tracker{
		topic:        opts.Topic,
		subscription: opts.Subscription,
		token: Token{
			TopicGeneration:        opts.TopicGeneration,
			SubscriptionGeneration: opts.SubscriptionGeneration,
		},
		acked:     make(map[entryKey]indexSet),
		published: make(map[entryKey]indexSet),
	}
	return t
}

// NewTrackerWithOptions is an alias for NewWithOptions.
func NewTrackerWithOptions(opts Options) *Tracker {
	return NewWithOptions(opts)
}

func newTracker(opts Options, scope []string) *Tracker {
	if len(scope) > 0 {
		opts.Topic = scope[0]
	}
	if len(scope) > 1 {
		opts.Subscription = scope[1]
	}
	return NewWithOptions(opts)
}

func (t *Tracker) ensureMapsLocked() {
	if t.acked == nil {
		t.acked = make(map[entryKey]indexSet)
	}
	if t.published == nil {
		t.published = make(map[entryKey]indexSet)
	}
}

// Topic returns the configured topic name.
func (t *Tracker) Topic() string {
	t.mu.Lock()
	defer t.mu.Unlock()
	return t.topic
}

// Subscription returns the configured subscription name.
func (t *Tracker) Subscription() string {
	t.mu.Lock()
	defer t.mu.Unlock()
	return t.subscription
}

// Scope returns the topic and subscription names.
func (t *Tracker) Scope() (topic, subscription string) {
	t.mu.Lock()
	defer t.mu.Unlock()
	return t.topic, t.subscription
}

// Token returns the current generation token.
func (t *Tracker) Token() Token {
	t.mu.Lock()
	defer t.mu.Unlock()
	return t.token
}

// CurrentToken is an alias for Token.
func (t *Tracker) CurrentToken() Token {
	return t.Token()
}

// TopicGeneration returns the current topic generation.
func (t *Tracker) TopicGeneration() uint64 {
	return t.Token().TopicGeneration
}

// SubscriptionGeneration returns the current subscription generation.
func (t *Tracker) SubscriptionGeneration() uint64 {
	return t.Token().SubscriptionGeneration
}

// CheckToken reports ErrStaleGeneration when tok is not current.
func (t *Tracker) CheckToken(tok Token) error {
	t.mu.Lock()
	defer t.mu.Unlock()
	if tok != t.token {
		return fmt.Errorf("%w: got %+v current %+v", ErrStaleGeneration, tok, t.token)
	}
	return nil
}

// Ack applies an acknowledgement in the current generation. An optional token
// makes the operation generation-checked, like AckAt.
func (t *Tracker) Ack(id MessageID, typ AckType, token ...Token) error {
	t.mu.Lock()
	defer t.mu.Unlock()
	if len(token) > 0 && token[0] != t.token {
		return fmt.Errorf("%w: got %+v current %+v", ErrStaleGeneration, token[0], t.token)
	}
	return t.ackLocked(id, typ)
}

// AckAt applies an acknowledgement only if tok still matches the tracker's
// current generation. This is the form to use for async ack RPC completions,
// which can arrive after a topic unload or subscription generation change.
func (t *Tracker) AckAt(tok Token, id MessageID, typ AckType) error {
	t.mu.Lock()
	defer t.mu.Unlock()
	if tok != t.token {
		return fmt.Errorf("%w: got %+v current %+v", ErrStaleGeneration, tok, t.token)
	}
	return t.ackLocked(id, typ)
}

// AckIndividual acknowledges one logical message. An optional token makes the
// operation generation-checked.
func (t *Tracker) AckIndividual(id MessageID, token ...Token) error {
	return t.Ack(id, AckIndividual, token...)
}

// AckIndividualAt is the generation-checked form of AckIndividual.
func (t *Tracker) AckIndividualAt(tok Token, id MessageID) error {
	return t.AckAt(tok, id, AckIndividual)
}

// AckCumulative acknowledges every message at or before id. An optional token
// makes the operation generation-checked.
func (t *Tracker) AckCumulative(id MessageID, token ...Token) error {
	return t.Ack(id, AckCumulative, token...)
}

// AckCumulativeAt is the generation-checked form of AckCumulative.
func (t *Tracker) AckCumulativeAt(tok Token, id MessageID) error {
	return t.AckAt(tok, id, AckCumulative)
}

// AckBatchIndex is an alias for AckIndividual.
func (t *Tracker) AckBatchIndex(id MessageID, token ...Token) error {
	return t.AckIndividual(id, token...)
}

// AckAll acknowledges each supplied message individually.
func (t *Tracker) AckAll(ids ...MessageID) error {
	return t.AckMany(AckIndividual, ids...)
}

// AckMany acknowledges several messages with the same semantics. Validation is
// atomic: no acknowledgement is applied if any coordinate is invalid.
func (t *Tracker) AckMany(typ AckType, ids ...MessageID) error {
	t.mu.Lock()
	defer t.mu.Unlock()
	if typ != AckIndividual && typ != AckCumulative {
		return fmt.Errorf("%w: %d", ErrInvalidAckType, uint8(typ))
	}
	for _, id := range ids {
		if err := id.Validate(); err != nil {
			return err
		}
	}
	for _, id := range ids {
		if err := t.ackLocked(id, typ); err != nil {
			return err
		}
	}
	return nil
}

// AckIndexes acknowledges selected indexes of one batched entry.
func (t *Tracker) AckIndexes(ledgerID, entryID int64, indexes ...int32) error {
	t.mu.Lock()
	defer t.mu.Unlock()
	for _, index := range indexes {
		id := MessageID{LedgerID: ledgerID, EntryID: entryID, BatchIndex: index}
		if err := id.Validate(); err != nil {
			return err
		}
	}
	for _, index := range indexes {
		if err := t.ackLocked(MessageID{LedgerID: ledgerID, EntryID: entryID, BatchIndex: index}, AckIndividual); err != nil {
			return err
		}
	}
	return nil
}

// AckBatch acknowledges every index in the batch individually.
func (t *Tracker) AckBatch(batch BatchID) error {
	if err := batch.Validate(); err != nil {
		return err
	}
	t.mu.Lock()
	defer t.mu.Unlock()
	for i := 0; i < batch.Count; i++ {
		if err := t.ackLocked(batch.Message(int32(i)), AckIndividual); err != nil {
			return err
		}
	}
	return nil
}

func (t *Tracker) ackLocked(id MessageID, typ AckType) error {
	if err := id.Validate(); err != nil {
		return err
	}
	t.ensureMapsLocked()
	switch typ {
	case AckIndividual:
		if t.coveredByCumulativeLocked(id) {
			return nil
		}
		set := t.acked[entryKey{id.LedgerID, id.EntryID}]
		if set == nil {
			set = make(indexSet)
			t.acked[entryKey{id.LedgerID, id.EntryID}] = set
		}
		set[id.BatchIndex] = struct{}{}
		return nil
	case AckCumulative:
		if t.cumulative != nil && Compare(id, *t.cumulative) <= 0 {
			return nil
		}
		watermark := id
		t.cumulative = &watermark
		t.pruneAckedLocked()
		return nil
	default:
		return fmt.Errorf("%w: %d", ErrInvalidAckType, uint8(typ))
	}
}

func (t *Tracker) coveredByCumulativeLocked(id MessageID) bool {
	return t.cumulative != nil && Compare(id, *t.cumulative) <= 0
}

func (t *Tracker) pruneAckedLocked() {
	if t.cumulative == nil {
		return
	}
	for key, set := range t.acked {
		if compareEntryToWatermark(key, *t.cumulative) < 0 {
			delete(t.acked, key)
			continue
		}
		if compareEntryToWatermark(key, *t.cumulative) > 0 {
			continue
		}
		for index := range set {
			if index <= t.cumulative.BatchIndex {
				delete(set, index)
			}
		}
		if len(set) == 0 {
			delete(t.acked, key)
		}
	}
}

func compareEntryToWatermark(key entryKey, watermark MessageID) int {
	switch {
	case key.ledgerID < watermark.LedgerID:
		return -1
	case key.ledgerID > watermark.LedgerID:
		return 1
	case key.entryID < watermark.EntryID:
		return -1
	case key.entryID > watermark.EntryID:
		return 1
	default:
		return 0
	}
}

// IsAcked reports whether the coordinate is covered by an individual or
// cumulative acknowledgement in the current generation.
func (t *Tracker) IsAcked(id MessageID) bool {
	if id.Validate() != nil {
		return false
	}
	t.mu.Lock()
	defer t.mu.Unlock()
	if t.coveredByCumulativeLocked(id) {
		return true
	}
	set := t.acked[entryKey{id.LedgerID, id.EntryID}]
	_, ok := set[id.BatchIndex]
	return ok
}

// NeedsAck reports whether the coordinate is still unacknowledged.
func (t *Tracker) NeedsAck(id MessageID) bool {
	return !t.IsAcked(id)
}

// IsPublished reports whether output for the coordinate has already been
// committed. Publish state is retained across ack invalidation.
func (t *Tracker) IsPublished(id MessageID) bool {
	if id.Validate() != nil {
		return false
	}
	t.mu.Lock()
	defer t.mu.Unlock()
	set := t.published[entryKey{id.LedgerID, id.EntryID}]
	_, ok := set[id.BatchIndex]
	return ok
}

// IsCommitted is an alias for IsPublished.
func (t *Tracker) IsCommitted(id MessageID) bool {
	return t.IsPublished(id)
}

// Classify tells a consumer whether to process and publish, only ack, or skip
// a redelivered logical message.
func (t *Tracker) Classify(id MessageID) Disposition {
	if id.Validate() != nil {
		return NeedsProcessing
	}
	t.mu.Lock()
	defer t.mu.Unlock()
	if t.coveredByCumulativeLocked(id) {
		return AlreadyComplete
	}
	key := entryKey{id.LedgerID, id.EntryID}
	if _, ok := t.acked[key][id.BatchIndex]; ok {
		return AlreadyComplete
	}
	if _, ok := t.published[key][id.BatchIndex]; ok {
		return NeedsAckOnly
	}
	return NeedsProcessing
}

// ShouldProcess reports whether output still has to be produced.
func (t *Tracker) ShouldProcess(id MessageID) bool {
	return t.Classify(id) == NeedsProcessing
}

// ShouldPublish is an alias for ShouldProcess.
func (t *Tracker) ShouldPublish(id MessageID) bool {
	return t.ShouldProcess(id)
}

// MarkPublished records that output for each coordinate was committed. It is
// idempotent and must be called only after the output commit succeeds.
func (t *Tracker) MarkPublished(ids ...MessageID) error {
	t.mu.Lock()
	defer t.mu.Unlock()
	for _, id := range ids {
		if err := id.Validate(); err != nil {
			return err
		}
	}
	t.ensureMapsLocked()
	for _, id := range ids {
		key := entryKey{id.LedgerID, id.EntryID}
		set := t.published[key]
		if set == nil {
			set = make(indexSet)
			t.published[key] = set
		}
		set[id.BatchIndex] = struct{}{}
	}
	return nil
}

// MarkCommitted is an alias for MarkPublished.
func (t *Tracker) MarkCommitted(ids ...MessageID) error {
	return t.MarkPublished(ids...)
}

// Commit is an alias for MarkPublished.
func (t *Tracker) Commit(ids ...MessageID) error {
	return t.MarkPublished(ids...)
}

// Publish is an alias for MarkPublished.
func (t *Tracker) Publish(ids ...MessageID) error {
	return t.MarkPublished(ids...)
}

// CumulativeAck returns the current cumulative acknowledgement watermark.
func (t *Tracker) CumulativeAck() (MessageID, bool) {
	t.mu.Lock()
	defer t.mu.Unlock()
	if t.cumulative == nil {
		return MessageID{}, false
	}
	return *t.cumulative, true
}

// BatchStatus scans a re-delivered batch. The returned Err field is set for an
// invalid batch description.
func (t *Tracker) BatchStatus(batch BatchID) BatchStatus {
	if err := batch.Validate(); err != nil {
		return BatchStatus{LedgerID: batch.LedgerID, EntryID: batch.EntryID, Count: batch.Count, Err: err}
	}
	indexes := batch.Indexes()
	status := t.ScanIndexes(batch.LedgerID, batch.EntryID, indexes)
	status.Count = batch.Count
	return status
}

// ScanBatch is an alias for BatchStatus.
func (t *Tracker) ScanBatch(batch BatchID) BatchStatus {
	return t.BatchStatus(batch)
}

// ScanIndexes scans an arbitrary set of batch indexes. Duplicate indexes are
// ignored, so callers may pass the indexes of a redelivered batch directly.
func (t *Tracker) ScanIndexes(ledgerID, entryID int64, indexes []int32) BatchStatus {
	status := BatchStatus{LedgerID: ledgerID, EntryID: entryID}
	if err := (MessageID{LedgerID: ledgerID, EntryID: entryID, BatchIndex: -1}).Validate(); err != nil {
		status.Err = err
		return status
	}

	unique := make(map[int32]struct{}, len(indexes))
	for _, index := range indexes {
		id := MessageID{LedgerID: ledgerID, EntryID: entryID, BatchIndex: index}
		if err := id.Validate(); err != nil {
			status.Err = err
			return BatchStatus{LedgerID: ledgerID, EntryID: entryID, Err: err}
		}
		unique[index] = struct{}{}
	}
	sorted := make([]int32, 0, len(unique))
	for index := range unique {
		sorted = append(sorted, index)
	}
	sort.Slice(sorted, func(i, j int) bool { return sorted[i] < sorted[j] })
	status.Count = len(sorted)

	t.mu.Lock()
	defer t.mu.Unlock()
	for _, index := range sorted {
		id := MessageID{LedgerID: ledgerID, EntryID: entryID, BatchIndex: index}
		state := t.classifyLocked(id)
		if state == AlreadyComplete {
			status.Acknowledged = append(status.Acknowledged, index)
			continue
		}
		status.Unacknowledged = append(status.Unacknowledged, index)
		if state == NeedsAckOnly {
			status.ToAck = append(status.ToAck, index)
		} else {
			status.ToPublish = append(status.ToPublish, index)
		}
	}
	return status
}

func (t *Tracker) classifyLocked(id MessageID) Disposition {
	if t.coveredByCumulativeLocked(id) {
		return AlreadyComplete
	}
	key := entryKey{id.LedgerID, id.EntryID}
	if _, ok := t.acked[key][id.BatchIndex]; ok {
		return AlreadyComplete
	}
	if _, ok := t.published[key][id.BatchIndex]; ok {
		return NeedsAckOnly
	}
	return NeedsProcessing
}

// PendingIndices returns the unacknowledged indexes of a contiguous batch.
func (t *Tracker) PendingIndices(ledgerID, entryID int64, count int) []int32 {
	return t.BatchStatus(BatchID{LedgerID: ledgerID, EntryID: entryID, Count: count}).Pending()
}

// PendingIndexes is an alias for PendingIndices.
func (t *Tracker) PendingIndexes(ledgerID, entryID int64, count int) []int32 {
	return t.PendingIndices(ledgerID, entryID, count)
}

// UnacknowledgedIndices is an alias for PendingIndices.
func (t *Tracker) UnacknowledgedIndices(ledgerID, entryID int64, count int) []int32 {
	return t.PendingIndices(ledgerID, entryID, count)
}

// PublishableIndices returns the unacknowledged indexes with no committed
// output. These are the only indexes safe to publish after a redelivery.
func (t *Tracker) PublishableIndices(ledgerID, entryID int64, count int) []int32 {
	status := t.BatchStatus(BatchID{LedgerID: ledgerID, EntryID: entryID, Count: count})
	return append([]int32(nil), status.ToPublish...)
}

// ProcessableIndices is an alias for PublishableIndices.
func (t *Tracker) ProcessableIndices(ledgerID, entryID int64, count int) []int32 {
	return t.PublishableIndices(ledgerID, entryID, count)
}

// AckOnlyIndices returns committed-but-unacknowledged indexes.
func (t *Tracker) AckOnlyIndices(ledgerID, entryID int64, count int) []int32 {
	status := t.BatchStatus(BatchID{LedgerID: ledgerID, EntryID: entryID, Count: count})
	return append([]int32(nil), status.ToAck...)
}

// PendingMessages is PendingIndices with full message coordinates.
func (t *Tracker) PendingMessages(ledgerID, entryID int64, count int) []MessageID {
	indexes := t.PendingIndices(ledgerID, entryID, count)
	out := make([]MessageID, len(indexes))
	for i, index := range indexes {
		out[i] = MessageID{LedgerID: ledgerID, EntryID: entryID, BatchIndex: index}
	}
	return out
}

// OnTopicUnload invalidates all acknowledgements and advances the topic
// generation. Output commits survive. With an optional generation argument the
// supplied value is installed; otherwise the generation is incremented.
func (t *Tracker) OnTopicUnload(generation ...uint64) Token {
	t.mu.Lock()
	defer t.mu.Unlock()
	if len(generation) > 0 {
		if generation[0] < t.token.TopicGeneration {
			// A delayed notification from an older topic load must not move the
			// generation backwards and make old ack tokens valid again.
			return t.token
		}
		t.token.TopicGeneration = generation[0]
	} else {
		t.token.TopicGeneration++
	}
	t.clearAcksLocked()
	return t.token
}

// UnloadTopic is an alias for OnTopicUnload.
func (t *Tracker) UnloadTopic(generation ...uint64) Token {
	return t.OnTopicUnload(generation...)
}

// OnTopicGeneration installs a topic generation. Acknowledgements are cleared
// when the generation changes. With no argument the generation is incremented.
func (t *Tracker) OnTopicGeneration(generation ...uint64) Token {
	t.mu.Lock()
	defer t.mu.Unlock()
	var next uint64
	if len(generation) > 0 {
		next = generation[0]
	} else {
		next = t.token.TopicGeneration + 1
	}
	if next > t.token.TopicGeneration || len(generation) == 0 {
		t.token.TopicGeneration = next
		t.clearAcksLocked()
	}
	return t.token
}

// SetTopicGeneration is an alias for OnTopicGeneration.
func (t *Tracker) SetTopicGeneration(generation uint64) Token {
	return t.OnTopicGeneration(generation)
}

// OnSubscriptionGeneration installs a subscription generation. Acknowledgements
// are cleared when the generation changes. With no argument the generation is
// incremented.
func (t *Tracker) OnSubscriptionGeneration(generation ...uint64) Token {
	t.mu.Lock()
	defer t.mu.Unlock()
	var next uint64
	if len(generation) > 0 {
		next = generation[0]
	} else {
		next = t.token.SubscriptionGeneration + 1
	}
	if next > t.token.SubscriptionGeneration || len(generation) == 0 {
		t.token.SubscriptionGeneration = next
		t.clearAcksLocked()
	}
	return t.token
}

// SetSubscriptionGeneration is an alias for OnSubscriptionGeneration.
func (t *Tracker) SetSubscriptionGeneration(generation uint64) Token {
	return t.OnSubscriptionGeneration(generation)
}

// AdvanceSubscriptionGeneration increments the subscription generation.
func (t *Tracker) AdvanceSubscriptionGeneration() Token {
	return t.OnSubscriptionGeneration()
}

// OnSubscriptionChange is an alias for OnSubscriptionGeneration.
func (t *Tracker) OnSubscriptionChange(generation ...uint64) Token {
	return t.OnSubscriptionGeneration(generation...)
}

// InvalidateAcks clears all acknowledgement state without changing the
// generation. Output commits are retained.
func (t *Tracker) InvalidateAcks() {
	t.mu.Lock()
	defer t.mu.Unlock()
	t.clearAcksLocked()
}

// Invalidate is an alias for InvalidateAcks.
func (t *Tracker) Invalidate() {
	t.InvalidateAcks()
}

// ClearAcks is an alias for InvalidateAcks.
func (t *Tracker) ClearAcks() {
	t.InvalidateAcks()
}

func (t *Tracker) clearAcksLocked() {
	t.cumulative = nil
	t.acked = make(map[entryKey]indexSet)
}

// ClearCommits clears only the output-commit ledger.
func (t *Tracker) ClearCommits() {
	t.mu.Lock()
	defer t.mu.Unlock()
	t.published = make(map[entryKey]indexSet)
}

// ClearPublished is an alias for ClearCommits.
func (t *Tracker) ClearPublished() {
	t.ClearCommits()
}

// PrunePublishedThrough removes output-commit records at or before id. Call it
// only after the subscription cursor has advanced past id and those entries can
// no longer be redelivered; otherwise a future redelivery might publish them
// again.
func (t *Tracker) PrunePublishedThrough(id MessageID) error {
	if err := id.Validate(); err != nil {
		return err
	}
	t.mu.Lock()
	defer t.mu.Unlock()
	for key, set := range t.published {
		switch compareEntryToWatermark(key, id) {
		case -1:
			delete(t.published, key)
		case 0:
			for index := range set {
				if index <= id.BatchIndex {
					delete(set, index)
				}
			}
			if len(set) == 0 {
				delete(t.published, key)
			}
		}
	}
	return nil
}

// PruneCommitsThrough is an alias for PrunePublishedThrough.
func (t *Tracker) PruneCommitsThrough(id MessageID) error {
	return t.PrunePublishedThrough(id)
}

// Reset clears acknowledgements, output commits and advances both
// generations, making previously issued tokens stale.
func (t *Tracker) Reset() Token {
	t.mu.Lock()
	defer t.mu.Unlock()
	t.token.TopicGeneration++
	t.token.SubscriptionGeneration++
	t.clearAcksLocked()
	t.published = make(map[entryKey]indexSet)
	return t.token
}

// Clone returns an independent copy of the tracker.
func (t *Tracker) Clone() *Tracker {
	t.mu.Lock()
	defer t.mu.Unlock()
	clone := &Tracker{
		topic:        t.topic,
		subscription: t.subscription,
		token:        t.token,
		acked:        cloneIndexSets(t.acked),
		published:    cloneIndexSets(t.published),
	}
	if t.cumulative != nil {
		watermark := *t.cumulative
		clone.cumulative = &watermark
	}
	return clone
}

func cloneIndexSets(source map[entryKey]indexSet) map[entryKey]indexSet {
	out := make(map[entryKey]indexSet, len(source))
	for key, set := range source {
		copied := make(indexSet, len(set))
		for index := range set {
			copied[index] = struct{}{}
		}
		out[key] = copied
	}
	return out
}
