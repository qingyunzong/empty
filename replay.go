package quota

import (
	"bufio"
	"fmt"
	"io"
	"strconv"
	"strings"
)

// Event is a single replayable operation against a Store.
type Event struct {
	Op     string // rename, consume, merge, split, lease, release, commit
	Name   string // primary name the op acts on
	Target string // new name (rename), merge source, new ID (split), lease ID
	Amount int64  // consume / split / lease amount
}

// ReplayError records an event that failed during replay.
type ReplayError struct {
	Index int
	Event Event
	Err   error
}

func (e ReplayError) Error() string {
	return fmt.Sprintf("event %d (%s %s %s %d): %v", e.Index, e.Event.Op, e.Event.Name, e.Event.Target, e.Event.Amount, e.Err)
}

// ReplayResult summarizes a replay run.
type ReplayResult struct {
	Applied int
	Errors  []ReplayError
}

// Replay applies events to the store in order. Failures are collected and
// replay continues with the next event; the store is left in the state
// produced by the successfully applied prefix plus any later successes.
func Replay(s *Store, events []Event) *ReplayResult {
	res := &ReplayResult{}
	for i, ev := range events {
		if err := apply(s, ev); err != nil {
			res.Errors = append(res.Errors, ReplayError{Index: i, Event: ev, Err: err})
			continue
		}
		res.Applied++
	}
	return res
}

func apply(s *Store, ev Event) error {
	switch ev.Op {
	case "rename":
		return s.Rename(ev.Name, ev.Target)
	case "consume":
		return s.Consume(ev.Name, ev.Amount)
	case "merge":
		return s.Merge(ev.Name, ev.Target)
	case "split":
		return s.Split(ev.Name, ev.Target, ev.Amount)
	case "lease":
		return s.AcquireLease(ev.Name, ev.Target, ev.Amount)
	case "release":
		return s.ReleaseLease(ev.Target)
	case "commit":
		return s.CommitLease(ev.Target)
	default:
		return fmt.Errorf("quota: unknown op %q", ev.Op)
	}
}

// ParseEvents reads an event log, one event per line:
//
//	rename  <old> <new>
//	consume <name> <amount>
//	merge   <dst> <src>
//	split   <root> <newID> <amount>
//	lease   <name> <leaseID> <amount>
//	release <leaseID>
//	commit  <leaseID>
//
// Blank lines and lines starting with '#' are ignored.
func ParseEvents(r io.Reader) ([]Event, error) {
	var events []Event
	sc := bufio.NewScanner(r)
	lineNo := 0
	for sc.Scan() {
		lineNo++
		line := strings.TrimSpace(sc.Text())
		if i := strings.IndexByte(line, '#'); i >= 0 {
			line = strings.TrimSpace(line[:i])
		}
		if line == "" {
			continue
		}
		fields := strings.Fields(line)
		ev := Event{Op: fields[0]}
		need := func(n int) error {
			if len(fields) != n+1 {
				return fmt.Errorf("line %d: %q expects %d argument(s), got %d", lineNo, ev.Op, n, len(fields)-1)
			}
			return nil
		}
		amount := func(s string) error {
			v, err := strconv.ParseInt(s, 10, 64)
			if err != nil {
				return fmt.Errorf("line %d: bad amount %q: %w", lineNo, s, err)
			}
			ev.Amount = v
			return nil
		}
		switch ev.Op {
		case "rename", "merge":
			if err := need(2); err != nil {
				return nil, err
			}
			ev.Name, ev.Target = fields[1], fields[2]
		case "consume":
			if err := need(2); err != nil {
				return nil, err
			}
			ev.Name = fields[1]
			if err := amount(fields[2]); err != nil {
				return nil, err
			}
		case "split", "lease":
			if err := need(3); err != nil {
				return nil, err
			}
			ev.Name, ev.Target = fields[1], fields[2]
			if err := amount(fields[3]); err != nil {
				return nil, err
			}
		case "release", "commit":
			if err := need(1); err != nil {
				return nil, err
			}
			ev.Target = fields[1]
		default:
			return nil, fmt.Errorf("line %d: unknown op %q", lineNo, ev.Op)
		}
		events = append(events, ev)
	}
	if err := sc.Err(); err != nil {
		return nil, err
	}
	return events, nil
}
