// Command recover runs ARIES-style recovery on a page-store directory
// containing data.db and wal.log, then prints a summary. It is safe to
// run repeatedly: recovery is idempotent.
//
// Usage:
//
//	recover -dir DATADIR
package main

import (
	"flag"
	"fmt"
	"os"

	"pagestore/db"
)

func main() {
	dir := flag.String("dir", ".", "directory containing data.db and wal.log")
	flag.Parse()

	d, err := db.Open(*dir)
	if err != nil {
		fmt.Fprintln(os.Stderr, "recover: open:", err)
		os.Exit(1)
	}
	defer d.Close()

	rep, err := d.Recover(db.RecoverOptions{})
	if err != nil {
		fmt.Fprintln(os.Stderr, "recover:", err)
		os.Exit(1)
	}
	fmt.Printf("scanned %d log records\n", rep.RecordsScanned)
	fmt.Printf("winners (committed, redone):  %v\n", rep.Winners)
	fmt.Printf("losers  (uncommitted, undone): %v\n", rep.Losers)
	fmt.Printf("redo applied %d record(s); undo wrote %d CLR(s)\n", rep.Redone, rep.CLRsWritten)
}
