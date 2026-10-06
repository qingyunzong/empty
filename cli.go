package crashreplay

import (
	"flag"
	"fmt"
	"io"
	"os"
	"sort"
	"strings"
)

// Exit codes for the CLI.
const (
	ExitOK = iota
	ExitCounterexample
	ExitUnknown
	ExitError
)

// Run executes the CLI: crashreplay verify [-seed N] <trace-file>.
// It writes the verdict to out and returns the process exit code.
func Run(args []string, out io.Writer) int {
	if len(args) < 1 || args[0] != "verify" {
		fmt.Fprintln(out, "usage: crashreplay verify [-seed N] <trace-file>")
		return ExitError
	}
	fs := flag.NewFlagSet("verify", flag.ContinueOnError)
	fs.SetOutput(out)
	seed := fs.Int64("seed", 1, "seed for the out-of-order publish implementation")
	if err := fs.Parse(args[1:]); err != nil {
		return ExitError
	}
	if fs.NArg() != 1 {
		fmt.Fprintln(out, "usage: crashreplay verify [-seed N] <trace-file>")
		return ExitError
	}
	f, err := os.Open(fs.Arg(0))
	if err != nil {
		fmt.Fprintln(out, "error:", err)
		return ExitError
	}
	defer f.Close()
	events, err := ParseTrace(f)
	if err != nil {
		fmt.Fprintln(out, "parse error:", err)
		return ExitError
	}
	res := Check(events, *seed)
	if res.Err != nil {
		fmt.Fprintln(out, "trace error:", res.Err)
		return ExitError
	}
	switch res.Verdict {
	case OK:
		states := 0
		for _, c := range res.Crashes {
			states += c.States
		}
		fmt.Fprintf(out, "OK: %d crash(es), %d possible recoveries verified, all invariants hold\n",
			len(res.Crashes), states)
		for _, c := range res.Crashes {
			fmt.Fprintf(out, "  crash #%d actual recovery: %s\n", c.Index, formatState(c.Actual))
		}
		return ExitOK
	case Counterexample:
		ce := res.Counterexample
		fmt.Fprintf(out, "COUNTEREXAMPLE at crash #%d\n", ce.CrashIndex)
		fmt.Fprintf(out, "  expectation violated: %s\n", ce.Expectation)
		fmt.Fprintf(out, "  persisted unsynced writes: %s\n", formatWrites(ce.Persisted))
		fmt.Fprintf(out, "  dropped unsynced writes: %s\n", formatWrites(ce.Dropped))
		fmt.Fprintf(out, "  recovered state: %s\n", formatState(ce.State))
		fmt.Fprintf(out, "  actual recovery (out-of-order publish): %s\n", formatState(ce.Actual))
		return ExitCounterexample
	default: // Unknown
		for _, c := range res.Crashes {
			if c.Unknown {
				fmt.Fprintf(out, "UNKNOWN at crash #%d: %d unsynced writes exceed enumeration budget of %d\n",
					c.Index, len(c.Pending), MaxEnumeratedWrites)
				fmt.Fprintf(out, "  actual recovery (out-of-order publish): %s\n", formatState(c.Actual))
			}
		}
		return ExitUnknown
	}
}

func formatWrites(ws []Write) string {
	if len(ws) == 0 {
		return "(none)"
	}
	parts := make([]string, len(ws))
	for i, w := range ws {
		parts[i] = fmt.Sprintf("#%d %s=%s", w.Seq, w.Key, w.Value)
	}
	return strings.Join(parts, ", ")
}

func formatState(state map[string]string) string {
	if len(state) == 0 {
		return "{}"
	}
	keys := make([]string, 0, len(state))
	for k := range state {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	parts := make([]string, len(keys))
	for i, k := range keys {
		parts[i] = k + "=" + state[k]
	}
	return "{" + strings.Join(parts, ", ") + "}"
}
