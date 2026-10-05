// Command logrec reconstructs a log from a checkpoint version and multiple
// overlapping segment files, applying only the contiguous prefix of entries
// after the checkpoint.
//
// Usage:
//
//	logrec -checkpoint N segment1 segment2 ...
//
// Applied entries are printed to stdout as "<seq> <content>". The first
// sequence number missing after the applied prefix (the next expected
// entry) is reported on stderr. Conflicting content and gaps cause a
// non-zero exit.
package main

import (
	"errors"
	"flag"
	"fmt"
	"os"

	"logrec"
)

func main() {
	checkpoint := flag.Uint64("checkpoint", 0, "checkpoint version: apply entries with sequence numbers greater than this")
	flag.Usage = func() {
		fmt.Fprintf(os.Stderr, "usage: %s -checkpoint N segment...\n", os.Args[0])
		flag.PrintDefaults()
	}
	flag.Parse()
	if flag.NArg() == 0 {
		flag.Usage()
		os.Exit(2)
	}

	segs := make([]logrec.Segment, 0, flag.NArg())
	for _, path := range flag.Args() {
		f, err := os.Open(path)
		if err != nil {
			fmt.Fprintf(os.Stderr, "logrec: %v\n", err)
			os.Exit(1)
		}
		seg, err := logrec.ParseSegment(path, f)
		f.Close()
		if err != nil {
			fmt.Fprintf(os.Stderr, "logrec: %v\n", err)
			os.Exit(1)
		}
		segs = append(segs, seg)
	}

	applied, missing, err := logrec.Recover(*checkpoint, segs)
	if err != nil {
		var gap *logrec.GapError
		if errors.As(err, &gap) {
			fmt.Fprintf(os.Stderr, "logrec: rejected: first missing sequence %d, source segments: %v\n",
				gap.Missing, gap.Sources)
		} else {
			fmt.Fprintf(os.Stderr, "logrec: rejected: %v\n", err)
		}
		os.Exit(1)
	}

	for _, e := range applied {
		fmt.Printf("%d %s\n", e.Seq, e.Content)
	}
	fmt.Fprintf(os.Stderr, "logrec: applied %d entries after checkpoint %d; first missing sequence %d\n",
		len(applied), *checkpoint, missing)
}
