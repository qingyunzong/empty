// Command logindex builds, incrementally updates, and searches
// line/byte-range indexes of variable-length UTF-8 log files.
//
// Usage:
//
//	logindex build  <logfile> [-index idxfile]
//	logindex update <logfile> [-index idxfile]
//	logindex search <logfile> <pattern> [-index idxfile]
package main

import (
	"errors"
	"flag"
	"fmt"
	"os"

	"logindex/index"
)

func indexPath(logfile, given string) string {
	if given != "" {
		return given
	}
	return logfile + ".lidx"
}

func die(err error) {
	fmt.Fprintln(os.Stderr, "logindex:", err)
	os.Exit(1)
}

func main() {
	if len(os.Args) < 2 {
		die(errors.New("expected subcommand: build | update | search"))
	}
	cmd := os.Args[1]
	fs := flag.NewFlagSet(cmd, flag.ExitOnError)
	idxFlag := fs.String("index", "", "index file path (default <logfile>.lidx)")
	fs.Parse(os.Args[2:])
	args := fs.Args()

	switch cmd {
	case "build", "update":
		if len(args) != 1 {
			die(fmt.Errorf("usage: logindex %s <logfile> [-index idxfile]", cmd))
		}
		logfile := args[0]
		ip := indexPath(logfile, *idxFlag)
		var idx *index.Index
		var err error
		if cmd == "build" {
			idx, err = index.Build(logfile)
		} else {
			var old *index.Index
			old, err = index.Load(ip)
			if err == nil {
				old.Path = logfile
				idx, err = index.Update(old)
			}
		}
		if err != nil {
			die(err)
		}
		if err := index.Save(idx, ip); err != nil {
			die(err)
		}
		fmt.Printf("%s: %d lines, %d bytes, digest %s\n", ip, len(idx.Lines), idx.Size, idx.Digest[:16])

	case "search":
		if len(args) != 2 {
			die(errors.New("usage: logindex search <logfile> <pattern> [-index idxfile]"))
		}
		logfile, pattern := args[0], args[1]
		idx, err := index.Load(indexPath(logfile, *idxFlag))
		if err != nil {
			die(err)
		}
		idx.Path = logfile
		matches, err := index.Search(idx, []byte(pattern))
		if err != nil {
			die(err)
		}
		for _, m := range matches {
			fmt.Printf("%d:%d:%d:%s\n", m.Num, m.Offset, m.Length, m.Text)
		}

	default:
		die(fmt.Errorf("unknown subcommand %q", cmd))
	}
}
