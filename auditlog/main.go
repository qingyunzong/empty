package main

import (
	"flag"
	"fmt"
	"os"
	"strings"
)

func main() {
	if err := run(os.Args[1:]); err != nil {
		fmt.Fprintln(os.Stderr, "auditlog: "+err.Error())
		os.Exit(1)
	}
}

func run(args []string) error {
	if len(args) == 0 {
		return fmt.Errorf("usage: auditlog <append|recover|verify|reindex|list> [flags]")
	}
	switch args[0] {
	case "append":
		return cmdAppend(args[1:])
	case "recover":
		return cmdRecover(args[1:])
	case "verify":
		return cmdVerify(args[1:])
	case "reindex":
		return cmdReindex(args[1:])
	case "list":
		return cmdList(args[1:])
	default:
		return fmt.Errorf("unknown command %q", args[0])
	}
}

func cmdAppend(args []string) error {
	fs := flag.NewFlagSet("append", flag.ContinueOnError)
	logPath := fs.String("log", "audit.log", "path to audit log")
	seq := fs.Uint64("seq", 0, "explicit sequence number (default: last+1)")
	if err := fs.Parse(args); err != nil {
		return err
	}
	payload := []byte(strings.Join(fs.Args(), " "))
	n, err := appendFrame(*logPath, *seq, *seq == 0, payload)
	if err != nil {
		return err
	}
	fmt.Printf("appended seq=%d len=%d\n", n, len(payload))
	return nil
}

func cmdRecover(args []string) error {
	fs := flag.NewFlagSet("recover", flag.ContinueOnError)
	logPath := fs.String("log", "audit.log", "path to audit log")
	if err := fs.Parse(args); err != nil {
		return err
	}
	removed, err := recoverLog(*logPath)
	if err != nil {
		return err
	}
	if removed == 0 {
		fmt.Println("log is clean; nothing to truncate")
	} else {
		fmt.Printf("truncated %d bytes of incomplete tail frame\n", removed)
	}
	return nil
}

func cmdVerify(args []string) error {
	fs := flag.NewFlagSet("verify", flag.ContinueOnError)
	logPath := fs.String("log", "audit.log", "path to audit log")
	if err := fs.Parse(args); err != nil {
		return err
	}
	res, err := verifyLog(*logPath)
	if err != nil {
		return err
	}
	fmt.Printf("frames=%d firstSeq=%d lastSeq=%d tailBytes=%d\n",
		res.Frames, res.FirstSeq, res.LastSeq, res.TailBytes)
	if res.TailBytes > 0 {
		return fmt.Errorf("incomplete tail frame of %d bytes; run recover", res.TailBytes)
	}
	return nil
}

func cmdReindex(args []string) error {
	fs := flag.NewFlagSet("reindex", flag.ContinueOnError)
	logPath := fs.String("log", "audit.log", "path to audit log")
	idxPath := fs.String("index", "", "path to index file (default: <log>.idx)")
	if err := fs.Parse(args); err != nil {
		return err
	}
	if *idxPath == "" {
		*idxPath = *logPath + ".idx"
	}
	f, err := os.Open(*logPath)
	if err != nil {
		return err
	}
	frames, _, scanErr := scanFrames(f)
	f.Close()
	if scanErr != nil {
		return fmt.Errorf("cannot rebuild index from corrupt log: %w", scanErr)
	}
	idx, err := buildIndex(frames)
	if err != nil {
		return err
	}
	if err := writeIndex(*idxPath, idx); err != nil {
		return err
	}
	fmt.Printf("rebuilt index %s: %d entries\n", *idxPath, len(idx))
	return nil
}

func cmdList(args []string) error {
	fs := flag.NewFlagSet("list", flag.ContinueOnError)
	logPath := fs.String("log", "audit.log", "path to audit log")
	if err := fs.Parse(args); err != nil {
		return err
	}
	f, err := os.Open(*logPath)
	if err != nil {
		return err
	}
	defer f.Close()
	frames, _, err := scanFrames(f)
	if err != nil {
		return err
	}
	for _, fr := range frames {
		fmt.Printf("seq=%d offset=%d len=%d payload=%q\n", fr.Seq, fr.Offset, len(fr.Payload), fr.Payload)
	}
	return nil
}
