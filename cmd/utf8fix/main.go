// Command utf8fix reads a byte stream, replaces every invalid UTF-8 byte with
// one U+FFFD replacement character (valid sequences pass through unchanged),
// writes the repaired stream to stdout, and can emit the bidirectional
// byte<->code-point position mapping as JSON.
//
//	utf8fix [-chunk N] [-map FILE|-] [input-file]
//
// Input defaults to stdin. -chunk sets the read chunk size in bytes,
// demonstrating that chunked processing never misjudges a trailing partial
// sequence. -map writes the mapping JSON to FILE, or to stderr when "-".
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
	chunk := flag.Int("chunk", 4096, "read chunk size in bytes")
	mapOut := flag.String("map", "", "write byte<->code-point mapping JSON to FILE ('-' for stderr)")
	flag.Parse()

	in := io.Reader(os.Stdin)
	if flag.NArg() > 0 {
		f, err := os.Open(flag.Arg(0))
		if err != nil {
			fatal(err)
		}
		defer f.Close()
		in = f
	}

	fixer := utf8fix.New()
	n := *chunk
	if n < 1 {
		n = 1
	}
	buf := make([]byte, n)
	for {
		m, err := in.Read(buf)
		if m > 0 {
			fixer.Write(buf[:m])
		}
		if err == io.EOF {
			break
		}
		if err != nil {
			fatal(err)
		}
	}
	fixer.Close()

	if _, err := os.Stdout.Write(fixer.Bytes()); err != nil {
		fatal(err)
	}

	if *mapOut != "" {
		data, err := json.Marshal(fixer.Mapping())
		if err != nil {
			fatal(err)
		}
		data = append(data, '\n')
		if *mapOut == "-" {
			os.Stderr.Write(data)
		} else if err := os.WriteFile(*mapOut, data, 0o644); err != nil {
			fatal(err)
		}
	}
}

func fatal(err error) {
	fmt.Fprintln(os.Stderr, "utf8fix:", err)
	os.Exit(1)
}
