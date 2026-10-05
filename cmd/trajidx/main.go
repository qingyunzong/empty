// trajidx is a trajectory index CLI. It builds sidecar indexes next to log
// files (never modifying the originals) and verifies them incrementally
// against chained prefix digests, locating the first untrusted interval
// after arbitrary truncation or modification. Every verification is
// cross-checked against a full scan.
//
// Usage:
//
//	trajidx index  [-o index.tidx] <logfile>
//	trajidx verify [-i index.tidx] <logfile>
//	trajidx lookup [-i index.tidx] -n <line> <logfile>
//	trajidx info   [-i index.tidx] <logfile>
package main

import (
	"flag"
	"fmt"
	"os"

	"trajidx/tidx"
)

func main() {
	if len(os.Args) < 2 {
		usage()
		os.Exit(2)
	}
	var err error
	switch os.Args[1] {
	case "index":
		err = cmdIndex(os.Args[2:])
	case "verify":
		err = cmdVerify(os.Args[2:])
	case "lookup":
		err = cmdLookup(os.Args[2:])
	case "info":
		err = cmdInfo(os.Args[2:])
	default:
		usage()
		os.Exit(2)
	}
	if err != nil {
		fmt.Fprintln(os.Stderr, "trajidx:", err)
		os.Exit(1)
	}
}

func usage() {
	fmt.Fprint(os.Stderr, `usage:
  trajidx index  [-o index.tidx] <logfile>   build sidecar index (logfile untouched)
  trajidx verify [-i index.tidx] <logfile>   incremental verify + full-scan cross-check
  trajidx lookup [-i index.tidx] -n N <logfile>  print line N (1-based) via offsets
  trajidx info   [-i index.tidx] <logfile>   show index summary
`)
}

func defaultIndexPath(logPath string) string { return logPath + ".tidx" }

func cmdIndex(args []string) error {
	fs := flag.NewFlagSet("index", flag.ContinueOnError)
	out := fs.String("o", "", "index output path (default <logfile>.tidx)")
	if err := fs.Parse(args); err != nil {
		return err
	}
	if fs.NArg() != 1 {
		return fmt.Errorf("index: need exactly one logfile")
	}
	logPath := fs.Arg(0)
	if *out == "" {
		*out = defaultIndexPath(logPath)
	}
	idx, err := tidx.BuildFile(logPath)
	if err != nil {
		return err
	}
	if err := idx.WriteFile(*out); err != nil {
		return err
	}
	fmt.Printf("indexed %s -> %s\n", logPath, *out)
	fmt.Printf("file size: %d bytes, lines: %d\n", idx.FileSize, idx.LineCount())
	return nil
}

func cmdVerify(args []string) error {
	fs := flag.NewFlagSet("verify", flag.ContinueOnError)
	idxPath := fs.String("i", "", "index path (default <logfile>.tidx)")
	if err := fs.Parse(args); err != nil {
		return err
	}
	if fs.NArg() != 1 {
		return fmt.Errorf("verify: need exactly one logfile")
	}
	logPath := fs.Arg(0)
	if *idxPath == "" {
		*idxPath = defaultIndexPath(logPath)
	}
	idx, err := tidx.ReadFile(*idxPath)
	if err != nil {
		return err
	}
	inc, err := tidx.VerifyFile(logPath, idx)
	if err != nil {
		return err
	}
	full, err := tidx.FullScanFile(logPath, idx)
	if err != nil {
		return err
	}
	var curSize int64 = -1
	if st, err := os.Stat(logPath); err == nil {
		curSize = st.Size()
	}
	fmt.Print("incremental: ", tidx.FormatResult(inc, idx, curSize))
	fmt.Print("full scan:   ", tidx.FormatResult(full, idx, curSize))
	if !tidx.EqualTrust(inc, full) {
		fmt.Println("cross-check: MISMATCH (incremental and full scan disagree)")
		return fmt.Errorf("verification cross-check failed")
	}
	fmt.Println("cross-check: agree")
	if inc.Reason != tidx.OK {
		os.Exit(3)
	}
	return nil
}

func cmdLookup(args []string) error {
	fs := flag.NewFlagSet("lookup", flag.ContinueOnError)
	idxPath := fs.String("i", "", "index path (default <logfile>.tidx)")
	lineNo := fs.Uint64("n", 0, "1-based line number")
	if err := fs.Parse(args); err != nil {
		return err
	}
	if fs.NArg() != 1 || *lineNo == 0 {
		return fmt.Errorf("lookup: need -n <line>=1.. and one logfile")
	}
	logPath := fs.Arg(0)
	if *idxPath == "" {
		*idxPath = defaultIndexPath(logPath)
	}
	idx, err := tidx.ReadFile(*idxPath)
	if err != nil {
		return err
	}
	f, err := os.Open(logPath)
	if err != nil {
		return err
	}
	defer f.Close()
	line, err := tidx.LineAt(f, idx, *lineNo-1)
	if err != nil {
		return err
	}
	_, err = os.Stdout.Write(line)
	return err
}

func cmdInfo(args []string) error {
	fs := flag.NewFlagSet("info", flag.ContinueOnError)
	idxPath := fs.String("i", "", "index path (default <logfile>.tidx)")
	if err := fs.Parse(args); err != nil {
		return err
	}
	if fs.NArg() != 1 {
		return fmt.Errorf("info: need exactly one logfile")
	}
	if *idxPath == "" {
		*idxPath = defaultIndexPath(fs.Arg(0))
	}
	idx, err := tidx.ReadFile(*idxPath)
	if err != nil {
		return err
	}
	fmt.Printf("index: %s\nfile size: %d bytes\nlines: %d\nfinal digest: %x\n",
		*idxPath, idx.FileSize, idx.LineCount(), idx.FinalDigest)
	return nil
}
