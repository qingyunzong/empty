// Command addrlist reads an address list from stdin (or from the files
// named on the command line) and prints each parsed address together
// with its byte span in the original input, one per line:
//
//	[start:end] text
//
// See package addrlist for the supported syntax (quotes, backslash
// escapes, nestable parenthesized comments, top-level commas only).
package main

import (
	"fmt"
	"io"
	"os"

	"addrlist"
)

func main() {
	p := addrlist.NewParser(func(a addrlist.Address) {
		fmt.Printf("[%d:%d] %s\n", a.Start, a.End, a.Text)
	})

	if len(os.Args) > 1 {
		for _, name := range os.Args[1:] {
			if err := streamFile(p, name); err != nil {
				fmt.Fprintf(os.Stderr, "addrlist: %v\n", err)
				os.Exit(1)
			}
		}
	} else {
		stream(p, os.Stdin)
	}
	p.Close()
}

func streamFile(p *addrlist.Parser, name string) error {
	f, err := os.Open(name)
	if err != nil {
		return err
	}
	defer f.Close()
	stream(p, f)
	return nil
}

// stream feeds r to p in chunks, exercising the incremental interface
// exactly like any other streaming consumer would.
func stream(p *addrlist.Parser, r io.Reader) {
	buf := make([]byte, 32*1024)
	for {
		n, err := r.Read(buf)
		if n > 0 {
			p.Write(buf[:n])
		}
		if err != nil {
			return
		}
	}
}
