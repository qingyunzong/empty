package inventory

import (
	"fmt"
	"math/rand"
	"testing"
)

// TestLedgerMatchesUnitModel drives the aggregate Ledger and the per-unit
// UnitModel through identical random operation sequences and verifies that
// the books agree after every single step.
func TestLedgerMatchesUnitModel(t *testing.T) {
	for seed := int64(0); seed < 60; seed++ {
		t.Run(fmt.Sprintf("seed=%d", seed), func(t *testing.T) {
			rng := rand.New(rand.NewSource(seed))
			ledger := NewLedger(t0)
			model := NewUnitModel(t0)
			now := t0

			var batchIDs []string
			expiryOf := make(map[string]int) // batch ID -> expiry day offset

			for step := 0; step < 300; step++ {
				switch rng.Intn(6) {
				case 0: // receive a new batch
					id := fmt.Sprintf("batch-%d", len(batchIDs))
					exp := rng.Intn(8) + 1 // expires in 1..8 days
					qty := rng.Intn(6) + 1
					if err := ledger.Receive(id, qty, day(exp)); err != nil {
						t.Fatalf("step %d receive: %v", step, err)
					}
					model.Receive(id, qty, day(exp))
					batchIDs = append(batchIDs, id)
					expiryOf[id] = exp

				case 1: // freeze / unfreeze a random batch
					if len(batchIDs) == 0 {
						continue
					}
					id := batchIDs[rng.Intn(len(batchIDs))]
					if rng.Intn(2) == 0 {
						must(t, ledger.Freeze(id))
						model.Freeze(id)
					} else {
						must(t, ledger.Unfreeze(id))
						model.Unfreeze(id)
					}

				case 2: // advance time
					now = now.AddDate(0, 0, rng.Intn(3))
					must(t, ledger.AdvanceTo(now))
					model.AdvanceTo(now)

				case 3: // outbound order of 1..3 lines
					lines := make([]int, rng.Intn(3)+1)
					for i := range lines {
						lines[i] = rng.Intn(5) + 1
					}
					err := ledger.Outbound(lines...)
					ok := model.Outbound(lines...)
					if (err == nil) != ok {
						t.Fatalf("step %d: ledger err=%v but model ok=%v", step, err, ok)
					}

				case 4: // refund to a random existing batch
					if len(batchIDs) == 0 {
						continue
					}
					id := batchIDs[rng.Intn(len(batchIDs))]
					qty := rng.Intn(3) + 1
					must(t, ledger.Refund(id, qty))
					model.Refund(id, qty)

				case 5: // top up an existing batch (same expiry)
					if len(batchIDs) == 0 {
						continue
					}
					id := batchIDs[rng.Intn(len(batchIDs))]
					qty := rng.Intn(4) + 1
					must(t, ledger.Receive(id, qty, day(expiryOf[id])))
					model.Receive(id, qty, day(expiryOf[id]))
				}

				assertBooksMatch(t, ledger, model, step)
			}
		})
	}
}

func assertBooksMatch(t *testing.T, l *Ledger, m *UnitModel, step int) {
	t.Helper()

	// Per-batch on-hand quantities must agree exactly.
	unitOnHand := m.OnHandByBatch()
	for _, b := range l.Batches() {
		if unitOnHand[b.ID] != b.OnHand {
			t.Fatalf("step %d: batch %s ledger on-hand %d, unit model %d",
				step, b.ID, b.OnHand, unitOnHand[b.ID])
		}
		delete(unitOnHand, b.ID)
	}
	for id, n := range unitOnHand {
		t.Fatalf("step %d: unit model has %d on-hand in unknown batch %s", step, n, id)
	}

	// Ledger-wide counters must agree with per-unit states.
	tot := l.Totals()
	if got := m.CountByState(UnitConsumed); got != tot.Consumed {
		t.Fatalf("step %d: consumed ledger=%d model=%d", step, tot.Consumed, got)
	}
	if got := m.CountByState(UnitScrapped); got != tot.Scrapped {
		t.Fatalf("step %d: scrapped ledger=%d model=%d", step, tot.Scrapped, got)
	}
	if got := m.CountByState(UnitOnHand); got != tot.OnHand {
		t.Fatalf("step %d: on-hand ledger=%d model=%d", step, tot.OnHand, got)
	}

	// Account identity: everything received or refunded is either
	// on hand, consumed, or scrapped.
	if tot.Received+tot.Refunded != tot.OnHand+tot.Consumed+tot.Scrapped {
		t.Fatalf("step %d: account identity broken: %+v", step, tot)
	}
}
