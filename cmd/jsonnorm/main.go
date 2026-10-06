// Command jsonnorm normalizes a JSON-with-comments subset into strict JSON.
package main

import (
	"context"
	"flag"
	"fmt"
	"os"
	"os/signal"
	"strconv"
	"syscall"

	"jsonnorm/norm"
)

func main() {
	var (
		in    = flag.String("i", "-", `input file ("-" for stdin)`)
		out   = flag.String("o", "-", `output file ("-" for stdout)`)
		state = flag.String("state", "", "state directory enabling checkpoint/resume for large objects")
		mem   = flag.Int64("mem", 64<<20, "memory budget in bytes for in-memory key/value buffering")
		spans = flag.String("spans", "", "also write a source span table (NDJSON) to this file")
	)
	flag.Parse()

	pauseAfter := 0
	if s := os.Getenv("JSONNORM_PAUSE_AFTER_SEGMENTS"); s != "" {
		if v, err := strconv.Atoi(s); err == nil {
			pauseAfter = v
		}
	}

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	code := norm.Run(ctx, norm.Options{
		InputPath:          *in,
		OutputPath:         *out,
		StateDir:           *state,
		MemBudget:          *mem,
		SpansPath:          *spans,
		PauseAfterSegments: pauseAfter,
	})
	if code != norm.ExitOK {
		fmt.Fprintf(os.Stderr, "jsonnorm: exit code %d\n", code)
	}
	os.Exit(code)
}
