package formal

import (
	"context"
	"errors"
	"fmt"
	"path/filepath"
	"sort"
	"sync"
)

type config struct {
	sink       Sink
	checkpoint CheckpointFunc
}

// Option configures a Coordinator.
type Option func(*config) error

// WithSink installs the external sink. Deliveries are serialized in commit
// order. A nil sink is valid; the committed view in the coordinator is then
// the observable output.
func WithSink(sink Sink) Option {
	return func(cfg *config) error {
		cfg.sink = sink
		return nil
	}
}

// WithCheckpoint installs a crash-point callback. It is intended for fault
// injection tests. Returning an error fails the coordinator closed; reopening
// the same directory replays the durable log.
func WithCheckpoint(checkpoint CheckpointFunc) Option {
	return func(cfg *config) error {
		cfg.checkpoint = checkpoint
		return nil
	}
}

// Coordinator owns the durable commit log and the in-memory committed view.
//
// All state changes are serialized. Sink delivery is serialized by commit
// sequence, but external sink I/O happens without holding the state lock.
type Coordinator struct {
	applyMu sync.Mutex
	mu      sync.Mutex

	log        journal
	sink       Sink
	checkpoint CheckpointFunc

	txns           map[TxnID]*txnState
	committedOrder []*txnState
	recordOwners   map[string]TxnID

	closed  bool
	failure error
}

type txnState struct {
	id      TxnID
	state   TxnState
	records []Record
	seen    map[string]struct{}
	digest  [32]byte

	beginSeq   uint64
	prepareSeq uint64
	commitSeq  uint64
	abortSeq   uint64

	applied bool
}

// Transaction is a lightweight handle returned by Begin. A handle remains
// valid across duplicate Begin calls and can be used to inspect or retry the
// transaction.
type Transaction struct {
	coordinator *Coordinator
	id          TxnID
}

// ID returns the transaction identifier.
func (t *Transaction) ID() TxnID { return t.id }

// Open opens (or creates) a durable commit log in dir/commit.log, replays the
// complete log, restores prepared transactions as in-flight data, and retries
// delivery of committed but unacknowledged transactions.
//
// If recovery can replay the log but the sink fails, Open returns a non-nil
// coordinator together with the sink error. The caller may retry Recover or
// close the coordinator. A corrupt log returns a nil coordinator.
func Open(dir string, options ...Option) (*Coordinator, error) {
	return OpenContext(context.Background(), dir, options...)
}

// OpenContext is Open with a context controlling recovery and sink delivery.
func OpenContext(ctx context.Context, dir string, options ...Option) (*Coordinator, error) {
	if ctx == nil {
		ctx = context.Background()
	}
	if dir == "" {
		return nil, fmt.Errorf("formal: empty journal directory")
	}
	cfg := config{}
	for _, option := range options {
		if option == nil {
			continue
		}
		if err := option(&cfg); err != nil {
			return nil, err
		}
	}

	log, err := openFileLog(filepath.Join(dir, "commit.log"))
	if err != nil {
		return nil, err
	}
	c := &Coordinator{
		log:          log,
		sink:         cfg.sink,
		checkpoint:   cfg.checkpoint,
		txns:         make(map[TxnID]*txnState),
		recordOwners: make(map[string]TxnID),
	}
	if err := c.replay(ctx); err != nil {
		if errors.Is(err, ErrCrash) {
			return c, err
		}
		entriesErr := log.close()
		return nil, errors.Join(err, entriesErr)
	}
	if err := c.Recover(ctx); err != nil {
		return c, err
	}
	return c, nil
}

func (c *Coordinator) replay(ctx context.Context) error {
	if err := ctx.Err(); err != nil {
		return err
	}

	c.applyMu.Lock()
	defer c.applyMu.Unlock()
	c.mu.Lock()
	defer c.mu.Unlock()

	entries, err := c.log.entries()
	if err != nil {
		return err
	}

	c.txns = make(map[TxnID]*txnState)
	c.committedOrder = nil
	c.recordOwners = make(map[string]TxnID)

	for _, entry := range entries {
		if err := c.applyJournalEntryLocked(entry); err != nil {
			return err
		}
	}

	for id, txn := range c.txns {
		if txn.state == TxnOpen {
			// Begin is durable, but no prepared payload ever became durable.
			// Such an attempt has no observable effect and may be retried with
			// the same identifier from scratch. Prepared transactions remain
			// in flight so an uncertain Commit can be retried safely.
			delete(c.txns, id)
		}
	}
	return nil
}

