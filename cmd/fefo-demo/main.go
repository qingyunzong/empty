// Command fefo-demo replays a sample warehouse event log and prints the
// per-order batch sources plus the daily stock ledger.
package main

import (
	"fmt"
	"os"

	"fefo"
)

func main() {
	log := []fefo.Event{
		&fefo.Receipt{ID: "rc-A", Date: "2026-01-01", Batch: "A", Qty: 100, Expiry: "2026-01-03"},
		&fefo.Receipt{ID: "rc-B", Date: "2026-01-01", Batch: "B", Qty: 100, Expiry: "2026-01-10"},
		&fefo.Order{ID: "O1", Date: "2026-01-01", Qty: 60},
		&fefo.Order{ID: "O2", Date: "2026-01-02", Qty: 80},
		&fefo.Return{ID: "rt-1", Date: "2026-01-02", OrderID: "O1", Qty: 20},
		&fefo.Receipt{ID: "rc-C", Date: "2026-01-04", Batch: "C", Qty: 50, Expiry: "2026-01-05"},
		&fefo.Order{ID: "O3", Date: "2026-01-04", Qty: 30},
		&fefo.Return{ID: "rt-2", Date: "2026-01-06", OrderID: "O2", Qty: 50},
		// Correction: rc-A was mis-keyed; replay with the true quantity.
		&fefo.Amend{ID: "fix-1", Date: "2026-01-03", TargetID: "rc-A",
			Replacement: &fefo.Receipt{ID: "rc-A", Date: "2026-01-01", Batch: "A", Qty: 120, Expiry: "2026-01-03"}},
	}

	s, err := fefo.Replay(log)
	if err != nil {
		fmt.Fprintln(os.Stderr, "replay:", err)
		os.Exit(1)
	}

	fmt.Println("== Per-order batch sources (FEFO) ==")
	for _, id := range []string{"O1", "O2", "O3"} {
		o := s.Orders[id]
		fmt.Printf("order %s: requested %d, shipped %d, shortage %d, returned %d\n",
			id, o.Requested, o.Shipped, o.Shortage, o.Returned)
		for _, a := range o.Allocations {
			fmt.Printf("    batch %s (expiry %s): %d units, %d returned\n", a.Batch, a.Expiry, a.Qty, a.Returned)
		}
	}

	fmt.Println("\n== Daily stock ledger ==")
	fmt.Printf("%-12s %9s %8s %9s %10s %9s %12s %8s\n",
		"date", "received", "shipped", "returned", "restocked", "scrapped", "ret-scrapped", "on-hand")
	for _, d := range s.Ledger {
		fmt.Printf("%-12s %9d %8d %9d %10d %9d %12d %8d\n",
			d.Date, d.Received, d.Shipped, d.Returned, d.Restocked, d.Scrapped, d.ReturnScrapped, d.OnHand)
	}

	fmt.Println("\n== Batch stock ==")
	for _, id := range []string{"A", "B", "C"} {
		b := s.Batches[id]
		fmt.Printf("batch %s (expiry %s): received %d, remaining %d, scrapped %d\n",
			b.ID, b.Expiry, b.Received, b.Remaining, b.Scrapped)
	}

	if err := s.CheckConservation(); err != nil {
		fmt.Fprintln(os.Stderr, "conservation:", err)
		os.Exit(1)
	}
	fmt.Println("\nconservation check: OK")
}
