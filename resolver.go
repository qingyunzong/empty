package formal

import (
	"fmt"
	"time"
)

// Query is the complete input to one resolution.
//
// Cache and Transport may be nil. A nil Cache behaves as an empty cache. A nil
// Transport is only an error if forwarding is actually required. Clock may be
// nil, in which case a new VirtualClock starting at the Unix epoch is used.
type Query struct {
	Name      string
	Config    Config
	Cache     Cache
	Clock     Clock
	Transport Transport
}

// Resolve applies the configured routing policy to one name.
//
// It returns an error only for an invalid configuration, an invalid query name,
// or a query that needs forwarding without a Transport. A name for which no
// positive answer exists is a successful resolution whose Source.Kind is
// SourceNone.
func Resolve(q Query) (*Result, error) {
	cfg, err := compileConfig(q.Config)
	if err != nil {
		return nil, err
	}
	name, err := parseQueryName(q.Name)
	if err != nil {
		return nil, err
	}

	clock := q.Clock
	if clock == nil {
		clock = NewVirtualClock(time.Unix(0, 0).UTC())
	}

	res := &Result{
		RequestedName: q.Name,
		Name:          fqdn(name.canonical),
		StartedAt:     clock.Now(),
	}

	var (
		elapsed  time.Duration
		lastName string
		lastCode Rcode
		lastWhy  string
	)

candidateLoop:
	for _, candidate := range candidateNames(name, cfg) {
		lastName = candidate

		if q.Cache != nil {
			if entry, ok := q.Cache.Lookup(candidate); ok {
				res.Queries = append(res.Queries, QueryStep{Name: candidate, CacheHit: true})
				if entry.Rcode == RcodeSuccess {
					cloned := cloneEntry(entry)
					res.Entry = &cloned
					res.Source = Source{
						Kind:  SourceCache,
						Name:  candidate,
						Rcode: RcodeSuccess,
					}
					res.Elapsed = elapsed
					res.FinishedAt = clock.Now()
					return res, nil
				}
				lastCode = entry.Rcode
				lastWhy = cacheReason(entry.Rcode)
				continue
			}
		}

		res.Queries = append(res.Queries, QueryStep{Name: candidate, CacheHit: false})
		forwarders, stubDomain := cfg.route(candidate)
		if len(forwarders) == 0 {
			lastCode = RcodeRefused
			lastWhy = "no-route"
			continue
		}
		if q.Transport == nil {
			return nil, fmt.Errorf("%w: cannot resolve %s", ErrNoTransport, candidate)
		}

		candidateWhy := ""
		for _, forwarder := range forwarders {
			timeout := cfg.forwarderTimeout(forwarder)
			reply := q.Transport.Exchange(candidate, forwarder.Address)

			latency := reply.Latency
			if latency < 0 {
				latency = 0
			}
			waited := latency
			if waited > timeout {
				waited = timeout
			}
			elapsed += waited
			clock.Advance(waited)

			attempt := Attempt{
				Name:       candidate,
				Forwarder:  forwarder.Address,
				StubDomain: stubDomain,
				Latency:    latency,
				Waited:     waited,
			}

			if reply.Latency > timeout {
				attempt.Outcome = AttemptTimeout
				attempt.Rcode = reply.Rcode
				if reply.Err != nil {
					attempt.Err = reply.Err.Error()
				}
				res.Attempts = append(res.Attempts, attempt)
				candidateWhy = "timeout"
				lastCode = reply.Rcode
				continue
			}

			if reply.Err != nil {
				attempt.Outcome = AttemptFailure
				attempt.Rcode = reply.Rcode
				attempt.Err = reply.Err.Error()
				res.Attempts = append(res.Attempts, attempt)
				candidateWhy = "failure"
				lastCode = reply.Rcode
				continue
			}

			attempt.Rcode = reply.Rcode
			switch reply.Rcode {
			case RcodeSuccess:
				attempt.Outcome = AttemptSuccess
				res.Attempts = append(res.Attempts, attempt)
				kind := SourceDefault
				if stubDomain != "" {
					kind = SourceStub
				}
				res.Source = Source{
					Kind:       kind,
					Name:       candidate,
					Forwarder:  forwarder.Address,
					StubDomain: stubDomain,
					Rcode:      RcodeSuccess,
				}
				res.Elapsed = elapsed
				res.FinishedAt = clock.Now()
				return res, nil

			case RcodeNameError:
				attempt.Outcome = AttemptNXDomain
				res.Attempts = append(res.Attempts, attempt)
				lastCode = RcodeNameError
				lastWhy = "nxdomain"
				continue candidateLoop

			default:
				attempt.Outcome = AttemptFailure
				res.Attempts = append(res.Attempts, attempt)
				candidateWhy = "failure"
				lastCode = reply.Rcode
			}
		}

		if candidateWhy == "" {
			candidateWhy = "failure"
		}
		lastWhy = candidateWhy
	}

	res.Elapsed = elapsed
	res.FinishedAt = clock.Now()
	res.Source = Source{
		Kind:   SourceNone,
		Name:   lastName,
		Rcode:  lastCode,
		Reason: lastWhy,
	}
	return res, nil
}

func cloneEntry(entry CacheEntry) CacheEntry {
	cloned := entry
	if entry.Values != nil {
		cloned.Values = append([]string(nil), entry.Values...)
	}
	return cloned
}

func cacheReason(rcode Rcode) string {
	switch rcode {
	case RcodeNameError:
		return "nxdomain"
	case RcodeSuccess:
		return "cache"
	default:
		return "cache-entry"
	}
}
