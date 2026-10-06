// Command jsoncanon canonicalizes a JSON-with-comments file into strict
// JSON with object keys sorted by UTF-8 byte order.
package main

import (
	"errors"
	"flag"
	"fmt"
	"os"
	"os/signal"
	"syscall"

	"jsoncanon"
)

func main() {
	var opts jsoncanon.RunOptions
	var resume bool
	flag.StringVar(&opts.OutputPath, "o", "", "output file for canonical JSON (required)")
	flag.StringVar(&opts.SpansPath, "spans", "", "optional output file for source spans (JSON)")
	flag.Int64Var(&opts.MemBudget, "mem-budget", 0, "per-object sort buffer budget in bytes (0 = unlimited)")
	flag.StringVar(&opts.TempDir, "tmp", "", "directory for external-sort temporary files")
	flag.StringVar(&opts.StatePath, "state", "", "checkpoint state file (enables pause/resume)")
	flag.IntVar(&opts.PauseAfterSegments, "pause-after", 0, "pause after N sort segments (for testing)")
	flag.BoolVar(&resume, "resume", false, "resume from the checkpoint state file")
	flag.Parse()
	opts.Resume = resume

	if flag.NArg() != 1 || opts.OutputPath == "" {
		fmt.Fprintln(os.Stderr, "usage: jsoncanon -o out.json [flags] <input.jsonc>")
		flag.PrintDefaults()
		os.Exit(2)
	}
	opts.InputPath = flag.Arg(0)

	// Checkpoints are written incrementally after every sort segment, so
	// on interrupt the state file is already current; just stop without
	// publishing partial output.
	sig := make(chan os.Signal, 1)
	signal.Notify(sig, os.Interrupt, syscall.SIGTERM)
	go func() {
		<-sig
		fmt.Fprintln(os.Stderr, "interrupted: no output published; rerun with -resume to continue from checkpoint")
		os.Exit(3)
	}()

	if err := jsoncanon.Run(opts); err != nil {
		if errors.Is(err, jsoncanon.ErrPaused) {
			fmt.Fprintf(os.Stderr, "paused: checkpoint written to %s; rerun with -resume to continue\n", opts.StatePath)
			os.Exit(3)
		}
		fmt.Fprintln(os.Stderr, "jsoncanon:", err)
		os.Exit(1)
	}
}
