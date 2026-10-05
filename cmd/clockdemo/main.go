// Command clockdemo commits a write on one node and shows the wait
// evidence produced while a second node's clock ticks until the write
// becomes visible, plus the overlapping-interval verification.
package main

import (
	"fmt"

	"clocksim"
)

func main() {
	store := clocksim.NewStore()

	writer := clocksim.NewClock("writer", clocksim.Interval{Earliest: 10, Latest: 14}, 2)
	w, err := store.Commit("k", "v", writer.Now())
	if err != nil {
		panic(err)
	}
	fmt.Printf("committed %+v commitUpper=%d\n", w, w.CommitUpper())

	reader := clocksim.NewClock("reader", clocksim.Interval{Earliest: 9, Latest: 15}, 2)
	res, ev := store.WaitVisible(reader, "k", 10)
	fmt.Println("wait evidence:")
	fmt.Println(ev)
	fmt.Printf("read outcome=%s value=%q\n", res.Outcome, res.Write.Value)

	ivs := clocksim.SweepIntervals(8, 20, 3, 1)
	overlap := clocksim.OverlappingCommit(w, ivs)
	fmt.Printf("intervals overlapping commit window %s: %d\n", w.Commit, len(overlap))
	if violations := clocksim.VerifyNoEarlyRead(store, w, ivs); violations == nil {
		fmt.Println("verification: no early reads, no withheld due reads")
	} else {
		for _, v := range violations {
			fmt.Println("violation:", v)
		}
	}
}
