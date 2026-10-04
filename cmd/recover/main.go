// Command recover runs ARIES-style recovery on a database directory.
//
// Usage:
//
//	recover -dir <dbdir> [-demo]
//
// With -demo it first seeds a crashed state (one committed and one
// uncommitted transaction, with the uncommitted page stolen to disk),
// then recovers it.
package main

import (
	"flag"
	"fmt"
	"os"
	"path/filepath"

	"pagedb/db"
	"pagedb/pagestore"
	"pagedb/wal"
)

func main() {
	dir := flag.String("dir", "", "database directory containing wal.log and pages.dat")
	demo := flag.Bool("demo", false, "seed a demo crashed state into -dir before recovering")
	flag.Parse()
	if *dir == "" {
		fmt.Fprintln(os.Stderr, "usage: recover -dir <dbdir> [-demo]")
		os.Exit(2)
	}
	if *demo {
		if err := seed(*dir); err != nil {
			fmt.Fprintln(os.Stderr, "seed:", err)
			os.Exit(1)
		}
		fmt.Println("seeded crashed state: t1 committed, t2 uncommitted, uncommitted page stolen to disk")
	}
	rep, err := db.Recover(*dir, nil)
	if err != nil {
		fmt.Fprintln(os.Stderr, "recover:", err)
		os.Exit(1)
	}
	fmt.Printf("winners (committed, kept): %v\n", rep.Winners)
	fmt.Printf("losers  (uncommitted, undone): %v\n", rep.Losers)
	fmt.Printf("redo: %d record(s) replayed\n", rep.Redone)
	fmt.Printf("undo: %d compensation record(s) written\n", rep.CLRs)
}

// seed writes a crashed database state into dir: t1 commits, t2 writes
// the same page without committing, and the dirty page is stolen to
// disk before the "crash".
func seed(dir string) error {
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return err
	}
	lg, err := wal.Open(filepath.Join(dir, "wal.log"))
	if err != nil {
		return err
	}
	ad, err := pagestore.OpenFileAdapter(filepath.Join(dir, "pages.dat"))
	if err != nil {
		return err
	}
	st := pagestore.NewStore(ad, lg)
	m := db.NewManager(lg, st)
	t1 := m.Begin()
	if err := t1.Write(0, []byte("committed by t1")); err != nil {
		return err
	}
	if err := t1.Commit(); err != nil {
		return err
	}
	t2 := m.Begin()
	if err := t2.Write(0, []byte("uncommitted by t2")); err != nil {
		return err
	}
	if err := st.Flush(0); err != nil { // steal: uncommitted page hits disk
		return err
	}
	if err := lg.Close(); err != nil { // crash: pending log tail is lost
		return err
	}
	return ad.Close()
}
