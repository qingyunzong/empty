// Command lzw encodes and decodes files with the LZW format defined in
// package lzw, and exposes checkpoint/range decoding.
package main

import (
	"flag"
	"fmt"
	"io"
	"os"

	"lzwcli/lzw"
)

func usage() {
	fmt.Fprintf(os.Stderr, `usage:
  lzw encode      [-o out] [in]           compress (default stdin/stdout)
  lzw decode      [-o out] [in]           decompress (default stdin/stdout)
  lzw range -start N [-end M] [-o out] [in]
                                          decode only codes [start, end)
  lzw checkpoints [-every N] [in]         dump decoder checkpoints
`)
}

func main() {
	if len(os.Args) < 2 {
		usage()
		os.Exit(2)
	}
	var err error
	switch os.Args[1] {
	case "encode":
		err = cmdConvert(os.Args[2:], func(b []byte) ([]byte, error) { return lzw.Encode(b), nil })
	case "decode":
		err = cmdConvert(os.Args[2:], lzw.Decode)
	case "range":
		err = cmdRange(os.Args[2:])
	case "checkpoints":
		err = cmdCheckpoints(os.Args[2:])
	default:
		usage()
		os.Exit(2)
	}
	if err != nil {
		fmt.Fprintln(os.Stderr, "lzw:", err)
		os.Exit(1)
	}
}

func readInput(args []string) ([]byte, error) {
	if len(args) == 0 || args[0] == "-" {
		return io.ReadAll(os.Stdin)
	}
	return os.ReadFile(args[0])
}

func writeOutput(path string, data []byte) error {
	if path == "" || path == "-" {
		_, err := os.Stdout.Write(data)
		return err
	}
	return os.WriteFile(path, data, 0o644)
}

func cmdConvert(args []string, fn func([]byte) ([]byte, error)) error {
	fs := flag.NewFlagSet("convert", flag.ContinueOnError)
	out := fs.String("o", "", "output file")
	if err := fs.Parse(args); err != nil {
		return err
	}
	in, err := readInput(fs.Args())
	if err != nil {
		return err
	}
	res, err := fn(in)
	if err != nil {
		return err
	}
	return writeOutput(*out, res)
}

func cmdRange(args []string) error {
	fs := flag.NewFlagSet("range", flag.ContinueOnError)
	start := fs.Int("start", 0, "first code index to decode")
	end := fs.Int("end", -1, "decode up to (excluding) this code index; -1 = end of stream")
	out := fs.String("o", "", "output file")
	if err := fs.Parse(args); err != nil {
		return err
	}
	in, err := readInput(fs.Args())
	if err != nil {
		return err
	}
	res, err := lzw.DecodeRange(in, *start, *end)
	if err != nil {
		return err
	}
	return writeOutput(*out, res)
}

func cmdCheckpoints(args []string) error {
	fs := flag.NewFlagSet("checkpoints", flag.ContinueOnError)
	every := fs.Int("every", 1, "print one checkpoint per N codes")
	if err := fs.Parse(args); err != nil {
		return err
	}
	in, err := readInput(fs.Args())
	if err != nil {
		return err
	}
	tr, err := lzw.DecodeTrace(in)
	if err != nil {
		return err
	}
	fmt.Println("# codeindex\tbitpos\twidth\tnext\tgen\tprev\tdigest")
	for i, cp := range tr.Checkpoints {
		if i%*every != 0 {
			continue
		}
		fmt.Printf("%d\t%d\t%d\t%d\t%d\t%d\t%x\n",
			cp.CodeIndex, cp.BitPos, cp.Width, cp.Next, cp.Generation, cp.PrevCode, cp.Digest[:8])
	}
	return nil
}
