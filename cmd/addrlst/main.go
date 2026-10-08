// Command addrlst reads an address list (stdin or files) and prints one
// JSON object per address: its comment-stripped text and its byte span in
// the original input.
//
//	addrlst [-chunk N] [file ...]
//
// -chunk N streams the input in N-byte reads; 0 reads each source whole.
// The parse result is identical either way.
package main

import (
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"os"

	"addrlst"
)

type record struct {
	Address string `json:"address"`
	Start   int    `json:"start"`
	End     int    `json:"end"`
}

func main() {
	chunk := flag.Int("chunk", 4096, "read chunk size in bytes; 0 reads each source whole")
	flag.Parse()
	if err := run(*chunk, flag.Args(), os.Stdin, os.Stdout); err != nil {
		fmt.Fprintln(os.Stderr, "addrlst:", err)
		os.Exit(1)
	}
}

func run(chunk int, files []string, stdin io.Reader, stdout io.Writer) error {
	enc := json.NewEncoder(stdout)
	enc.SetEscapeHTML(false)
	emit := func(r io.Reader) error {
		var addrs []addrlst.Address
		var err error
		if chunk <= 0 {
			var data []byte
			data, err = io.ReadAll(r)
			if err == nil {
				addrs = addrlst.ParseString(string(data))
			}
		} else {
			addrs, err = addrlst.ParseReader(r, chunk)
		}
		if err != nil {
			return err
		}
		for _, a := range addrs {
			if err := enc.Encode(record{Address: a.Clean, Start: a.Start, End: a.End}); err != nil {
				return err
			}
		}
		return nil
	}

	if len(files) == 0 {
		return emit(stdin)
	}
	for _, name := range files {
		f, err := os.Open(name)
		if err != nil {
			return err
		}
		err = emit(f)
		f.Close()
		if err != nil {
			return err
		}
	}
	return nil
}
