package hdrclient

import (
	"fmt"
	"net/netip"
	"strings"
)

// StopReason explains why the right-to-left walk terminated.
type StopReason int

const (
	// StopUntrusted: the first untrusted address from the right was
	// found and taken as the client.
	StopUntrusted StopReason = iota
	// StopChainExhausted: every entry was trusted; the leftmost entry
	// is taken as the client.
	StopChainExhausted
	// StopMalformed: an invalid address token was encountered. The walk
	// stops and reports; malformed entries are never skipped.
	StopMalformed
	// StopDuplicateHeader: the source header appeared more than once.
	StopDuplicateHeader
	// StopEmptyChain: no entries were available to analyze.
	StopEmptyChain
)

func (s StopReason) String() string {
	switch s {
	case StopUntrusted:
		return "untrusted-address"
	case StopChainExhausted:
		return "chain-exhausted"
	case StopMalformed:
		return "malformed-address"
	case StopDuplicateHeader:
		return "duplicate-header"
	case StopEmptyChain:
		return "empty-chain"
	}
	return "unknown"
}

// Strip records one peeled hop and the exact rule that authorized it.
type Strip struct {
	Hop     int        // position from the right, 0 = rightmost entry
	Raw     string     // token as it appeared in the header
	Address netip.Addr // normalized address that matched
	Rule    Rule       // the specific trusted-prefix rule used
}

// Result is the outcome of one analysis.
type Result struct {
	Client    netip.Addr // attributed client address (valid when Err == nil)
	ClientRaw string
	Strips    []Strip // every peeled hop, right to left, with its rule
	Stop      StopReason
	Evidence  string // human-readable stop evidence
	Err       error  // non-nil when the analysis was rejected
}

// OK reports whether a client address was attributed without rejection.
func (r Result) OK() bool { return r.Err == nil }

// Report renders the full evidence trail: each strip with its rule,
// then the stop reason and evidence.
func (r Result) Report() string {
	var b strings.Builder
	for _, s := range r.Strips {
		fmt.Fprintf(&b, "strip hop %d: %s (raw %q) peeled by rule %s\n",
			s.Hop, s.Address, s.Raw, s.Rule)
	}
	fmt.Fprintf(&b, "stop: %s: %s", r.Stop, r.Evidence)
	return b.String()
}

// Analyzer attributes client addresses from forwarding headers. It is
// bound to a fixed config snapshot and is safe for concurrent use.
type Analyzer struct {
	snap   *Snapshot
	header string
}

// NewAnalyzer binds an analyzer to a snapshot and a source header name
// (for example "X-Forwarded-For").
func NewAnalyzer(snap *Snapshot, header string) *Analyzer {
	return &Analyzer{snap: snap, header: header}
}

// Snapshot returns the config snapshot this analyzer is bound to.
func (a *Analyzer) Snapshot() *Snapshot { return a.snap }

// Analyze walks the chain right to left. values holds every occurrence
// of the source header; more than one occurrence rejects the request.
// directPeer, when non-empty, is appended as the rightmost hop.
func (a *Analyzer) Analyze(values []string, directPeer string) Result {
	if len(values) > 1 {
		return Result{
			Stop:     StopDuplicateHeader,
			Err:      fmt.Errorf("hdrclient: source header %q appeared %d times", a.header, len(values)),
			Evidence: fmt.Sprintf("source header %q appeared %d times; duplicate headers are rejected", a.header, len(values)),
		}
	}
	var tokens []string
	if len(values) == 1 {
		tokens = strings.Split(values[0], ",")
	}
	if directPeer != "" {
		tokens = append(tokens, directPeer)
	}
	if len(tokens) == 0 {
		return Result{
			Stop:     StopEmptyChain,
			Err:      fmt.Errorf("hdrclient: no address entries to analyze"),
			Evidence: "no header value and no direct peer; nothing to analyze",
		}
	}

	var strips []Strip
	for i := len(tokens) - 1; i >= 0; i-- {
		hop := len(tokens) - 1 - i
		raw := strings.TrimSpace(tokens[i])
		addr, err := parseToken(raw)
		if err != nil {
			return Result{
				Strips: strips,
				Stop:   StopMalformed,
				Err:    err,
				Evidence: fmt.Sprintf("stopped at hop %d from the right: %v; malformed addresses stop the walk and are never skipped",
					hop, err),
			}
		}
		addr = a.snap.normalize(addr)
		rule, ok := a.snap.Lookup(addr)
		if !ok || rule.Action == ActionDeny {
			why := "no trusted prefix rule matched"
			if ok {
				why = "matched deny exception " + rule.String()
			}
			return Result{
				Client:    addr,
				ClientRaw: raw,
				Strips:    strips,
				Stop:      StopUntrusted,
				Evidence:  fmt.Sprintf("client %s attributed at hop %d from the right: first untrusted address (%s)", addr, hop, why),
			}
		}
		strips = append(strips, Strip{Hop: hop, Raw: raw, Address: addr, Rule: rule})
	}

	last := strips[len(strips)-1]
	return Result{
		Client:    last.Address,
		ClientRaw: last.Raw,
		Strips:    strips,
		Stop:      StopChainExhausted,
		Evidence: fmt.Sprintf("all %d entries were trusted and peeled; leftmost entry %s taken as client",
			len(tokens), last.Address),
	}
}

// HeaderValues is implemented by http.Header and similar types.
type HeaderValues interface {
	Values(key string) []string
}

// AnalyzeHeader analyzes a header map (for example http.Header),
// rejecting requests where the source header appears more than once.
func (a *Analyzer) AnalyzeHeader(h HeaderValues, directPeer string) Result {
	return a.Analyze(h.Values(a.header), directPeer)
}
