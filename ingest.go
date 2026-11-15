package dataeng

import (
	"context"
	"errors"
	"fmt"
)

// producerEpoch checks/fences the producer epoch and returns the producer
// state. A zero producer id (plain writes) is not fenced.
func (r *Reader) producerEpoch(producerID int64, epoch int16) (*producerState, error) {
	if producerID == 0 {
		return nil, nil
	}
	producer, ok := r.producers[producerID]
	if !ok {
		producer = &producerState{epoch: epoch}
		r.producers[producerID] = producer
		return producer, nil
	}
	if epoch < producer.epoch {
		return nil, fmt.Errorf("%w: producer %d epoch %d below current %d",
			ErrFencedProducer, producerID, epoch, producer.epoch)
	}
	producer.epoch = epoch
	return producer, nil
}

// checkSequence validates the idempotent producer sequence on a partition.
// Replayed batches return the number of leading duplicate records to skip; a
// forward gap is a fatal corruption.
func (r *Reader) checkSequence(state *partitionState, batch *Batch) (int, error) {
	if batch.ProducerID == 0 || len(batch.Records) == 0 {
		return 0, nil
	}
	key := producerKey{producerID: batch.ProducerID, epoch: batch.ProducerEpoch}
	last, seen := state.lastSeq[key]
	first := batch.Records[0].Sequence

	if !seen {
		state.lastSeq[key] = seqState{seq: first + int32(len(batch.Records)) - 1, seen: true}
		return 0, nil
	}

	expected := last.seq + 1
	switch {
	case first == expected:
		state.lastSeq[key] = seqState{seq: first + int32(len(batch.Records)) - 1, seen: true}
		return 0, nil
	case first <= last.seq:
		// Retried batch: count how many leading records are duplicates. A
		// partially overlapping retry still legitimately extends the sequence.
		duplicates := int(last.seq-first) + 1
		if duplicates >= len(batch.Records) {
			return len(batch.Records), nil
		}
		state.lastSeq[key] = seqState{
			seq:  first + int32(len(batch.Records)) - 1,
			seen: true,
		}
		return duplicates, nil
	default:
		return 0, fmt.Errorf("%w: partition %d producer %d expected seq %d got %d",
			ErrOutOfSequence, state.source.Partition(), batch.ProducerID, expected, first)
	}
}

// beginTxn returns the producer's active transaction, starting a new one when
// the previous transaction has already been finalized.
func (r *Reader) beginTxn(producer *producerState, batch *Batch) *txnInfo {
	if producer.active != nil && producer.active.state == txnOngoing {
		return producer.active
	}
	if producer.active != nil {
		producer.finalized = append(producer.finalized, producer.active)
	}
	txn := &txnInfo{
		producerID:    batch.ProducerID,
		producerEpoch: batch.ProducerEpoch,
		state:         txnOngoing,
		partitions:    make(map[int]struct{}),
	}
	producer.active = txn
	return txn
}

// ingestControl applies a COMMIT/ABORT marker to the producer's active
// transaction. The same marker may be replicated to every partition that
// participated, so repeated markers for an already-finalized txn are accepted.
func (r *Reader) ingestControl(state *partitionState, batch *Batch) error {
	producer, err := r.producerEpoch(batch.ProducerID, batch.ProducerEpoch)
	if err != nil {
		return err
	}

	var txn *txnInfo
	if producer.active != nil && producer.active.state == txnOngoing {
		txn = producer.active
	} else {
		// Duplicate marker replicated on another partition, or a marker that
		// reaches this partition before any of the transaction's data: resolve
		// the most recent matching finalized transaction.
		for index := len(producer.finalized) - 1; index >= 0; index-- {
			candidate := producer.finalized[index]
			if candidate.producerEpoch == batch.ProducerEpoch {
				txn = candidate
				break
			}
		}
	}
	if txn == nil {
		// The marker is authoritative even when no transaction data was seen
		// on this partition. Track a finalized placeholder so later records of
		// the same incarnation resolve consistently.
		txn = &txnInfo{
			producerID:    batch.ProducerID,
			producerEpoch: batch.ProducerEpoch,
			partitions:    map[int]struct{}{},
		}
		switch batch.Marker {
		case ControlCommit:
			txn.state = txnCommitted
		case ControlAbort:
			txn.state = txnAborted
		default:
			return fmt.Errorf("%w: unknown control marker %d", ErrCorruptLog, batch.Marker)
		}
		if producer.active != nil {
			producer.finalized = append(producer.finalized, producer.active)
		}
		producer.active = txn
		return nil
	}

	if txn.state == txnOngoing {
		switch batch.Marker {
		case ControlCommit:
			txn.state = txnCommitted
		case ControlAbort:
			txn.state = txnAborted
			r.abortTxn(txn)
		default:
			return fmt.Errorf("%w: unknown control marker %d", ErrCorruptLog, batch.Marker)
		}
	}
	return nil
}

