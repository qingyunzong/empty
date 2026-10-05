// Command scompact is a storage-compaction CLI. Pages are addressed by
// stable page IDs; "compact" relocates live pages into a compact segment
// and publishes the move together with the reference update as one
// generation, so a crash leaves either the old or the new references fully
// intact.
//
// Usage:
//
//	scompact -dir <path> put <id> <payload>
//	scompact -dir <path> get <id>
//	scompact -dir <path> delete <id>
//	scompact -dir <path> list
//	scompact -dir <path> compact
//	scompact -dir <path> verify
package main

import (
	"errors"
	"flag"
	"fmt"
	"os"
	"strconv"

	"scompact/store"
)

func main() {
	dir := flag.String("dir", "", "store directory (required)")
	flag.Parse()
	args := flag.Args()
	if *dir == "" || len(args) == 0 {
		flag.Usage()
		os.Exit(2)
	}

	s, err := store.Open(*dir, nil)
	if err != nil {
		fatal(err)
	}
	defer s.Close()

	switch args[0] {
	case "put":
		id, payload := parseID(args, 1), requireArg(args, 2)
		must(s.Put(id, []byte(payload)))
		fmt.Printf("put page %d (%d bytes), generation %d\n", id, len(payload), s.Generation())
	case "get":
		payload, err := s.Get(parseID(args, 1))
		must(err)
		fmt.Println(string(payload))
	case "delete":
		must(s.Delete(parseID(args, 1)))
		fmt.Printf("deleted page %s, generation %d\n", args[1], s.Generation())
	case "list":
		for _, id := range s.List() {
			fmt.Println(id)
		}
	case "compact":
		stats, err := s.Compact()
		must(err)
		fmt.Printf("compacted: %d pages moved, %d bytes reclaimed across %d retired segments, generation %d\n",
			stats.PagesMoved, stats.BytesReclaimed, stats.SegmentsRetired, s.Generation())
	case "verify":
		must(s.Verify())
		fmt.Println("verify: all page checksums and index locations OK")
	default:
		fmt.Fprintf(os.Stderr, "unknown command %q\n", args[0])
		os.Exit(2)
	}
}

func parseID(args []string, i int) uint64 {
	id, err := strconv.ParseUint(requireArg(args, i), 10, 64)
	must(err)
	return id
}

func requireArg(args []string, i int) string {
	if len(args) <= i {
		fmt.Fprintf(os.Stderr, "missing argument %d\n", i)
		os.Exit(2)
	}
	return args[i]
}

func must(err error) {
	if err != nil {
		fatal(err)
	}
}

func fatal(err error) {
	if errors.Is(err, store.ErrNotFound) {
		fmt.Fprintln(os.Stderr, "page not found")
	} else {
		fmt.Fprintln(os.Stderr, "error:", err)
	}
	os.Exit(1)
}