func (c *Coordinator) applyJournalEntryLocked(entry journalEntry) error {
	txn := c.txns[entry.txnID]
	switch entry.kind {
	case entryBegin:
		if entry.count != 0 || entry.digest != ([32]byte{}) {
			return fmt.Errorf("%w: invalid begin entry for %q", ErrCorruptLog, entry.txnID)
		}
		if txn == nil {
			c.txns[entry.txnID] = &txnState{
				id:       entry.txnID,
				state:    TxnOpen,
				seen:     make(map[string]struct{}),
				beginSeq: entry.seq,
			}
			return nil
		}
		if txn.state == TxnOpen {
			return nil
		}
		return fmt.Errorf("%w: begin for %q in state %s", ErrCorruptLog, entry.txnID, txn.state)

	case entryPrepare:
		if txn == nil {
			return fmt.Errorf("%w: prepare for unknown transaction %q", ErrCorruptLog, entry.txnID)
		}
		if entry.count != len(entry.records) {
			return fmt.Errorf("%w: prepare count mismatch for %q", ErrCorruptLog, entry.txnID)
		}
		digest := recordsDigest(entry.txnID, entry.records)
		if digest != entry.digest {
			return fmt.Errorf("%w: prepare digest mismatch for %q", ErrCorruptLog, entry.txnID)
		}
		switch txn.state {
		case TxnOpen:
			txn.state = TxnPrepared
			txn.records = cloneRecords(entry.records)
			txn.digest = digest
			txn.prepareSeq = entry.seq
			txn.seen = make(map[string]struct{}, len(entry.records))
			for _, record := range entry.records {
				if record.ID != "" {
					txn.seen[record.ID] = struct{}{}
				}
			}
			return nil
		case TxnPrepared, TxnCommitted:
			if txn.digest != digest || len(txn.records) != entry.count {
				return fmt.Errorf("%w: conflicting prepare for %q", ErrCorruptLog, entry.txnID)
			}
			return nil
		default:
			return fmt.Errorf("%w: prepare for %q in state %s", ErrCorruptLog, entry.txnID, txn.state)
		}

	case entryCommit:
		if txn == nil {
			return fmt.Errorf("%w: commit for unknown transaction %q", ErrCorruptLog, entry.txnID)
		}
		if txn.state == TxnCommitted {
			if txn.digest != entry.digest || len(txn.records) != entry.count {
				return fmt.Errorf("%w: conflicting duplicate commit for %q", ErrCorruptLog, entry.txnID)
			}
			return nil
		}
		if txn.state != TxnPrepared {
			return fmt.Errorf("%w: commit for %q in state %s", ErrCorruptLog, entry.txnID, txn.state)
		}
		if txn.digest != entry.digest || len(txn.records) != entry.count {
			return fmt.Errorf("%w: commit does not match prepare for %q", ErrCorruptLog, entry.txnID)
		}
		txn.state = TxnCommitted
		txn.commitSeq = entry.seq
		if err := c.registerCommittedLocked(txn); err != nil {
			return err
		}
		return nil

	case entryAbort:
		if txn == nil {
			return fmt.Errorf("%w: abort for unknown transaction %q", ErrCorruptLog, entry.txnID)
		}
		if txn.state == TxnCommitted {
			return fmt.Errorf("%w: abort after commit for %q", ErrCorruptLog, entry.txnID)
		}
		if txn.state == TxnAborted {
			return nil
		}
		if txn.state == TxnPrepared && (txn.digest != entry.digest || len(txn.records) != entry.count) {
			return fmt.Errorf("%w: abort does not match prepare for %q", ErrCorruptLog, entry.txnID)
		}
		txn.state = TxnAborted
		txn.abortSeq = entry.seq
		return nil

	case entryAck:
		if txn == nil {
			return fmt.Errorf("%w: ack for unknown transaction %q", ErrCorruptLog, entry.txnID)
		}
		if txn.state != TxnCommitted {
			return fmt.Errorf("%w: ack for %q in state %s", ErrCorruptLog, entry.txnID, txn.state)
		}
		if txn.digest != entry.digest || len(txn.records) != entry.count {
			return fmt.Errorf("%w: ack does not match commit for %q", ErrCorruptLog, entry.txnID)
		}
		txn.applied = true
		return nil

	default:
		return fmt.Errorf("%w: unknown entry kind %d", ErrCorruptLog, entry.kind)
	}
}