// ingestData validates a data batch and buffers its records.
func (r *Reader) ingestData(state *partitionState, batch *Batch) error {
	duplicates, err := r.checkSequence(state, batch)
	if err != nil {
		return err
	}

	var txn *txnInfo
	if batch.ProducerID != 0 {
		producer, err := r.producerEpoch(batch.ProducerID, batch.ProducerEpoch)
		if err != nil {
			return err
		}
		if hasTransactionalRecords(batch) {
			startedNew := producer.active == nil || producer.active.state != txnOngoing
			txn = r.beginTxn(producer, batch)
			if startedNew {
				// A new transaction resets the producer's per-partition
				// sequence window, so its first batch must not be mistaken for
				// a retry of the previous transaction.
				delete(state.lastSeq, producerKey{
					producerID: batch.ProducerID,
					epoch:      batch.ProducerEpoch,
				})
				duplicates = 0
			}
			txn.partitions[state.source.Partition()] = struct{}{}
		}
	}

	for index, record := range batch.Records {
		// Defensive copy: callers may reuse Batch/Record memory after fetch.
		copied := *record
		copied.Key = append([]byte(nil), record.Key...)
		copied.Value = append([]byte(nil), record.Value...)
		copied.Partition = state.source.Partition()
		copied.Offset = batch.BaseOffset + int64(index)

		entry := &bufferedRecord{record: &copied}
		if copied.Transactional {
			entry.txn = txn
		}
		if index < duplicates {
			entry.skipped = true
			r.stats.DuplicateRecords++
		}
		state.queue = append(state.queue, entry)
	}
	state.nextOffset = batch.BaseOffset + int64(len(batch.Records))
	return nil
}

func hasTransactionalRecords(batch *Batch) bool {
	for _, record := range batch.Records {
		if record.Transactional {
			return true
		}
	}
	return false
}

// abortTxn marks every undelivered record of an aborted transaction as skipped
// so partition heads advance past them without delivery.
func (r *Reader) abortTxn(txn *txnInfo) {
	for partition := range txn.partitions {
		state, ok := r.partitions[partition]
		if !ok {
			continue
		}
		for _, entry := range state.queue {
			if entry.txn == txn && !entry.skipped {
				entry.skipped = true
				r.stats.AbortedRecords++
			}
		}
	}
	txn.partitions = map[int]struct{}{}
}

