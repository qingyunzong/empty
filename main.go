// Command archivecli packs a directory tree into an archive and restores
// it into a new root.
//
//	archivecli pack   <src-dir> <archive-file>
//	archivecli unpack <archive-file> <new-root>
package main

import (
	"fmt"
	"os"

	"archivecli/internal/archive"
)

func main() {
	if err := run(os.Args[1:]); err != nil {
		fmt.Fprintln(os.Stderr, "archivecli:", err)
		os.Exit(1)
	}
}

func run(args []string) error {
	if len(args) != 3 {
		return fmt.Errorf("usage: archivecli pack <src-dir> <archive> | unpack <archive> <new-root>")
	}
	switch args[0] {
	case "pack":
		src, out := args[1], args[2]
		f, err := os.Create(out)
		if err != nil {
			return err
		}
		if err := archive.Create(src, f); err != nil {
			f.Close()
			os.Remove(out)
			return err
		}
		return f.Close()
	case "unpack":
		in, dest := args[1], args[2]
		f, err := os.Open(in)
		if err != nil {
			return err
		}
		defer f.Close()
		return archive.Extract(dest, f)
	default:
		return fmt.Errorf("unknown command %q", args[0])
	}
}
