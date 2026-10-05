package main

import (
	"fmt"
	"os"
)

func usage() {
	fmt.Fprintf(os.Stderr, `usage:
  audit check <dir>            verify all hash-chain segments in dir
  audit path  <dir> <digest>   print the full path from a head digest to genesis
`)
	os.Exit(2)
}

func main() {
	if len(os.Args) < 3 {
		usage()
	}
	cmd, dir := os.Args[1], os.Args[2]
	switch cmd {
	case "check":
		rep, err := Check(dir)
		if err != nil {
			fmt.Fprintln(os.Stderr, "error:", err)
			os.Exit(2)
		}
		fmt.Printf("segments: %d  records: %d  heads: %d\n", rep.Segments, rep.Records, len(rep.Heads))
		for _, h := range rep.Heads {
			fmt.Printf("  head %s\n", h)
		}
		for _, d := range rep.BadDigests {
			fmt.Printf("BAD DIGEST %s:%d stored=%s actual=%s\n", d.Segment, d.Line, d.Stored, d.Actual)
		}
		for _, m := range rep.Missing {
			fmt.Printf("MISSING ANCESTOR %s referenced by %v\n", m.Digest, m.ReferencedBy)
		}
		for _, c := range rep.Cycles {
			fmt.Printf("CYCLE %v\n", c.Digests)
		}
		if !rep.OK() {
			os.Exit(1)
		}
		fmt.Println("OK")
	case "path":
		if len(os.Args) < 4 {
			usage()
		}
		res, err := Path(dir, os.Args[3])
		if err != nil {
			fmt.Fprintln(os.Stderr, "error:", err)
			os.Exit(2)
		}
		for i := len(res.Path) - 1; i >= 0; i-- {
			r := res.Path[i]
			fmt.Printf("%s  prev=%s  %q\n", r.Digest, r.Prev, r.Payload)
		}
		if res.Missing != "" {
			fmt.Printf("MISSING ANCESTOR %s\n", res.Missing)
			os.Exit(1)
		}
		if len(res.Cycle) > 0 {
			fmt.Printf("CYCLE %v\n", res.Cycle)
			os.Exit(1)
		}
	default:
		usage()
	}
}
