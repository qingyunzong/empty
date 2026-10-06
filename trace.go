package crashreplay

import (
	"bufio"
	"fmt"
	"io"
	"strings"
)

// EventKind identifies the type of a trace event.
type EventKind int

const (
	EvWrite EventKind = iota
	EvSync
	EvCrash
	EvExpect
	EvRecover
)

// Event is one replayed CLI event.
type Event struct {
	Kind   EventKind
	Key    string
	Value  string
	Expect Expectation
}

// Expectation is a recovery invariant checked against every possible
// recovered state after a crash.
type Expectation struct {
	Op    string // "eq", "neq", "has", "absent"
	Key   string
	Value string
}

// Holds reports whether the expectation holds in the given recovered state.
func (e Expectation) Holds(state map[string]string) bool {
	v, ok := state[e.Key]
	switch e.Op {
	case "eq":
		return ok && v == e.Value
	case "neq":
		return !ok || v != e.Value
	case "has":
		return ok
	case "absent":
		return !ok
	}
	return false
}

func (e Expectation) String() string {
	if e.Op == "eq" || e.Op == "neq" {
		return fmt.Sprintf("%s %s %s", e.Op, e.Key, e.Value)
	}
	return fmt.Sprintf("%s %s", e.Op, e.Key)
}

// ParseTrace parses a line-based trace:
//
//	write <key> <value>
//	sync
//	crash
//	expect eq|neq <key> <value> | expect has|absent <key>
//	recover
//
// Blank lines and lines starting with '#' are ignored.
func ParseTrace(r io.Reader) ([]Event, error) {
	var events []Event
	sc := bufio.NewScanner(r)
	lineNo := 0
	for sc.Scan() {
		lineNo++
		line := strings.TrimSpace(sc.Text())
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		fields := strings.Fields(line)
		switch fields[0] {
		case "write":
			if len(fields) != 3 {
				return nil, fmt.Errorf("line %d: write expects 2 arguments", lineNo)
			}
			events = append(events, Event{Kind: EvWrite, Key: fields[1], Value: fields[2]})
		case "sync":
			if len(fields) != 1 {
				return nil, fmt.Errorf("line %d: sync takes no arguments", lineNo)
			}
			events = append(events, Event{Kind: EvSync})
		case "crash":
			if len(fields) != 1 {
				return nil, fmt.Errorf("line %d: crash takes no arguments", lineNo)
			}
			events = append(events, Event{Kind: EvCrash})
		case "recover":
			if len(fields) != 1 {
				return nil, fmt.Errorf("line %d: recover takes no arguments", lineNo)
			}
			events = append(events, Event{Kind: EvRecover})
		case "expect":
			if len(fields) < 3 {
				return nil, fmt.Errorf("line %d: expect needs an operator and key", lineNo)
			}
			op := fields[1]
			var exp Expectation
			switch op {
			case "eq", "neq":
				if len(fields) != 4 {
					return nil, fmt.Errorf("line %d: expect %s needs key and value", lineNo, op)
				}
				exp = Expectation{Op: op, Key: fields[2], Value: fields[3]}
			case "has", "absent":
				if len(fields) != 3 {
					return nil, fmt.Errorf("line %d: expect %s needs a key", lineNo, op)
				}
				exp = Expectation{Op: op, Key: fields[2]}
			default:
				return nil, fmt.Errorf("line %d: unknown expect operator %q", lineNo, op)
			}
			events = append(events, Event{Kind: EvExpect, Expect: exp})
		default:
			return nil, fmt.Errorf("line %d: unknown event %q", lineNo, fields[0])
		}
	}
	if err := sc.Err(); err != nil {
		return nil, err
	}
	return events, nil
}