// drain walks partitions deterministically and releases everything deliverable
// at the head of each queue.
func (r *Reader) drain() []*Record {
	var out []*Record
	for _, partition := range sortedPartitions(r.partitions) {
		state := r.partitions[partition]
		activeTxns := map[*txnInfo]struct{}{}
		for len(state.queue) > 0 {
			head := state.queue[0]
			if head.txn != nil {
				activeTxns[head.txn] = struct{}{}
			}

			// Aborted/poisoned or duplicate records are consumed silently. The
			// abort/poison paths mark them and update counters up front.
			if head.skipped || (head.txn != nil &&
				(head.txn.state == txnAborted || head.txn.state == txnPoisoned)) {
				state.deliveredOffset = head.record.Offset
				state.queue = state.queue[1:]
				continue
			}

			// Transactional records wait for a commit marker.
			if head.txn != nil && head.txn.state != txnCommitted {
				break
			}

			// Read-committed LSO withholding: do not pass records at or beyond
			// the last stable offset while their stability is unadvertised.
			if state.lso > 0 && head.record.Offset >= state.lso {
				break
			}

			out = append(out, head.record)
			r.stats.Delivered++
			state.deliveredOffset = head.record.Offset
			state.queue = state.queue[1:]
		}
		r.gcFinalized(activeTxns)
	}
	return out
}

// gcFinalized drops finalized transactions that no longer back any buffered
// record, so long-lived producers cannot accumulate transaction history
// forever.
func (r *Reader) gcFinalized(active map[*txnInfo]struct{}) {
	for _, producer := range r.producers {
		if len(producer.finalized) == 0 {
			continue
		}
		kept := producer.finalized[:0]
		for _, txn := range producer.finalized {
			if _, referenced := active[txn]; referenced {
				kept = append(kept, txn)
			}
		}
		producer.finalized = kept
	}
}

// handleTruncation seeks the partition to the earliest retained offset and
// invalidates every ongoing transaction whose buffered records were lost.
func (r *Reader) handleTruncation(ctx context.Context, state *partitionState, reportedEarliest int64) error {
	r.stats.Truncations++

	earliest := reportedEarliest
	listEarliest, _, err := state.source.ListOffsets(ctx)
	if err != nil {
		return fmt.Errorf("dataeng: list offsets after truncation: %w", err)
	}
	if listEarliest > earliest {
		earliest = listEarliest
	}

	// The new leader log is authoritative: every record still buffered for
	// this partition is stale. Poison the owning ongoing transactions so their
	// records on other partitions are discarded too (a transaction is
	// all-or-nothing), then drop the whole local queue and rebuild from the
	// new log.
	poisoned := map[*txnInfo]struct{}{}
	for _, entry := range state.queue {
		if entry.txn != nil && entry.txn.state == txnOngoing && !entry.skipped {
			poisoned[entry.txn] = struct{}{}
		}
	}
	state.queue = nil

	for txn := range poisoned {
		txn.state = txnPoisoned
		r.stats.PoisonedTxns++
		r.poisonTxn(txn)
		txn.partitions = map[int]struct{}{}
	}

	state.nextOffset = earliest
	state.leaderEpoch = -1
	state.lastSeq = make(map[producerKey]seqState)
	if state.deliveredOffset < earliest-1 {
		state.deliveredOffset = earliest - 1
	}

	// Re-fetch from the new log within this round so callers keep making
	// progress; an empty (or still-unavailable) log is simply deferred to the
	// next poll without raising another truncation event.
	resp, err := state.source.Fetch(ctx, state.nextOffset)
	if err != nil {
		var outOfRange *OffsetOutOfRangeError
		if errors.As(err, &outOfRange) {
			state.awaitingData = true
			return nil
		}
		return err
	}
	if resp != nil {
		state.lso = resp.LastStableOffset
		for _, batch := range resp.Batches {
			if err := r.ingest(ctx, state, batch); err != nil {
				return err
			}
		}
		if len(resp.Batches) > 0 {
			state.awaitingData = false
		} else {
			state.awaitingData = true
		}
	}
	return nil
}

// poisonTxn marks every remaining record of a poisoned transaction across all
// partitions and counts the suppressed records.
func (r *Reader) poisonTxn(txn *txnInfo) {
	for partition := range txn.partitions {
		state, ok := r.partitions[partition]
		if !ok {
			continue
		}
		for _, entry := range state.queue {
			if entry.txn == txn && !entry.skipped {
				entry.skipped = true
				r.stats.AbortedRecords++
			}
		}
	}
}
