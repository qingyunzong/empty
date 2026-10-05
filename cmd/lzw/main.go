// Command lzw compresses and decompresses files with the LZW algorithm
// (GIF variant), and can decode arbitrary code ranges by resuming from
// verified dictionary checkpoints.
package main

import (
	"flag"
	"fmt"
	"io"
	"os"

	"lzwcli/lzw"
)

func usage() {
	fmt.Fprintln(os.Stderr, `usage:
  lzw encode      [-o out] [in]        compress (default: stdin -> stdout)
  lzw decode      [-o out] [in]        decompress
  lzw range       -start N [-end M] [-o out] [in]
                                      decompress codes [N, M); M=-1 means to EOF
  lzw checkpoints [-every N] [-o out] [in]
                                      print a decoder checkpoint every N codes`)
}

func main() {
	if len(os.Args) < 2 {
		usage()
		os.Exit(2)
	}
	var err error
	switch os.Args[1] {
	case "encode":
		err = cmdEncode(os.Args[2:])
	case "decode":
		err = cmdDecode(os.Args[2:])
	case "range":
		err = cmdRange(os.Args[2:])
	case "checkpoints":
		err = cmdCheckpoints(os.Args[2:])
	default:
		usage()
		os.Exit(2)
	}
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}

func readInput(fs *flag.FlagSet) ([]byte, error) {
	if fs.NArg() > 1 {
		return nil, fmt.Errorf("too many input files")
	}
	if fs.NArg() == 1 {
		return os.ReadFile(fs.Arg(0))
	}
	return io.ReadAll(os.Stdin)
}

func writeOutput(outPath string, data []byte) error {
	if outPath == "" {
		_, err := os.Stdout.Write(data)
		return err
	}
	return os.WriteFile(outPath, data, 0o644)
}

func cmdEncode(args []string) error {
	fs := flag.NewFlagSet("encode", flag.ContinueOnError)
	outPath := fs.String("o", "", "output file (default stdout)")
	if err := fs.Parse(args); err != nil {
		return err
	}
	src, err := readInput(fs)
	if err != nil {
		return err
	}
	return writeOutput(*outPath, lzw.Encode(src))
}

func cmdDecode(args []string) error {
	fs := flag.NewFlagSet("decode", flag.ContinueOnError)
	outPath := fs.String("o", "", "output file (default stdout)")
	if err := fs.Parse(args); err != nil {
		return err
	}
	data, err := readInput(fs)
	if err != nil {
		return err
	}
	out, err := lzw.Decode(data)
	if err != nil {
		return err
	}
	return writeOutput(*outPath, out)
}

func cmdRange(args []string) error {
	fs := flag.NewFlagSet("range", flag.ContinueOnError)
	start := fs.Int("start", 0, "index of the first code to decode")
	end := fs.Int("end", -1, "index after the last code to decode (-1: through EOF)")
	outPath := fs.String("o", "", "output file (default stdout)")
	if err := fs.Parse(args); err != nil {
		return err
	}
	data, err := readInput(fs)
	if err != nil {
		return err
	}
	_, cps, err := lzw.DecodeCheckpoints(data)
	if err != nil {
		return err
	}
	out, err := lzw.DecodeRange(data, *start, *end, lzw.SelectCheckpoint(cps, *start))
	if err != nil {
		return err
	}
	return writeOutput(*outPath, out)
}

func cmdCheckpoints(args []string) error {
	fs := flag.NewFlagSet("checkpoints", flag.ContinueOnError)
	every := fs.Int("every", 1, "print every Nth checkpoint")
	outPath := fs.String("o", "", "output file (default stdout)")
	if err := fs.Parse(args); err != nil {
		return err
	}
	data, err := readInput(fs)
	if err != nil {
		return err
	}
	_, cps, err := lzw.DecodeCheckpointEvery(data, *every)
	if err != nil {
		return err
	}
	var buf []byte
	for _, cp := range cps {
		buf = append(buf, fmt.Sprintf("code=%d bit=%d width=%d hi=%d last=%d out=%d dict=%x src=%x\n",
			cp.CodeIndex, cp.BitPos, cp.Width, cp.Hi, cp.Last, cp.OutLen,
			cp.DictHash[:8], cp.SrcHash[:8])...)
	}
	return writeOutput(*outPath, buf)
}
