package ticketlog

import (
	"fmt"
	"strconv"
	"strings"
)

// Op is the kind of a log event.
type Op int

const (
	OpLimit   Op = iota // LIMIT <n>        set the current total-grant ceiling
	OpApply             // APPLY <ticket> <n> open a new generation requesting n units
	OpGrant             // GRANT <ticket>    grant the pending application
	OpCancel            // CANCEL <ticket>   cancel a pending (ungranted) application
	OpRelease           // RELEASE <ticket>  release a granted ticket, freeing its units
)

func (o Op) String() string {
	switch o {
	case OpLimit:
		return "LIMIT"
	case OpApply:
		return "APPLY"
	case OpGrant:
		return "GRANT"
	case OpCancel:
		return "CANCEL"
	case OpRelease:
		return "RELEASE"
	}
	return "?"
}

// Event is a single log record. Seq is the 1-based position in the log,
// assigned by Check.
type Event struct {
	Seq    int
	Op     Op
	Ticket string
	Amount int // APPLY: requested units; LIMIT: new ceiling
}

func (e Event) String() string {
	switch e.Op {
	case OpLimit:
		return fmt.Sprintf("#%d LIMIT %d", e.Seq, e.Amount)
	case OpApply:
		return fmt.Sprintf("#%d APPLY %s %d", e.Seq, e.Ticket, e.Amount)
	default:
		return fmt.Sprintf("#%d %s %s", e.Seq, e.Op, e.Ticket)
	}
}

// Parse reads a text log. Blank lines and #-comments are ignored.
//
//	LIMIT 100
//	APPLY T1 30
//	GRANT T1
//	CANCEL T2
//	RELEASE T1
func Parse(text string) ([]Event, error) {
	var events []Event
	for lineno, raw := range strings.Split(text, "\n") {
		line := strings.TrimSpace(raw)
		if i := strings.IndexByte(line, '#'); i >= 0 {
			line = strings.TrimSpace(line[:i])
		}
		if line == "" {
			continue
		}
		fields := strings.Fields(line)
		ev := Event{Seq: lineno + 1}
		switch strings.ToUpper(fields[0]) {
		case "LIMIT":
			if len(fields) != 2 {
				return nil, fmt.Errorf("line %d: LIMIT takes 1 argument", lineno+1)
			}
			n, err := strconv.Atoi(fields[1])
			if err != nil {
				return nil, fmt.Errorf("line %d: bad LIMIT amount: %v", lineno+1, err)
			}
			ev.Op, ev.Amount = OpLimit, n
		case "APPLY":
			if len(fields) != 3 {
				return nil, fmt.Errorf("line %d: APPLY takes ticket and amount", lineno+1)
			}
			n, err := strconv.Atoi(fields[2])
			if err != nil {
				return nil, fmt.Errorf("line %d: bad APPLY amount: %v", lineno+1, err)
			}
			ev.Op, ev.Ticket, ev.Amount = OpApply, fields[1], n
		case "GRANT", "CANCEL", "RELEASE":
			if len(fields) != 2 {
				return nil, fmt.Errorf("line %d: %s takes a ticket", lineno+1, fields[0])
			}
			ev.Ticket = fields[1]
			switch strings.ToUpper(fields[0]) {
			case "GRANT":
				ev.Op = OpGrant
			case "CANCEL":
				ev.Op = OpCancel
			case "RELEASE":
				ev.Op = OpRelease
			}
		default:
			return nil, fmt.Errorf("line %d: unknown op %q", lineno+1, fields[0])
		}
		events = append(events, ev)
	}
	return events, nil
}
