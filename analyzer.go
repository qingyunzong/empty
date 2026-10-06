package hdrclient

import (
	"errors"
	"fmt"
	"net/http"
	"strings"
)

var (
	// ErrNoHeader is returned when the source header is absent.
	ErrNoHeader = errors.New("hdrclient: source header not present")
	// ErrDuplicateHeader is returned when the source header appears more
	// than once; a duplicated source header is always rejected.
	ErrDuplicateHeader = errors.New("hdrclient: source header present more than once")
)

// StopReason explains why right-to-left stripping stopped.
type StopReason int

const (
	// StopNone means analysis has not stopped (zero value).
	StopNone StopReason = iota
	// StopFirstUntrusted: the address at Stop.Index is not a trusted proxy,
	// so it is the client. This is the normal success outcome.
	StopFirstUntrusted
	// StopInvalidAddress: the element at Stop.Index failed to parse.
	// Analysis stops immediately; the element is never skipped.
	StopInvalidAddress
	// StopChainExhausted: every element in the chain was a trusted proxy,
	// so the leftmost element is reported as the client.
	StopChainExhausted
)

func (r StopReason) String() string {
	switch r {
	case StopFirstUntrusted:
		return "first-untrusted"
	case StopInvalidAddress:
		return "invalid-address"
	case StopChainExhausted:
		return "chain-exhausted"
	default:
		return "none"
	}
}

// Step records the classification of one chain element, in right-to-left
// evaluation order, including the exact table rule that was applied.
type Step struct {
	// Index is the element's position in the chain, 0 = leftmost.
	Index int
	// Raw is the element text as it appeared in the header.
	Raw string
	// Addr is the parsed, identity-unified address.
	Addr HostPort
	// Rule is the concrete table rule used to classify Addr.
	Rule Rule
}

func (s Step) String() string {
	return fmt.Sprintf("#%d %q -> %s [%s]", s.Index, s.Raw, s.Addr, s.Rule)
}

// Stop is the evidence for why stripping stopped.
type Stop struct {
	Reason StopReason
	// Index is the chain position where analysis stopped.
	Index int
	// Raw is the raw element text at Index.
	Raw string
	// Rule is the rule that denied trust (StopFirstUntrusted only); it is a
	// Deny rule when a longest-match exception rejected the address, or an
	// unmatched rule when no table entry covered it.
	Rule Rule
	// Err is the parse failure (StopInvalidAddress only).
	Err error
}

func (s Stop) String() string {
	switch s.Reason {
	case StopInvalidAddress:
		return fmt.Sprintf("stop #%d %q: %s (%v)", s.Index, s.Raw, s.Reason, s.Err)
	case StopFirstUntrusted:
		return fmt.Sprintf("stop #%d %q: %s [%s]", s.Index, s.Raw, s.Reason, s.Rule)
	default:
		return fmt.Sprintf("stop: %s", s.Reason)
	}
}

// Result is the outcome of one analysis.
type Result struct {
	// Client is the attributed client address. Valid only when ClientValid.
	Client HostPort
	// ClientValid is false when analysis stopped on an invalid address.
	ClientValid bool
	// Steps lists every evaluated element in right-to-left order with the
	// rule applied at each strip.
	Steps []Step
	// Stop carries the evidence for why stripping stopped.
	Stop Stop
}

// Analyzer evaluates forwarding headers against a bound configuration
// snapshot. It is safe for concurrent use; the snapshot never changes.
type Analyzer struct {
	snap   *Snapshot
	header string
}

// NewAnalyzer binds an analysis configuration: the snapshot of trusted
// prefixes (with its unification flag) and the source header name.
func NewAnalyzer(snap *Snapshot, sourceHeader string) *Analyzer {
	return &Analyzer{snap: snap, header: sourceHeader}
}

// Snapshot returns the configuration snapshot this analyzer is bound to.
func (a *Analyzer) Snapshot() *Snapshot { return a.snap }

// Analyze strips trusted proxies from the source header right to left and
// attributes the first untrusted address as the client.
//
// A duplicated source header is rejected with ErrDuplicateHeader. An
// unparsable element stops analysis immediately (it is never skipped): the
// returned Result carries the steps completed so far and the stop evidence,
// together with a non-nil error.
func (a *Analyzer) Analyze(h http.Header) (*Result, error) {
	vals := h.Values(a.header)
	if len(vals) == 0 {
		return nil, ErrNoHeader
	}
	if len(vals) > 1 {
		return nil, ErrDuplicateHeader
	}
	tokens := strings.Split(vals[0], ",")
	res := &Result{}
	for i := len(tokens) - 1; i >= 0; i-- {
		raw := strings.TrimSpace(tokens[i])
		hp, err := parseHostPort(raw)
		if err != nil {
			res.Stop = Stop{Reason: StopInvalidAddress, Index: i, Raw: raw, Err: err}
			return res, fmt.Errorf("hdrclient: chain element #%d %q: %w", i, raw, err)
		}
		hp.Addr = a.snap.unifyAddr(hp.Addr)
		rule := a.snap.Lookup(hp.Addr)
		res.Steps = append(res.Steps, Step{Index: i, Raw: raw, Addr: hp, Rule: rule})
		if !rule.Trusted() {
			res.Client = hp
			res.ClientValid = true
			res.Stop = Stop{Reason: StopFirstUntrusted, Index: i, Raw: raw, Rule: rule}
			return res, nil
		}
	}
	// Every element was trusted: attribute the leftmost (first evaluated
	// element is the rightmost, so the last step is the leftmost).
	last := res.Steps[len(res.Steps)-1]
	res.Client = last.Addr
	res.ClientValid = true
	res.Stop = Stop{Reason: StopChainExhausted, Index: last.Index, Raw: last.Raw, Rule: last.Rule}
	return res, nil
}
