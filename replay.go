package formal

import "fmt"

// Replay reconstructs a ledger from a durable event log.
//
// Reconcile events are part of the log, so all attempt numbers and effects are
// reproduced exactly. Replay fails at the first event that the original ledger
// would have rejected; it returns a ledger containing the successfully
// replayed prefix in that case.
func Replay(events []Event) (*Ledger, error) {
	ledger := NewLedger()
	for i, ev := range events {
		if _, err := ledger.Apply(ev); err != nil {
			return ledger, fmt.Errorf("replay event %d (%s): %w", i, ev.Kind, err)
		}
	}
	return ledger, nil
}
