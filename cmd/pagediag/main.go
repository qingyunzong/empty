// pagediag runs a randomized fork/write/delete history against the cowpage
// store while mirroring it with a deep-copy model, and reports any
// divergence or reference-count leak.
package main

import (
	"flag"
	"fmt"
	"log"
	"os"

	"pagestore/diag"
)

func main() {
	var cfg diag.Config
	flag.Int64Var(&cfg.Seed, "seed", 1, "random seed for the generated history")
	flag.IntVar(&cfg.Ops, "ops", 5000, "number of random operations")
	flag.IntVar(&cfg.NumPages, "pages", 32, "logical pages per branch")
	flag.IntVar(&cfg.PageSize, "page-size", 64, "bytes per page")
	flag.IntVar(&cfg.MaxBranches, "max-branches", 16, "cap on simultaneously live branches")
	flag.BoolVar(&cfg.Verbose, "v", false, "log every operation")
	flag.Parse()
	cfg.Logf = log.Printf

	st, err := diag.Run(cfg)
	if err != nil {
		fmt.Fprintf(os.Stderr, "FAIL: %v\n", err)
		os.Exit(1)
	}
	fmt.Printf("OK seed=%d ops=%d forks=%d writes=%d reads=%d deletes=%d full-checks=%d peak-branches=%d peak-live-pages=%d\n",
		cfg.Seed, st.Ops, st.Forks, st.Writes, st.Reads, st.Deletes, st.FullChecks, st.PeakBranches, st.PeakLivePages)
	fmt.Println("all views match deep-copy model; all page references returned; no leaks")
}
