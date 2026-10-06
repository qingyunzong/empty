package occupancy

import "sort"

// BatchMove maps train IDs to their whole new reservation sets.
type BatchMove map[string][]Reservation

func sortedBatchIDs(batch BatchMove) []string {
	ids := make([]string, 0, len(batch))
	for id := range batch {
		ids = append(ids, id)
	}
	sort.Strings(ids)
	return ids
}

func cloneBatch(b BatchMove) BatchMove {
	out := make(BatchMove, len(b))
	for id, res := range b {
		out[id] = clone(res)
	}
	return out
}

// checkBatch validates the whole batch: every train must exist, every new
// reservation set must be valid, and the new sets must conflict neither
// with trains outside the batch nor with each other. The batch's own old
// reservations are excluded from the check.
func (p *Planner) checkBatch(batch BatchMove) bool {
	if len(batch) == 0 {
		return false
	}
	for id, res := range batch {
		if !p.Has(id) {
			return false
		}
		if err := validateReservations(res); err != nil {
			return false
		}
	}
	for _, res := range batch {
		for otherID, other := range p.trains {
			if _, inBatch := batch[otherID]; inBatch {
				continue
			}
			for _, a := range res {
				for _, b := range other {
					if a.Overlaps(b) {
						return false
					}
				}
			}
		}
	}
	ids := sortedBatchIDs(batch)
	for i := 0; i < len(ids); i++ {
		for j := i + 1; j < len(ids); j++ {
			for _, a := range batch[ids[i]] {
				for _, b := range batch[ids[j]] {
					if a.Overlaps(b) {
						return false
					}
				}
			}
		}
	}
	return true
}

// AtomicSwap replaces the reservations of every train in the batch as one
// atomic unit: all old reservations of the batch are conceptually removed
// first, then all new reservations are checked together. If any new
// reservation is invalid or conflicts, nothing changes.
func (p *Planner) AtomicSwap(batch BatchMove) bool {
	if !p.checkBatch(batch) {
		return false
	}
	for _, id := range sortedBatchIDs(batch) {
		p.trains[id] = clone(batch[id])
	}
	return true
}

// RecordKind identifies write-ahead log records.
type RecordKind int

const (
	// RecBegin starts a batch and persists the full old and new layouts.
	RecBegin RecordKind = iota
	// RecIntent marks the durable intent to apply the new layout.
	RecIntent
	// RecApplied marks one train's new layout as applied.
	RecApplied
	// RecCommit marks the batch as fully applied.
	RecCommit
	// RecRecovered marks that recovery finished for the batch.
	RecRecovered
)

// LogRecord is one durable write-ahead log entry.
type LogRecord struct {
	Kind    RecordKind
	TrainID string
	Old     BatchMove
	New     BatchMove
}

// TxLog is a durable (caller-persisted) write-ahead log.
type TxLog struct {
	records []LogRecord
}

// Append durably appends a record.
func (l *TxLog) Append(rec LogRecord) {
	l.records = append(l.records, rec)
}

// Records returns a copy of all records.
func (l *TxLog) Records() []LogRecord {
	return append([]LogRecord(nil), l.records...)
}

// HasCommit reports whether a commit record has been logged.
func (l *TxLog) HasCommit() bool {
	for _, r := range l.records {
		if r.Kind == RecCommit {
			return true
		}
	}
	return false
}

// CommitBatch applies a batch atomically with a persistent intent log, so a
// crash midway can be repaired by Recover. It returns false when the batch
// is invalid or conflicts; in that case nothing is logged and every old
// layout is kept.
func (p *Planner) CommitBatch(batch BatchMove, log *TxLog) bool {
	return p.commitBatch(batch, log, -1)
}

// commitBatch is CommitBatch with a crash injector: crashAfter >= 0 simulates
// a crash just before the step with that index (0 = before anything happens).
func (p *Planner) commitBatch(batch BatchMove, log *TxLog, crashAfter int) bool {
	if !p.checkBatch(batch) {
		return false
	}
	old := make(BatchMove, len(batch))
	for _, id := range sortedBatchIDs(batch) {
		old[id] = clone(p.trains[id])
	}
	step := 0
	alive := func() bool {
		if crashAfter >= 0 && step == crashAfter {
			return false
		}
		step++
		return true
	}
	if !alive() {
		return false
	}
	log.Append(LogRecord{Kind: RecBegin, Old: cloneBatch(old), New: cloneBatch(batch)})
	if !alive() {
		return false
	}
	log.Append(LogRecord{Kind: RecIntent})
	for _, id := range sortedBatchIDs(batch) {
		if !alive() {
			return false
		}
		p.trains[id] = clone(batch[id])
		log.Append(LogRecord{Kind: RecApplied, TrainID: id})
	}
	if !alive() {
		return false
	}
	log.Append(LogRecord{Kind: RecCommit})
	return true
}

// Recover brings the planner back to a consistent state after a crash during
// CommitBatch. A committed batch is rolled forward to its whole new layout;
// an uncommitted batch is rolled back to its whole old layout. Recovery
// never leaves a single-train rescheduling behind.
func (p *Planner) Recover(log *TxLog) {
	var pending *LogRecord
	committed := false
	for i := range log.records {
		switch log.records[i].Kind {
		case RecBegin:
			pending = &log.records[i]
			committed = false
		case RecCommit:
			committed = true
		}
	}
	if pending == nil {
		return
	}
	layout := pending.Old
	if committed {
		layout = pending.New
	}
	for id, res := range layout {
		p.trains[id] = clone(res)
	}
	log.Append(LogRecord{Kind: RecRecovered})
}
