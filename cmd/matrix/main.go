// Command matrix is a CLI for maintaining sparse integer matrices A and B
// with an incrementally updated product C = A*B, snapshots, diff and undo.
//
// Usage:
//
//	matrix [-file state.json] init <aRows> <aCols> <bCols>
//	matrix [-file state.json] set A|B <row> <col> <value>
//	matrix [-file state.json] get A|B|C <row> <col>
//	matrix [-file state.json] show A|B|C
//	matrix [-file state.json] snapshot <name>
//	matrix [-file state.json] snapshots
//	matrix [-file state.json] diff <from> <to>
//	matrix [-file state.json] undo
//	matrix [-file state.json] verify
package main

import (
	"flag"
	"fmt"
	"os"
	"sort"
	"strconv"

	"sparsemat/matrix"
)

const defaultFile = "matrix-state.json"

// verifyMaxOps caps the dense triple-loop cost for the naive cross-check.
const verifyMaxOps = 1_000_000

func fatalf(format string, args ...any) {
	fmt.Fprintf(os.Stderr, "error: "+format+"\n", args...)
	os.Exit(1)
}

func atoi(s string) int {
	n, err := strconv.Atoi(s)
	if err != nil {
		fatalf("invalid integer %q", s)
	}
	return n
}

func atoi64(s string) int64 {
	n, err := strconv.ParseInt(s, 10, 64)
	if err != nil {
		fatalf("invalid integer %q", s)
	}
	return n
}

func loadOrDie(path string) *matrix.Engine {
	e, err := matrix.Load(path)
	if err != nil {
		fatalf("cannot load state %s: %v (run init first)", path, err)
	}
	return e
}

func pick(e *matrix.Engine, name string) *matrix.Matrix {
	switch name {
	case "A":
		return e.A
	case "B":
		return e.B
	case "C":
		return e.C
	default:
		fatalf("unknown matrix %q (want A, B or C)", name)
	}
	return nil
}

func main() {
	file := flag.String("file", defaultFile, "state file path")
	flag.Parse()
	args := flag.Args()
	if len(args) == 0 {
		fatalf("missing command (init|set|get|show|snapshot|snapshots|diff|undo|verify)")
	}

	switch args[0] {
	case "init":
		if len(args) != 4 {
			fatalf("usage: matrix init <aRows> <aCols> <bCols>")
		}
		e := matrix.NewEngine(atoi(args[1]), atoi(args[2]), atoi(args[3]))
		if err := e.Save(*file); err != nil {
			fatalf("save: %v", err)
		}
		fmt.Printf("initialized A=%dx%d B=%dx%d C=%dx%d in %s\n",
			e.A.Rows, e.A.Cols, e.B.Rows, e.B.Cols, e.C.Rows, e.C.Cols, *file)

	case "set":
		if len(args) != 5 {
			fatalf("usage: matrix set A|B <row> <col> <value>")
		}
		e := loadOrDie(*file)
		which, r, c, v := args[1], atoi(args[2]), atoi(args[3]), atoi64(args[4])
		var err error
		switch which {
		case "A":
			err = e.SetA(r, c, v)
		case "B":
			err = e.SetB(r, c, v)
		default:
			fatalf("set only supports A or B (C is derived)")
		}
		if err != nil {
			fatalf("set: %v", err)
		}
		if err := e.Save(*file); err != nil {
			fatalf("save: %v", err)
		}
		fmt.Printf("%s[%d][%d] = %d (C updated, undo depth %d)\n", which, r, c, v, e.UndoDepth())

	case "get":
		if len(args) != 4 {
			fatalf("usage: matrix get A|B|C <row> <col>")
		}
		e := loadOrDie(*file)
		fmt.Println(pick(e, args[1]).Get(atoi(args[2]), atoi(args[3])))

	case "show":
		if len(args) != 2 {
			fatalf("usage: matrix show A|B|C")
		}
		e := loadOrDie(*file)
		m := pick(e, args[1])
		fmt.Printf("%s %dx%d, %d non-zero entries\n", args[1], m.Rows, m.Cols, m.NNZ())
		keys := make([]matrix.Key, 0, len(m.Data))
		for k := range m.Data {
			keys = append(keys, k)
		}
		sort.Slice(keys, func(i, j int) bool {
			if keys[i].R != keys[j].R {
				return keys[i].R < keys[j].R
			}
			return keys[i].C < keys[j].C
		})
		for _, k := range keys {
			fmt.Printf("  [%d][%d] = %d\n", k.R, k.C, m.Data[k])
		}

	case "snapshot":
		if len(args) != 2 {
			fatalf("usage: matrix snapshot <name>")
		}
		e := loadOrDie(*file)
		e.Snapshot(args[1])
		if err := e.Save(*file); err != nil {
			fatalf("save: %v", err)
		}
		fmt.Printf("snapshot %q saved\n", args[1])

	case "snapshots":
		e := loadOrDie(*file)
		for _, n := range e.Snapshots() {
			fmt.Println(n)
		}

	case "diff":
		if len(args) != 3 {
			fatalf("usage: matrix diff <from> <to>")
		}
		e := loadOrDie(*file)
		changes, err := e.Diff(args[1], args[2])
		if err != nil {
			fatalf("diff: %v", err)
		}
		if len(changes) == 0 {
			fmt.Println("no differences")
			return
		}
		for _, ch := range changes {
			fmt.Printf("%s[%d][%d]: %d -> %d\n", ch.Matrix, ch.R, ch.C, ch.Old, ch.New)
		}

	case "undo":
		e := loadOrDie(*file)
		ok, err := e.Undo()
		if err != nil {
			fatalf("undo: %v", err)
		}
		if !ok {
			fmt.Println("nothing to undo")
			return
		}
		if err := e.Save(*file); err != nil {
			fatalf("save: %v", err)
		}
		fmt.Printf("undone (undo depth %d)\n", e.UndoDepth())

	case "verify":
		e := loadOrDie(*file)
		if err := e.Verify(verifyMaxOps); err != nil {
			fatalf("verify: %v", err)
		}
		fmt.Println("verify OK: incremental C matches naive A*B")

	default:
		fatalf("unknown command %q", args[0])
	}
}