func (c *Coordinator) registerCommittedLocked(txn *txnState) error {
	for _, record := range txn.records {
		if record.ID == "" {
			continue
		}
		if owner, ok := c.recordOwners[record.ID]; ok && owner != txn.id {
			return fmt.Errorf("%w: record %q is owned by %q", ErrCorruptLog, record.ID, owner)
		}
	}
	for _, record := range txn.records {
		if record.ID == "" {
			continue
		}
		c.recordOwners[record.ID] = txn.id
	}
	c.committedOrder = append(c.committedOrder, txn)
	return nil
}

// Begin starts a transaction, or returns the existing handle when id is
// already known. A committed or aborted transaction is not reopened; its
// terminal receipt is available through Result and the Retry methods.
func (c *Coordinator) Begin(ctx context.Context, id TxnID) (*Transaction, error) {
	if ctx == nil {
		ctx = context.Background()
	}
	if id == "" {
		return nil, ErrInvalidTxnID
	}
	if err := ctx.Err(); err != nil {
		return nil, err
	}

	c.mu.Lock()
	defer c.mu.Unlock()
	if err := c.checkOpenLocked(); err != nil {
		return nil, err
	}
	if _, ok := c.txns[id]; ok {
		return &Transaction{coordinator: c, id: id}, nil
	}

	seq, err := c.log.append(journalEntry{kind: entryBegin, txnID: id})
	if err != nil {
		return nil, err
	}
	if err := c.checkpointLocked(CrashAfterBeginLog); err != nil {
		return nil, err
	}
	c.txns[id] = &txnState{
		id:       id,
		state:    TxnOpen,
		seen:     make(map[string]struct{}),
		beginSeq: seq,
	}
	return &Transaction{coordinator: c, id: id}, nil
}

// AppendRecords appends records to an open transaction. Records are not
// durable until Prepare writes the complete payload and syncs the log.
func (c *Coordinator) AppendRecords(ctx context.Context, id TxnID, records ...Record) error {
	if ctx == nil {
		ctx = context.Background()
	}
	if err := ctx.Err(); err != nil {
		return err
	}
	if err := validateRecords(records); err != nil {
		return err
	}

	c.mu.Lock()
	defer c.mu.Unlock()
	if err := c.checkOpenLocked(); err != nil {
		return err
	}
	txn, ok := c.txns[id]
	if !ok {
		return ErrTxnNotFound
	}
	if txn.state != TxnOpen {
		return fmt.Errorf("%w: %q is %s", ErrNotOpen, id, txn.state)
	}
	for _, record := range records {
		if record.ID == "" {
			continue
		}
		if _, exists := txn.seen[record.ID]; exists {
			return fmt.Errorf("%w: %q", ErrDuplicateRecord, record.ID)
		}
	}
	for _, record := range records {
		txn.records = append(txn.records, record.Clone())
		if record.ID != "" {
			txn.seen[record.ID] = struct{}{}
		}
	}
	return nil
}

