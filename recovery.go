package dataeng

import (
	"context"
	"fmt"
)

type txnState struct {
	id        string
	begin     Event
	hasBegin  bool
	sink      Event
	hasSink   bool
	offset    Event
	hasOffset bool
}

// recoverPartition completes journaled transactions that were interrupted
// before the offset reached Kafka. It walks contiguous batches starting at
// start, resubmits any batch whose sink receipt was not recorded, commits its
// next offset, and returns the first offset that still needs to be read.
func (c *Coordinator) recoverPartition(ctx context.Context, p *partitionState, lease Lease, start Offset) (Offset, error) {
	events, err := c.cfg.Journal.Replay(ctx)
	if err != nil {
		return start, fmt.Errorf("replay journal: %w", err)
	}

	txns := make(map[string]*txnState)
	byStart := make(map[Offset]*txnState)
	for _, event := range events {
		if event.Partition != p.id || event.BatchID == "" {
			continue
		}
		t := txns[event.BatchID]
		if t == nil {
			t = &txnState{id: event.BatchID}
			txns[event.BatchID] = t
		}
		switch event.Kind {
		case EventBegin:
			if !t.hasBegin {
				t.begin = event
				t.hasBegin = true
			}
		case EventSinkCommitted:
			if !t.hasSink {
				t.sink = event
				t.hasSink = true
			}
		case EventOffsetCommitted:
			if !t.hasOffset {
				t.offset = event
				t.hasOffset = true
			}
		}
	}

	for _, t := range txns {
		if !t.hasBegin && !t.hasSink {
			continue
		}
		// A batch from an older lease may still be waiting for its sink
		// callback in this process. Recovery must not submit it a second time;
		// the original callback will be fenced when it arrives.
		p.mu.Lock()
		_, inFlight := p.inflightBatches[t.id]
		p.mu.Unlock()
		if inFlight {
			continue
		}
		first := t.begin.First
		next := t.begin.Next
		if !t.hasBegin {
			first = t.sink.First
			next = t.sink.Next
		}
		if next <= first {
			continue
		}
		// If two runs produced different batch boundaries for the same start,
		// prefer the one that already reached the sink. Otherwise prefer the
		// largest range, which makes the most progress without a gap.
		if existing := byStart[first]; existing != nil {
			if existing.hasSink && !t.hasSink {
				continue
			}
			if existing.hasSink == t.hasSink && txnNext(t) <= txnNext(existing) {
				continue
			}
		}
		byStart[first] = t
	}

	for {
		if !p.current(lease) {
			return start, ErrStaleLease
		}
		t := byStart[start]
		if t == nil {
			return start, nil
		}
		first, next := txnRange(t)
		if next <= start {
			return start, fmt.Errorf("journal batch %q does not advance past %d", t.id, start)
		}
		batch := Batch{
			ID:          t.id,
			Partition:   p.id,
			FirstOffset: first,
			NextOffset:  next,
		}
		if t.hasBegin {
			batch.Records = t.begin.Output
		}

		if !t.hasSink {
			if !t.hasBegin {
				return start, fmt.Errorf("batch %q has no begin record and no sink receipt", t.id)
			}
			receipt, err := c.submitSync(ctx, batch)
			if err != nil {
				return start, fmt.Errorf("resubmit batch %s: %w", t.id, err)
			}
			event := Event{
				Kind:       EventSinkCommitted,
				BatchID:    t.id,
				Partition:  p.id,
				Generation: lease.Generation,
				Epoch:      lease.Epoch,
				First:      first,
				Next:       next,
				Receipt:    receipt,
			}
			if err := c.cfg.Journal.Append(ctx, event); err != nil {
				return start, fmt.Errorf("journal recovered sink commit for %s: %w", t.id, err)
			}
			t.sink = event
			t.hasSink = true
			if !p.current(lease) {
				return start, ErrStaleLease
			}
		}

		if !t.hasOffset {
			if !p.current(lease) {
				return start, ErrStaleLease
			}
			if err := c.cfg.Committer.CommitOffset(ctx, p.id, next); err != nil {
				return start, fmt.Errorf("recommit offset for %s: %w", t.id, err)
			}
			event := Event{
				Kind:       EventOffsetCommitted,
				BatchID:    t.id,
				Partition:  p.id,
				Generation: lease.Generation,
				Epoch:      lease.Epoch,
				First:      first,
				Next:       next,
			}
			if err := c.cfg.Journal.Append(ctx, event); err != nil {
				return start, fmt.Errorf("journal recovered offset commit for %s: %w", t.id, err)
			}
			t.offset = event
			t.hasOffset = true
		}
		start = next
	}
}

func txnRange(t *txnState) (Offset, Offset) {
	if t.hasBegin {
		return t.begin.First, t.begin.Next
	}
	return t.sink.First, t.sink.Next
}

func txnNext(t *txnState) Offset {
	_, next := txnRange(t)
	return next
}

func (c *Coordinator) submitSync(ctx context.Context, batch Batch) (Receipt, error) {
	commitCtx, cancel := context.WithTimeout(ctx, c.cfg.CommitTimeout)
	defer cancel()
	outcome := make(chan commitOutcome, 1)
	if err := c.cfg.Sink.Submit(commitCtx, batch, func(receipt Receipt, err error) {
		outcome <- commitOutcome{receipt: receipt, err: err}
	}); err != nil {
		return Receipt{}, err
	}
	select {
	case result := <-outcome:
		return result.receipt, result.err
	case <-commitCtx.Done():
		return Receipt{}, commitCtx.Err()
	}
}
