// trajidx maintains a sidecar line index (<file>.idx) for a log file.
// It never modifies the indexed file.
//
// Usage:
//
//	trajidx build  <file>           full scan, write <file>.idx
//	trajidx update <file>           incremental re-index, report untrusted region
//	trajidx verify <file>           re-hash file and compare with the index
//	trajidx line   <file> <n>       print byte offset/length of 0-based line n
package main

import (
	"fmt"
	"os"
	"strconv"

	"trajidx"
)

const checkpointEvery = 1024

func sidecar(path string) string { return path + ".idx" }

func loadIndex(path string) (*trajidx.Index, error) {
	f, err := os.Open(sidecar(path))
	if err != nil {
		return nil, err
	}
	defer f.Close()
	return trajidx.Load(f)
}

func saveIndex(idx *trajidx.Index) error {
	f, err := os.Create(sidecar(idx.Path))
	if err != nil {
		return err
	}
	defer f.Close()
	return trajidx.Save(idx, f)
}

func run(args []string) error {
	if len(args) < 2 {
		return fmt.Errorf("usage: trajidx <build|update|verify|line> <file> [n]")
	}
	cmd, path := args[0], args[1]
	switch cmd {
	case "build":
		idx, err := trajidx.Build(path, checkpointEvery)
		if err != nil {
			return err
		}
		if err := saveIndex(idx); err != nil {
			return err
		}
		fmt.Printf("indexed %s: %d lines, %d bytes, digest %s\n", path, idx.LineCount, idx.Size, idx.Digest)
	case "update":
		old, err := loadIndex(path)
		if err != nil {
			return err
		}
		idx, region, err := trajidx.Update(path, old)
		if err != nil {
			return err
		}
		if err := saveIndex(idx); err != nil {
			return err
		}
		switch {
		case region != nil:
			fmt.Printf("first untrusted region %s; rebuilt from there: %d lines, %d bytes\n", region, idx.LineCount, idx.Size)
		case idx == old:
			fmt.Println("unchanged")
		default:
			fmt.Printf("appended tail indexed: %d lines, %d bytes\n", idx.LineCount, idx.Size)
		}
	case "verify":
		idx, err := loadIndex(path)
		if err != nil {
			return err
		}
		if err := trajidx.Verify(path, idx); err != nil {
			return err
		}
		fmt.Println("ok")
	case "line":
		if len(args) < 3 {
			return fmt.Errorf("usage: trajidx line <file> <n>")
		}
		n, err := strconv.ParseInt(args[2], 10, 64)
		if err != nil {
			return err
		}
		idx, err := loadIndex(path)
		if err != nil {
			return err
		}
		if n < 0 || n >= idx.LineCount {
			return fmt.Errorf("line %d out of range [0, %d)", n, idx.LineCount)
		}
		e := idx.Lines[n]
		fmt.Printf("line %d: offset=%d length=%d\n", n, e.Offset, e.Length)
	default:
		return fmt.Errorf("unknown command %q", cmd)
	}
	return nil
}

func main() {
	if err := run(os.Args[1:]); err != nil {
		fmt.Fprintln(os.Stderr, "trajidx:", err)
		os.Exit(1)
	}
}