// Prepare makes the complete transaction payload durable without making it
// visible. The commit log's prepare frame is fsynced before this method
// returns.
func (c *Coordinator) Prepare(ctx context.Context, id TxnID) (Receipt, error) {
	if ctx == nil {
		ctx = context.Background()
	}
	if err := ctx.Err(); err != nil {
		return Receipt{}, err
	}

	c.mu.Lock()
	defer c.mu.Unlock()
	if err := c.checkOpenLocked(); err != nil {
		return Receipt{}, err
	}
	txn, ok := c.txns[id]
	if !ok {
		return Receipt{}, ErrTxnNotFound
	}
	switch txn.state {
	case TxnPrepared, TxnCommitted:
		return c.receiptLocked(txn), nil
	case TxnAborted:
		return c.receiptLocked(txn), ErrAborted
	case TxnOpen:
		// Continue below.
	default:
		return Receipt{}, fmt.Errorf("formal: transaction %q is %s", id, txn.state)
	}

	digest := recordsDigest(txn.id, txn.records)
	seq, err := c.log.append(journalEntry{
		kind:    entryPrepare,
		txnID:   txn.id,
		digest:  digest,
		count:   len(txn.records),
		records: cloneRecords(txn.records),
	})
	if err != nil {
		return Receipt{}, err
	}
	receipt := Receipt{
		TxnID:       txn.id,
		State:       TxnPrepared,
		PrepareSeq:  seq,
		RecordCount: len(txn.records),
		Digest:      digest,
	}
	if err := c.checkpointLocked(CrashAfterPrepareLog); err != nil {
		return receipt, err
	}
	txn.state = TxnPrepared
	txn.digest = digest
	txn.prepareSeq = seq
	return receipt, nil
}

// Commit durably records the commit point and then delivers the transaction to
// the sink. A transaction must be prepared first. If the sink fails, the
// decision remains committed and a later Commit or Recover retries only the
// delivery.
func (c *Coordinator) Commit(ctx context.Context, id TxnID) (Receipt, error) {
	if ctx == nil {
		ctx = context.Background()
	}
	if err := ctx.Err(); err != nil {
		return Receipt{}, err
	}

	// Serialize decisions and deliveries. This makes commit order, log order,
	// and sink delivery order identical.
	c.applyMu.Lock()
	defer c.applyMu.Unlock()

	c.mu.Lock()
	if err := c.checkOpenLocked(); err != nil {
		c.mu.Unlock()
		return Receipt{}, err
	}
	txn, ok := c.txns[id]
	if !ok {
		c.mu.Unlock()
		return Receipt{}, ErrTxnNotFound
	}

	switch txn.state {
	case TxnOpen:
		receipt := c.receiptLocked(txn)
		c.mu.Unlock()
		return receipt, ErrNotPrepared
	case TxnAborted:
		receipt := c.receiptLocked(txn)
		c.mu.Unlock()
		return receipt, ErrAborted
	case TxnCommitted:
		receipt := c.receiptLocked(txn)
		applied := txn.applied
		c.mu.Unlock()
		if applied {
			return receipt, nil
		}
		return c.deliverThrough(ctx, txn, receipt)
	case TxnPrepared:
		// Continue below.
	default:
		c.mu.Unlock()
		return Receipt{}, fmt.Errorf("formal: transaction %q is %s", id, txn.state)
	}

	for _, record := range txn.records {
		if record.ID == "" {
			continue
		}
		if owner, exists := c.recordOwners[record.ID]; exists && owner != txn.id {
			receipt := c.receiptLocked(txn)
			c.mu.Unlock()
			return receipt, fmt.Errorf("%w: %q is owned by %q", ErrRecordConflict, record.ID, owner)
		}
	}

	seq, err := c.log.append(journalEntry{
		kind:   entryCommit,
		txnID:  txn.id,
		digest: txn.digest,
		count:  len(txn.records),
	})
	if err != nil {
		c.mu.Unlock()
		return Receipt{}, err
	}
	receipt := Receipt{
		TxnID:       txn.id,
		State:       TxnCommitted,
		PrepareSeq:  txn.prepareSeq,
		CommitSeq:   seq,
		RecordCount: len(txn.records),
		Digest:      txn.digest,
	}

	// The commit frame is durable, but the committed view is intentionally
	// switched only after this checkpoint. A crash here is replayable as a
	// committed transaction, never as a visible in-flight record.
	if err := c.checkpointLocked(CrashAfterCommitLog); err != nil {
		c.mu.Unlock()
		return receipt, err
	}
	txn.state = TxnCommitted
	txn.commitSeq = seq
	if err := c.registerCommittedLocked(txn); err != nil {
		if c.failure == nil {
			c.failure = err
		}
		c.mu.Unlock()
		return receipt, err
	}
	if err := c.checkpointLocked(CrashAfterCommitVisible); err != nil {
		c.mu.Unlock()
		return receipt, err
	}
	c.mu.Unlock()

	return c.deliverThrough(ctx, txn, receipt)
}

