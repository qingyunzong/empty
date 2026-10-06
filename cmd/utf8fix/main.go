// Command utf8fix reads bytes, rewrites them into valid UTF-8 (one U+FFFD
// per invalid byte, valid sequences preserved) to stdout, and optionally
// emits the bidirectional byte<->rune position mapping as JSON.
//
//	utf8fix [-chunk N] [-map FILE|-] [input-file]
//
// Input defaults to stdin. The mapping JSON goes to FILE, or to stderr
// when FILE is "-".
package main

import (
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"os"

	"utf8fix"
)

func main() {
	chunk := flag.Int("chunk", 32*1024, "read chunk size in bytes")
	mapOut := flag.String("map", "", "write byte<->rune mapping JSON to FILE (`-` for stderr)")
	flag.Parse()

	if *chunk < 1 {
		fatal(fmt.Errorf("-chunk must be >= 1"))
	}

	in := io.Reader(os.Stdin)
	if flag.NArg() > 1 {
		fatal(fmt.Errorf("at most one input file allowed"))
	}
	if flag.NArg() == 1 {
		f, err := os.Open(flag.Arg(0))
		if err != nil {
			fatal(err)
		}
		defer f.Close()
		in = f
	}

	fixer := utf8fix.NewFixer()
	buf := make([]byte, *chunk)
	for {
		n, err := in.Read(buf)
		if n > 0 {
			fixer.Write(buf[:n])
			if _, werr := os.Stdout.Write(fixer.Drain()); werr != nil {
				fatal(werr)
			}
		}
		if err == io.EOF {
			break
		}
		if err != nil {
			fatal(err)
		}
	}
	fixer.Flush()
	if _, err := os.Stdout.Write(fixer.Drain()); err != nil {
		fatal(err)
	}

	if *mapOut != "" {
		w := io.Writer(os.Stderr)
		if *mapOut != "-" {
			f, err := os.Create(*mapOut)
			if err != nil {
				fatal(err)
			}
			defer f.Close()
			w = f
		}
		m := fixer.Mapping()
		payload := map[string]any{
			"inputBytes":  len(m.ByteToRune),
			"outputRunes": len(m.RuneToByte),
			"byteToRune":  m.ByteToRune,
			"runeToByte":  m.RuneToByte,
		}
		enc := json.NewEncoder(w)
		if err := enc.Encode(payload); err != nil {
			fatal(err)
		}
	}
}

func fatal(err error) {
	fmt.Fprintln(os.Stderr, "utf8fix:", err)
	os.Exit(1)
}
