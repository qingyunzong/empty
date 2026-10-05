// Command storecli is a crash-safe page-store CLI with generational
// compaction. External references use stable page IDs; compaction
// relocates live pages into a compact segment and publishes the new
// locations atomically in a single generation commit.
package main

import (
	"flag"
	"fmt"
	"os"

	"storecli/internal/store"
)

func usage() {
	fmt.Fprintf(os.Stderr, `usage: storecli <command> [flags]

commands:
  put      -dir D -id N -data STR     store a page under a stable page ID
  get      -dir D -id N               read a page by stable page ID
  list     -dir D                     list live page IDs
  compact  -dir D                     relocate live pages into a compact segment
  verify   -dir D                     audit per-page checksums and reclamation range
`)
	os.Exit(2)
}

func main() {
	if len(os.Args) < 2 {
		usage()
	}
	cmd := os.Args[1]
	fs := flag.NewFlagSet(cmd, flag.ExitOnError)
	dir := fs.String("dir", "", "store directory (required)")
	id := fs.Uint64("id", 0, "stable page ID")
	data := fs.String("data", "", "page payload")
	fs.Parse(os.Args[2:])
	if *dir == "" {
		fmt.Fprintln(os.Stderr, "error: -dir is required")
		usage()
	}

	var err error
	switch cmd {
	case "put":
		err = withStore(*dir, func(s *store.Store) error {
			return s.Put(*id, []byte(*data))
		})
	case "get":
		err = withStore(*dir, func(s *store.Store) error {
			payload, err := s.Get(*id)
			if err != nil {
				return err
			}
			fmt.Println(string(payload))
			return nil
		})
	case "list":
		err = withStore(*dir, func(s *store.Store) error {
			for _, pid := range s.PageIDs() {
				fmt.Println(pid)
			}
			return nil
		})
	case "compact":
		err = withStore(*dir, func(s *store.Store) error {
			if err := s.Compact(); err != nil {
				return err
			}
			fmt.Printf("compacted: generation=%d pages=%d\n", s.Generation(), len(s.PageIDs()))
			return nil
		})
	case "verify":
		var report *store.VerifyReport
		report, err = store.Verify(*dir)
		if err == nil {
			fmt.Println(report)
			if !report.OK() {
				os.Exit(1)
			}
		}
	default:
		usage()
	}
	if err != nil {
		fmt.Fprintf(os.Stderr, "error: %v\n", err)
		os.Exit(1)
	}
}

func withStore(dir string, fn func(*store.Store) error) error {
	s, err := store.Open(dir)
	if err != nil {
		return err
	}
	defer s.Close()
	return fn(s)
}