// deliverThrough drains committed deliveries up to and including target. A
// failed earlier delivery blocks later ones, preserving commit order at the
// sink even when retries are interleaved with new commits.
func (c *Coordinator) deliverThrough(ctx context.Context, target *txnState, receipt Receipt) (Receipt, error) {
	c.mu.Lock()
	pending := make([]*txnState, 0)
	found := false
	for _, txn := range c.committedOrder {
		if !txn.applied {
			pending = append(pending, txn)
		}
		if txn == target {
			found = true
			break
		}
	}
	c.mu.Unlock()

	if !found {
		c.mu.Lock()
		applied := target.applied
		c.mu.Unlock()
		if applied {
			return receipt, nil
		}
		pending = append(pending, target)
	}
	for _, txn := range pending {
		c.mu.Lock()
		if txn.state != TxnCommitted || txn.applied {
			c.mu.Unlock()
			continue
		}
		deliveryReceipt := c.receiptLocked(txn)
		c.mu.Unlock()
		if _, err := c.deliver(ctx, txn, deliveryReceipt); err != nil {
			if txn == target {
				return receipt, err
			}
			return receipt, fmt.Errorf("formal: delivery for earlier transaction %q is pending: %w", txn.id, err)
		}
	}
	return receipt, nil
}

func (c *Coordinator) deliver(ctx context.Context, txn *txnState, receipt Receipt) (Receipt, error) {
	if err := ctx.Err(); err != nil {
		return receipt, err
	}

	c.mu.Lock()
	if err := c.checkOpenLocked(); err != nil {
		c.mu.Unlock()
		return receipt, err
	}
	if txn.state != TxnCommitted {
		c.mu.Unlock()
		return receipt, fmt.Errorf("formal: transaction %q is %s", txn.id, txn.state)
	}
	if txn.applied {
		c.mu.Unlock()
		return receipt, nil
	}
	delivery := Delivery{
		TxnID:     txn.id,
		CommitSeq: txn.commitSeq,
		Digest:    txn.digest,
		Records:   cloneRecords(txn.records),
	}
	c.mu.Unlock()

	if c.sink != nil {
		if err := c.sink.Apply(ctx, delivery); err != nil {
			return receipt, err
		}
	}

	c.mu.Lock()
	defer c.mu.Unlock()
	if err := c.checkpointLocked(CrashAfterSinkApply); err != nil {
		return receipt, err
	}
	if _, err := c.log.append(journalEntry{
		kind:   entryAck,
		txnID:  txn.id,
		digest: txn.digest,
		count:  len(txn.records),
	}); err != nil {
		return receipt, err
	}
	if err := c.checkpointLocked(CrashAfterAckLog); err != nil {
		return receipt, err
	}
	txn.applied = true
	return receipt, nil
}

