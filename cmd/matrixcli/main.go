// Command matrixcli is an interactive CLI maintaining sparse integer
// matrices A and B and their incrementally updated product C = A*B.
//
// Commands (one per line, tokens separated by whitespace):
//
//	dims <aRows> <aCols> <bCols>   (re)create matrices; A is aRows x aCols,
//	                               B is aCols x bCols, C is aRows x bCols
//	setA <r> <c> <v>               correct one element of A (v=0 deletes it)
//	setB <r> <c> <v>               correct one element of B (v=0 deletes it)
//	undo                           revert the most recent correction
//	snap                           store an immutable version snapshot
//	diff <id1> <id2>               diff two snapshots (use id2=0 for current)
//	show A|B|C                     print non-zero entries
//	check                          verify C against the naive triple loop
//	help                           show this summary
//	quit                           exit
package main

import (
	"bufio"
	"fmt"
	"io"
	"os"
	"strconv"

	"matrixlib"
)

func main() {
	if err := run(os.Stdin, os.Stdout); err != nil {
		fmt.Fprintln(os.Stderr, "error:", err)
		os.Exit(1)
	}
}

func run(in io.Reader, out io.Writer) error {
	var eng *matrixlib.Engine
	sc := bufio.NewScanner(in)
	sc.Buffer(make([]byte, 64*1024), 1024*1024)
	fmt.Fprintln(out, "matrixcli: type 'help' for commands")
	for sc.Scan() {
		line := sc.Text()
		toks := fields(line)
		if len(toks) == 0 {
			continue
		}
		switch toks[0] {
		case "quit", "exit":
			return sc.Err()
		case "help":
			printHelp(out)
		case "dims":
			if len(toks) != 4 {
				fmt.Fprintln(out, "usage: dims <aRows> <aCols> <bCols>")
				continue
			}
			ar, err1 := strconv.Atoi(toks[1])
			ac, err2 := strconv.Atoi(toks[2])
			bc, err3 := strconv.Atoi(toks[3])
			if err1 != nil || err2 != nil || err3 != nil || ar < 0 || ac < 0 || bc < 0 {
				fmt.Fprintln(out, "dims: need three non-negative integers")
				continue
			}
			eng = matrixlib.NewEngine(ar, ac, bc)
			fmt.Fprintf(out, "ok: A is %dx%d, B is %dx%d, C is %dx%d\n", ar, ac, ac, bc, ar, bc)
		case "setA", "setB":
			if eng == nil {
				fmt.Fprintln(out, "run 'dims' first")
				continue
			}
			if len(toks) != 4 {
				fmt.Fprintf(out, "usage: %s <row> <col> <value>\n", toks[0])
				continue
			}
			r, err1 := strconv.Atoi(toks[1])
			c, err2 := strconv.Atoi(toks[2])
			v, err3 := strconv.ParseInt(toks[3], 10, 64)
			if err1 != nil || err2 != nil || err3 != nil {
				fmt.Fprintln(out, "set: need int row, col and int64 value")
				continue
			}
			var err error
			if toks[0] == "setA" {
				err = eng.SetA(r, c, v)
			} else {
				err = eng.SetB(r, c, v)
			}
			if err != nil {
				fmt.Fprintln(out, "rejected:", err)
				continue
			}
			fmt.Fprintln(out, "ok")
		case "undo":
			if eng == nil {
				fmt.Fprintln(out, "run 'dims' first")
				continue
			}
			if eng.Undo() {
				fmt.Fprintf(out, "ok: undone, %d correction(s) left\n", eng.PendingUndo())
			} else {
				fmt.Fprintln(out, "nothing to undo")
			}
		case "snap":
			if eng == nil {
				fmt.Fprintln(out, "run 'dims' first")
				continue
			}
			fmt.Fprintf(out, "snapshot %d\n", eng.Snapshot())
		case "diff":
			if eng == nil {
				fmt.Fprintln(out, "run 'dims' first")
				continue
			}
			if len(toks) != 3 {
				fmt.Fprintln(out, "usage: diff <id1> <id2>   (id2=0 means current state)")
				continue
			}
			id1, err1 := strconv.Atoi(toks[1])
			id2, err2 := strconv.Atoi(toks[2])
			if err1 != nil || err2 != nil {
				fmt.Fprintln(out, "diff: need two snapshot ids")
				continue
			}
			var changes []matrixlib.Change
			var err error
			if id2 == 0 {
				changes, err = eng.DiffCurrent(id1)
			} else {
				changes, err = eng.DiffSnapshots(id1, id2)
			}
			if err != nil {
				fmt.Fprintln(out, "diff:", err)
				continue
			}
			if len(changes) == 0 {
				fmt.Fprintln(out, "no differences")
			}
			for _, ch := range changes {
				fmt.Fprintf(out, "%s(%d,%d): %d -> %d\n", ch.Matrix, ch.Row, ch.Col, ch.From, ch.To)
			}
		case "show":
			if eng == nil {
				fmt.Fprintln(out, "run 'dims' first")
				continue
			}
			if len(toks) != 2 {
				fmt.Fprintln(out, "usage: show A|B|C")
				continue
			}
			var m *matrixlib.Matrix
			switch toks[1] {
			case "A":
				m = eng.A
			case "B":
				m = eng.B
			case "C":
				m = eng.C
			default:
				fmt.Fprintln(out, "show: unknown matrix", toks[1])
				continue
			}
			rows, cols := m.Dims()
			entries := m.Entries()
			fmt.Fprintf(out, "%s %dx%d, %d non-zero\n", toks[1], rows, cols, len(entries))
			for _, en := range entries {
				fmt.Fprintf(out, "  (%d,%d) = %d\n", en.Row, en.Col, en.Val)
			}
		case "check":
			if eng == nil {
				fmt.Fprintln(out, "run 'dims' first")
				continue
			}
			if err := eng.Check(); err != nil {
				fmt.Fprintln(out, "check failed:", err)
			} else {
				fmt.Fprintln(out, "ok: C matches naive triple-loop product")
			}
		default:
			fmt.Fprintln(out, "unknown command:", toks[0])
		}
	}
	return sc.Err()
}

func fields(s string) []string {
	var out []string
	start := -1
	for i, r := range s {
		if r == ' ' || r == '\t' || r == '\r' {
			if start >= 0 {
				out = append(out, s[start:i])
				start = -1
			}
			continue
		}
		if start < 0 {
			start = i
		}
	}
	if start >= 0 {
		out = append(out, s[start:])
	}
	return out
}

func printHelp(w io.Writer) {
	fmt.Fprint(w, `commands:
  dims <aRows> <aCols> <bCols>  create matrices (A: aRows x aCols, B: aCols x bCols)
  setA <r> <c> <v>              correct element of A (v=0 deletes the entry)
  setB <r> <c> <v>              correct element of B (v=0 deletes the entry)
  undo                          revert the most recent correction
  snap                          store an immutable snapshot, prints its id
  diff <id1> <id2>              diff snapshots (id2=0 compares with current)
  show A|B|C                    print non-zero entries
  check                         verify C against the naive triple loop
  quit                          exit
`)
}
