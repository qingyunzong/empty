package logcompact

// Recovered is the result of replaying a log: the committed key/value
// state and the full record chains of transactions still in flight.
type Recovered struct {
	State   map[string]string
	Pending map[uint64][]Record
}

// Recover replays all given records.
func Recover(records []Record) Recovered {
	return RecoverAt(records, ^uint64(0))
}

// RecoverAt replays only records with LSN <= maxLSN, modelling recovery
// (or a snapshot read) at that point of the log.
func RecoverAt(records []Record, maxLSN uint64) Recovered {
	committed := map[uint64]bool{}
	aborted := map[uint64]bool{}
	for _, rec := range records {
		if rec.LSN > maxLSN {
			continue
		}
		switch rec.Type {
		case CommitRecord:
			committed[rec.TxnID] = true
		case AbortRecord:
			aborted[rec.TxnID] = true
		}
	}
	state := map[string]string{}
	pending := map[uint64][]Record{}
	for _, rec := range records {
		if rec.LSN > maxLSN {
			continue
		}
		switch {
		case rec.Type == UpdateRecord && committed[rec.TxnID]:
			state[rec.Key] = rec.Value
		case !committed[rec.TxnID] && !aborted[rec.TxnID]:
			pending[rec.TxnID] = append(pending[rec.TxnID], rec)
		}
	}
	return Recovered{State: state, Pending: pending}
}

// ReadSnapshot returns the committed state visible at the given LSN.
func ReadSnapshot(records []Record, snapshot uint64) map[string]string {
	return RecoverAt(records, snapshot).State
}