// Abort durably rejects an open or prepared transaction. Aborting an already
// aborted transaction returns the original abort receipt. A committed
// transaction cannot be aborted.
func (c *Coordinator) Abort(ctx context.Context, id TxnID) (Receipt, error) {
	if ctx == nil {
		ctx = context.Background()
	}
	if err := ctx.Err(); err != nil {
		return Receipt{}, err
	}

	c.applyMu.Lock()
	defer c.applyMu.Unlock()
	c.mu.Lock()
	defer c.mu.Unlock()
	if err := c.checkOpenLocked(); err != nil {
		return Receipt{}, err
	}
	txn, ok := c.txns[id]
	if !ok {
		return Receipt{}, ErrTxnNotFound
	}
	switch txn.state {
	case TxnAborted:
		return c.receiptLocked(txn), nil
	case TxnCommitted:
		return c.receiptLocked(txn), ErrAlreadyCommitted
	case TxnOpen, TxnPrepared:
		// Continue below.
	default:
		return Receipt{}, fmt.Errorf("formal: transaction %q is %s", id, txn.state)
	}

	prepared := txn.state == TxnPrepared
	digest := [32]byte{}
	count := 0
	if prepared {
		digest = txn.digest
		count = len(txn.records)
	}
	seq, err := c.log.append(journalEntry{
		kind:   entryAbort,
		txnID:  txn.id,
		digest: digest,
		count:  count,
	})
	if err != nil {
		return Receipt{}, err
	}
	receipt := Receipt{
		TxnID:       txn.id,
		State:       TxnAborted,
		PrepareSeq:  txn.prepareSeq,
		AbortSeq:    seq,
		RecordCount: count,
		Digest:      digest,
	}
	if err := c.checkpointLocked(CrashAfterAbortLog); err != nil {
		return receipt, err
	}
	txn.state = TxnAborted
	txn.abortSeq = seq
	if !prepared {
		// Open records never became durable. Drop them so the abort receipt is
		// identical before and after replay.
		txn.records = nil
		txn.digest = [32]byte{}
		txn.seen = make(map[string]struct{})
	}
	return receipt, nil
}

// Recover retries delivery for committed transactions whose acknowledgement
// is not yet durable, in commit order.
func (c *Coordinator) Recover(ctx context.Context) error {
	if ctx == nil {
		ctx = context.Background()
	}
	c.applyMu.Lock()
	defer c.applyMu.Unlock()

	c.mu.Lock()
	if err := c.checkOpenLocked(); err != nil {
		c.mu.Unlock()
		return err
	}
	pending := make([]*txnState, 0)
	for _, txn := range c.committedOrder {
		if !txn.applied {
			pending = append(pending, txn)
		}
	}
	c.mu.Unlock()

	for _, txn := range pending {
		if err := ctx.Err(); err != nil {
			return err
		}
		c.mu.Lock()
		if txn.state != TxnCommitted || txn.applied {
			c.mu.Unlock()
			continue
		}
		receipt := c.receiptLocked(txn)
		c.mu.Unlock()
		if _, err := c.deliver(ctx, txn, receipt); err != nil {
			return fmt.Errorf("formal: delivery for transaction %q is pending: %w", txn.id, err)
		}
	}
	return nil
}

// Result returns the current receipt for a transaction. The receipt for a
// committed transaction is stable across retries and log replay.
func (c *Coordinator) Result(id TxnID) (Receipt, bool) {
	c.mu.Lock()
	defer c.mu.Unlock()
	txn, ok := c.txns[id]
	if !ok {
		return Receipt{}, false
	}
	return c.receiptLocked(txn), true
}

// State returns the current state of a transaction.
func (c *Coordinator) State(id TxnID) (TxnState, bool) {
	c.mu.Lock()
	defer c.mu.Unlock()
	txn, ok := c.txns[id]
	if !ok {
		return TxnAbsent, false
	}
	return txn.state, true
}

// Committed returns committed transactions in commit order. Prepared and open
// transactions never appear here.
func (c *Coordinator) Committed() []TxnView {
	c.mu.Lock()
	defer c.mu.Unlock()
	views := make([]TxnView, 0, len(c.committedOrder))
	for _, txn := range c.committedOrder {
		views = append(views, c.viewLocked(txn))
	}
	return views
}

