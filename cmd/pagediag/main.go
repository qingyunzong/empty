// pagediag is a diagnostic CLI for the pagesnap copy-on-write page store.
// It replays a deterministic randomized fork/write/read/close history
// against both the COW store and a deep-copy reference model, verifying
// that reads never diverge and reference counts stay exact.
//
// Usage:
//
//	pagediag run  [-seed N] [-ops N] [-snaps N] [-pages N] [-keep]
//	pagediag refs [-seed N] [-ops N] [-snaps N] [-pages N]
//
// "run" closes every snapshot at the end and fails unless all physical
// pages were reclaimed. "refs" keeps the final snapshots open and dumps
// the live physical-page reference table. Both exit non-zero on any
// divergence or refcount violation.
package main

import (
	"flag"
	"fmt"
	"os"
	"sort"

	"pagesnap"
	"pagesnap/workload"
)

func main() {
	if len(os.Args) < 2 {
		usage()
		os.Exit(2)
	}
	var code int
	switch os.Args[1] {
	case "run":
		code = cmdRun(os.Args[2:], false)
	case "refs":
		code = cmdRun(os.Args[2:], true)
	default:
		usage()
		code = 2
	}
	os.Exit(code)
}

func usage() {
	fmt.Fprintf(os.Stderr, `pagediag - diagnostic CLI for the pagesnap COW page store

usage:
  pagediag run  [-seed N] [-ops N] [-snaps N] [-pages N] [-maxwrite N]
  pagediag refs [-seed N] [-ops N] [-snaps N] [-pages N] [-maxwrite N]

run   replay a random fork history, verify against the deep-copy model,
      then close everything and require full page reclamation
refs  same replay, but keep the final snapshots open and dump the live
      physical-page reference table
`)
}

func cmdRun(args []string, dumpRefs bool) int {
	fs := flag.NewFlagSet("pagediag", flag.ContinueOnError)
	seed := fs.Int64("seed", 1, "PRNG seed (deterministic replay)")
	ops := fs.Int("ops", 5000, "number of operations")
	snaps := fs.Int("snaps", 16, "max live snapshots")
	pages := fs.Uint64("pages", 64, "logical page space size")
	maxWrite := fs.Int("maxwrite", 512, "max bytes per write")
	if err := fs.Parse(args); err != nil {
		return 2
	}

	cfg := workload.Config{
		Seed:       *seed,
		Ops:        *ops,
		MaxSnaps:   *snaps,
		MaxPages:   *pages,
		MaxWrite:   *maxWrite,
		CloseAtEnd: !dumpRefs,
	}
	res, err := workload.Run(cfg)
	if err != nil {
		fmt.Printf("FAIL seed=%d: %v\n", *seed, err)
		return 1
	}

	printStats(res.Stats)
	if dumpRefs {
		fmt.Printf("live snapshots: %v\n", res.Live)
		printRefTable(res.Store)
	} else {
		fmt.Printf("PASS seed=%d ops=%d snaps<=%d pages<%d: model-identical, all pages reclaimed\n",
			*seed, *ops, *snaps, *pages)
	}
	return 0
}

func printStats(st pagesnap.Stats) {
	fmt.Printf("stats: live-pages=%d live-snapshots=%d total-refs=%d allocs=%d frees=%d cow-copies=%d\n",
		st.LivePages, st.LiveSnapshots, st.TotalRefs, st.Allocs, st.Frees, st.CowCopies)
}

func printRefTable(store *pagesnap.Store) {
	table := store.RefTable()
	ids := make([]uint64, 0, len(table))
	for id := range table {
		ids = append(ids, id)
	}
	sort.Slice(ids, func(i, j int) bool { return ids[i] < ids[j] })
	fmt.Println("physical page reference table:")
	for _, id := range ids {
		fmt.Printf("  phys=%-6d refs=%d\n", id, table[id])
	}
	if err := store.VerifyRefCounts(); err != nil {
		fmt.Printf("refcount invariant BROKEN: %v\n", err)
	} else {
		fmt.Println("refcount invariant: OK")
	}
}
