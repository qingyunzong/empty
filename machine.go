package orderstats

import "fmt"

// transitions is the order state machine: transitions[from][to] reports
// whether from -> to is legal.
var transitions = map[State]map[State]bool{
	StateNone:      {StateCreated: true},
	StateCreated:   {StatePaid: true, StateCancelled: true},
	StatePaid:      {StatePacked: true, StateCancelled: true},
	StatePacked:    {StateShipped: true, StateCancelled: true},
	StateShipped:   {StateDelivered: true},
	StateDelivered: {StateReturned: true},
	StateCancelled: {},
	StateReturned:  {},
}

// CanTransition reports whether the state machine allows from -> to.
func CanTransition(from, to State) bool {
	return transitions[from][to]
}

func transitionError(from, to State) string {
	if _, known := transitions[to]; !known {
		return fmt.Sprintf("unknown target state %q", string(to))
	}
	return fmt.Sprintf("illegal transition %q -> %q", string(from), string(to))
}