// InFlight returns open and prepared transactions only. Committed
// transactions are deliberately excluded even if sink acknowledgement is
// still pending.
func (c *Coordinator) InFlight() []TxnView {
	c.mu.Lock()
	defer c.mu.Unlock()
	txns := make([]*txnState, 0)
	for _, txn := range c.txns {
		if txn.state == TxnOpen || txn.state == TxnPrepared {
			txns = append(txns, txn)
		}
	}
	sort.Slice(txns, func(i, j int) bool {
		if txns[i].beginSeq != txns[j].beginSeq {
			return txns[i].beginSeq < txns[j].beginSeq
		}
		return txns[i].id < txns[j].id
	})
	views := make([]TxnView, 0, len(txns))
	for _, txn := range txns {
		views = append(views, c.viewLocked(txn))
	}
	return views
}

// CommittedRecords flattens the committed transaction set in commit order.
// Each record appears exactly once in this view.
func (c *Coordinator) CommittedRecords() []OutputRecord {
	c.mu.Lock()
	defer c.mu.Unlock()
	var records []OutputRecord
	for _, txn := range c.committedOrder {
		for _, record := range txn.records {
			records = append(records, OutputRecord{
				TxnID:     txn.id,
				CommitSeq: txn.commitSeq,
				Record:    record.Clone(),
			})
		}
	}
	return records
}

// PendingAcks returns committed transactions that have not yet durably
// acknowledged sink delivery. They are committed, not in flight.
func (c *Coordinator) PendingAcks() []Receipt {
	c.mu.Lock()
	defer c.mu.Unlock()
	var pending []Receipt
	for _, txn := range c.committedOrder {
		if !txn.applied {
			pending = append(pending, c.receiptLocked(txn))
		}
	}
	return pending
}

// Close flushes and closes the commit log. It waits for an in-progress sink
// delivery to finish.
func (c *Coordinator) Close() error {
	c.applyMu.Lock()
	defer c.applyMu.Unlock()
	c.mu.Lock()
	if c.closed {
		c.mu.Unlock()
		return nil
	}
	c.closed = true
	c.mu.Unlock()
	return c.log.close()
}

func (c *Coordinator) checkOpenLocked() error {
	if c.closed {
		return ErrClosed
	}
	if c.failure != nil {
		return c.failure
	}
	return nil
}

func (c *Coordinator) checkpointLocked(point CrashPoint) error {
	if c.checkpoint == nil {
		return nil
	}
	if err := c.checkpoint(point); err != nil {
		if c.failure == nil {
			c.failure = &CrashError{Point: point, Cause: err}
		}
		return c.failure
	}
	return nil
}

func (c *Coordinator) receiptLocked(txn *txnState) Receipt {
	return Receipt{
		TxnID:       txn.id,
		State:       txn.state,
		PrepareSeq:  txn.prepareSeq,
		CommitSeq:   txn.commitSeq,
		AbortSeq:    txn.abortSeq,
		RecordCount: len(txn.records),
		Digest:      txn.digest,
	}
}

func (c *Coordinator) viewLocked(txn *txnState) TxnView {
	return TxnView{
		TxnID:      txn.id,
		State:      txn.state,
		PrepareSeq: txn.prepareSeq,
		CommitSeq:  txn.commitSeq,
		AbortSeq:   txn.abortSeq,
		Digest:     txn.digest,
		Records:    cloneRecords(txn.records),
		Applied:    txn.applied,
	}
}

// Append adds records to the transaction. It is a convenience wrapper around
// AppendRecords with a background context.
func (t *Transaction) Append(records ...Record) error {
	return t.coordinator.AppendRecords(context.Background(), t.id, records...)
}

// Prepare calls Coordinator.Prepare.
func (t *Transaction) Prepare(ctx context.Context) (Receipt, error) {
	return t.coordinator.Prepare(ctx, t.id)
}

// Commit calls Coordinator.Commit.
func (t *Transaction) Commit(ctx context.Context) (Receipt, error) {
	return t.coordinator.Commit(ctx, t.id)
}

// Abort calls Coordinator.Abort.
func (t *Transaction) Abort(ctx context.Context) (Receipt, error) {
	return t.coordinator.Abort(ctx, t.id)
}

// State returns the transaction's current state.
func (t *Transaction) State() (TxnState, bool) {
	return t.coordinator.State(t.id)
}
