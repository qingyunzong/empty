// Command brack is a small CLI around the brackdiag library.
//
// Usage:
//
//	brack check <file>
//	brack edit <file> <offset> <deleteLen> <insertText> [-w]
//
// check prints bracket diagnostics for a file.
// edit applies one edit in memory (or in place with -w) and prints the
// diagnostics of the edited text, computed incrementally by Document.
package main

import (
	"flag"
	"fmt"
	"os"
	"strconv"

	"brackdiag/brackdiag"
)

func usage() {
	fmt.Fprintf(os.Stderr, "usage:\n")
	fmt.Fprintf(os.Stderr, "  brack check <file>\n")
	fmt.Fprintf(os.Stderr, "  brack edit <file> <offset> <deleteLen> <insertText> [-w]\n")
	os.Exit(2)
}

func report(label string, d brackdiag.Diag) {
	fmt.Printf("%s: %d matched pair(s), %d unmatched bracket(s)\n", label, len(d.Pairs), len(d.Unmatched))
	for _, p := range d.Pairs {
		fmt.Printf("  pair   open=%d close=%d\n", p.Open, p.Close)
	}
	for _, u := range d.Unmatched {
		fmt.Printf("  unmatched %q at %d\n", u.Ch, u.Off)
	}
	if d.ErrOff >= 0 {
		fmt.Printf("  earliest error at offset %d\n", d.ErrOff)
	} else {
		fmt.Printf("  no bracket errors\n")
	}
}

func main() {
	if len(os.Args) < 2 {
		usage()
	}
	switch os.Args[1] {
	case "check":
		fs := flag.NewFlagSet("check", flag.ExitOnError)
		fs.Parse(os.Args[2:])
		if fs.NArg() != 1 {
			usage()
		}
		data, err := os.ReadFile(fs.Arg(0))
		if err != nil {
			fmt.Fprintln(os.Stderr, err)
			os.Exit(1)
		}
		report(fs.Arg(0), brackdiag.Scan(string(data)))
	case "edit":
		fs := flag.NewFlagSet("edit", flag.ExitOnError)
		write := fs.Bool("w", false, "write result back to the file")
		fs.Parse(os.Args[2:])
		if fs.NArg() != 4 {
			usage()
		}
		file := fs.Arg(0)
		off, err1 := strconv.Atoi(fs.Arg(1))
		del, err2 := strconv.Atoi(fs.Arg(2))
		if err1 != nil || err2 != nil || del < 0 {
			fmt.Fprintln(os.Stderr, "invalid offset/deleteLen")
			os.Exit(2)
		}
		insert := fs.Arg(3)
		data, err := os.ReadFile(file)
		if err != nil {
			fmt.Fprintln(os.Stderr, err)
			os.Exit(1)
		}
		doc := brackdiag.NewDocument(string(data))
		doc.Edit(off, del, insert)
		report(file+" (edited)", doc.Diagnostics())
		if *write {
			if err := os.WriteFile(file, []byte(doc.Text()), 0o644); err != nil {
				fmt.Fprintln(os.Stderr, err)
				os.Exit(1)
			}
		}
	default:
		usage()
	}
}
