package tokenbucket

import (
	"bufio"
	"errors"
	"fmt"
	"io"
	"os"
	"strconv"
	"strings"
)

// Config configures a Limiter.
type Config struct {
	// Capacity is the maximum number of tokens the bucket can hold.
	Capacity int64
	// RateNum/RateDen is the refill rate in tokens per logical tick.
	// Example: RateNum=1, RateDen=2 accrues one token every two ticks.
	RateNum int64
	RateDen int64
	// Window is the number of most recent request IDs whose decisions are
	// retained for idempotent replay. It bounds the idempotency window
	// kept in memory and preserved by Truncate. Must be >= 1.
	Window int
}

func (c Config) validate() error {
	if c.Capacity < 0 {
		return errors.New("tokenbucket: Capacity must be >= 0")
	}
	if c.RateNum < 0 || c.RateDen <= 0 {
		return errors.New("tokenbucket: rate requires RateNum >= 0 and RateDen > 0")
	}
	if c.Window < 1 {
		return errors.New("tokenbucket: Window must be >= 1")
	}
	return nil
}

// Limiter is a persistent, idempotent token bucket.
//
// Log record format (space separated, one per line):
//
//	S <tokens> <rem> <last> <hasTime>            snapshot (written by Truncate)
//	W <id> <decision>                            retained window entry
//	D <id> <decision> <tokens> <rem> <last> <hasTime>  decision + post-state
//
// Request IDs must be non-empty and must not contain whitespace.
type Limiter struct {
	cfg  Config
	b    bucket
	path string
	f    *os.File
	w    *bufio.Writer

	decided map[string]bool // id -> original decision
	order   []string        // FIFO of IDs currently in the window
}

// Open opens (or creates) the log at path, replays it to restore state, and
// returns a ready Limiter. Reopening after a restart never re-charges a
// request ID that is still inside the idempotency window.
func Open(path string, cfg Config) (*Limiter, error) {
	if err := cfg.validate(); err != nil {
		return nil, err
	}
	l := &Limiter{
		cfg:     cfg,
		b:       newBucket(cfg.Capacity, cfg.RateNum, cfg.RateDen),
		path:    path,
		decided: make(map[string]bool),
	}
	if err := l.recover(); err != nil {
		return nil, err
	}
	f, err := os.OpenFile(path, os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0o644)
	if err != nil {
		return nil, err
	}
	l.f = f
	l.w = bufio.NewWriter(f)
	return l, nil
}

// Allow reports whether a request with the given id may proceed at logical
// time now, charging cost tokens. A repeated id returns the original
// decision without charging again.
func (l *Limiter) Allow(id string, cost int64, now int64) (bool, error) {
	if id == "" || strings.ContainsAny(id, " \t\n\r") {
		return false, errors.New("tokenbucket: invalid request id")
	}
	if cost < 0 {
		return false, errors.New("tokenbucket: cost must be >= 0")
	}
	if d, ok := l.decided[id]; ok {
		return d, nil
	}
	d := l.b.tryTake(cost, now)
	l.remember(id, d)
	if err := l.appendDecision(id, d); err != nil {
		return false, err
	}
	return d, nil
}

// State returns the current bucket state: whole tokens, remainder numerator
// (over RateDen), and the last logical time seen.
func (l *Limiter) State() (tokens, rem, last int64) {
	return l.b.tokens, l.b.rem, l.b.last
}

// Truncate compacts the log to a snapshot of the bucket state plus the
// current idempotency window, then atomically replaces the log file.
func (l *Limiter) Truncate() error {
	tmp := l.path + ".tmp"
	t, err := os.OpenFile(tmp, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0o644)
	if err != nil {
		return err
	}
	tw := bufio.NewWriter(t)
	fmt.Fprintf(tw, "S %d %d %d %d\n", l.b.tokens, l.b.rem, l.b.last, btoi(l.b.hasTime))
	for _, id := range l.order {
		fmt.Fprintf(tw, "W %s %d\n", id, btoi(l.decided[id]))
	}
	if err := tw.Flush(); err != nil {
		t.Close()
		return err
	}
	if err := t.Sync(); err != nil {
		t.Close()
		return err
	}
	if err := t.Close(); err != nil {
		return err
	}
	if err := l.f.Close(); err != nil {
		return err
	}
	if err := os.Rename(tmp, l.path); err != nil {
		return err
	}
	f, err := os.OpenFile(l.path, os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0o644)
	if err != nil {
		return err
	}
	l.f = f
	l.w = bufio.NewWriter(f)
	return nil
}

