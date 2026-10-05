// Command dirswap atomically replaces a target directory with a new
// one, using a persistent intent journal so that a crash at any
// point can be completed by a later "recover" run — and only that
// same transaction is completed.
package main

import (
	"flag"
	"fmt"
	"os"
)

func usage() {
	fmt.Fprintf(os.Stderr, `usage:
  dirswap publish -target <dir> -source <dir>
      Atomically replace <target> with <source>. <source> must be on
      the same filesystem as <target>'s directory. Refuses
      if <target> is or contains a symlink, spans filesystems, or a
      previous transaction is still pending.
  dirswap recover -target <dir>
      Complete the pending transaction recorded in the journal next
      to <target>. Never starts a new transaction and never deletes
      paths outside the recorded one.
`)
	os.Exit(2)
}

func main() {
	if len(os.Args) < 2 {
		usage()
	}
	switch os.Args[1] {
	case "publish":
		fs := flag.NewFlagSet("publish", flag.ExitOnError)
		target := fs.String("target", "", "directory to replace")
		source := fs.String("source", "", "new directory (sibling of target)")
		fs.Parse(os.Args[2:])
		if *target == "" || *source == "" {
			usage()
		}
		if err := Publish(*target, *source); err != nil {
			fmt.Fprintln(os.Stderr, "publish:", err)
			os.Exit(1)
		}
	case "recover":
		fs := flag.NewFlagSet("recover", flag.ExitOnError)
		target := fs.String("target", "", "directory whose pending transaction to finish")
		fs.Parse(os.Args[2:])
		if *target == "" {
			usage()
		}
		if err := Recover(*target); err != nil {
			fmt.Fprintln(os.Stderr, "recover:", err)
			os.Exit(1)
		}
	default:
		usage()
	}
}
