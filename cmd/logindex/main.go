// Command logindex builds, incrementally updates, and searches a
// line/byte-range index over variable-length UTF-8 log files.
//
// Usage:
//
//	logindex [-i indexfile] build  <log>
//	logindex [-i indexfile] update <log>
//	logindex [-i indexfile] search <log> <query>
//	logindex [-i indexfile] stats  <log>
//
// The index file defaults to <log>.idx. update refuses to reuse an index
// whose original segment was modified or truncated; search verifies the
// source digest before citing any position.
package main

import (
	"errors"
	"flag"
	"fmt"
	"os"

	"logindex"
)

func usage() {
	fmt.Fprintf(os.Stderr, `usage:
  logindex [-i indexfile] build  <log>
  logindex [-i indexfile] update <log>
  logindex [-i indexfile] search <log> <query>
  logindex [-i indexfile] stats  <log>
`)
	os.Exit(1)
}

func main() {
	fs := flag.NewFlagSet("logindex", flag.ExitOnError)
	idxPath := fs.String("i", "", "index file path (default <log>.idx)")
	fs.Parse(os.Args[1:])
	args := fs.Args()
	if len(args) < 2 {
		usage()
	}
	cmd, logPath := args[0], args[1]
	ip := *idxPath
	if ip == "" {
		ip = logPath + ".idx"
	}

	switch cmd {
	case "build":
		idx, err := logindex.Build(logPath)
		must(err)
		must(logindex.Save(idx, ip))
		fmt.Printf("built %s: %d lines, %d indexed bytes\n", ip, len(idx.Lines), idx.IndexedLen)

	case "update":
		idx, err := logindex.Load(ip)
		if errors.Is(err, os.ErrNotExist) {
			idx, err = logindex.Build(logPath)
			must(err)
			must(logindex.Save(idx, ip))
			fmt.Printf("no index found; built %s: %d lines, %d indexed bytes\n",
				ip, len(idx.Lines), idx.IndexedLen)
			return
		}
		must(err)
		grown, err := logindex.Update(logPath, idx)
		if err != nil {
			reject(err)
		}
		must(logindex.Save(idx, ip))
		if grown {
			fmt.Printf("updated %s: %d lines, %d indexed bytes\n", ip, len(idx.Lines), idx.IndexedLen)
		} else {
			fmt.Printf("up to date: %d lines, %d indexed bytes\n", len(idx.Lines), idx.IndexedLen)
		}

	case "search":
		if len(args) < 3 {
			usage()
		}
		idx, err := logindex.Load(ip)
		must(err)
		f, err := os.Open(logPath)
		must(err)
		defer f.Close()
		hits, err := logindex.Search(f, idx, []byte(args[2]))
		if err != nil {
			reject(err)
		}
		for _, h := range hits {
			fmt.Printf("%d:%d+%d: %s\n", h.Line, h.Offset, h.Length, h.Text)
		}
		fmt.Printf("%d hit(s)\n", len(hits))

	case "stats":
		idx, err := logindex.Load(ip)
		must(err)
		fmt.Printf("lines: %d\nindexed bytes: %x bytes\nprefix sha256: %x\n",
			len(idx.Lines), idx.IndexedLen, idx.Digest)

	default:
		usage()
	}
}

func must(err error) {
	if err != nil {
		fmt.Fprintln(os.Stderr, "logindex:", err)
		os.Exit(1)
	}
}

// reject exits with code 2 when the index was rejected as stale.
func reject(err error) {
	if errors.Is(err, logindex.ErrSourceChanged) {
		fmt.Fprintln(os.Stderr, "logindex:", err)
		os.Exit(2)
	}
	must(err)
}