// Close flushes and closes the log.
func (l *Limiter) Close() error {
	if l.w != nil {
		if err := l.w.Flush(); err != nil {
			return err
		}
	}
	if l.f != nil {
		return l.f.Close()
	}
	return nil
}

func (l *Limiter) remember(id string, d bool) {
	if len(l.order) == l.cfg.Window {
		delete(l.decided, l.order[0])
		l.order = l.order[1:]
	}
	l.decided[id] = d
	l.order = append(l.order, id)
}

func (l *Limiter) appendDecision(id string, d bool) error {
	fmt.Fprintf(l.w, "D %s %d %d %d %d %d\n",
		id, btoi(d), l.b.tokens, l.b.rem, l.b.last, btoi(l.b.hasTime))
	if err := l.w.Flush(); err != nil {
		return err
	}
	return l.f.Sync()
}

func (l *Limiter) recover() error {
	f, err := os.Open(l.path)
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	if err != nil {
		return err
	}
	defer f.Close()
	r := bufio.NewReader(f)
	for {
		line, err := r.ReadString('\n')
		line = strings.TrimSpace(line)
		if line != "" {
			if perr := l.applyRecord(line); perr != nil {
				return perr
			}
		}
		if err == io.EOF {
			return nil
		}
		if err != nil {
			return err
		}
	}
}

func (l *Limiter) applyRecord(line string) error {
	f := strings.Fields(line)
	if len(f) == 0 {
		return nil
	}
	switch f[0] {
	case "S":
		if len(f) != 5 {
			return fmt.Errorf("tokenbucket: bad snapshot record: %q", line)
		}
		tokens, rem, last, hasTime, err := parseState(f[1:])
		if err != nil {
			return err
		}
		l.b.tokens, l.b.rem, l.b.last, l.b.hasTime = tokens, rem, last, hasTime
		l.decided = make(map[string]bool)
		l.order = nil
	case "W":
		if len(f) != 3 {
			return fmt.Errorf("tokenbucket: bad window record: %q", line)
		}
		d, err := parseDecision(f[2])
		if err != nil {
			return err
		}
		l.remember(f[1], d)
	case "D":
		if len(f) != 7 {
			return fmt.Errorf("tokenbucket: bad decision record: %q", line)
		}
		d, err := parseDecision(f[2])
		if err != nil {
			return err
		}
		tokens, rem, last, hasTime, err := parseState(f[3:])
		if err != nil {
			return err
		}
		l.remember(f[1], d)
		l.b.tokens, l.b.rem, l.b.last, l.b.hasTime = tokens, rem, last, hasTime
	default:
		return fmt.Errorf("tokenbucket: unknown record: %q", line)
	}
	return nil
}

func parseState(f []string) (tokens, rem, last int64, hasTime bool, err error) {
	if tokens, err = strconv.ParseInt(f[0], 10, 64); err != nil {
		return
	}
	if rem, err = strconv.ParseInt(f[1], 10, 64); err != nil {
		return
	}
	if last, err = strconv.ParseInt(f[2], 10, 64); err != nil {
		return
	}
	hasTime, err = parseDecision(f[3])
	return
}

func parseDecision(s string) (bool, error) {
	switch s {
	case "0":
		return false, nil
	case "1":
		return true, nil
	}
	return false, fmt.Errorf("tokenbucket: bad decision value %q", s)
}

func btoi(b bool) int64 {
	if b {
		return 1
	}
	return 0
}
