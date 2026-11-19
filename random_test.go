package formal_test

import (
	"errors"
	"fmt"
	"math/rand"
	"strings"
	"testing"
	"time"

	"example.org/dlks/formal/q10059"
)

func TestRandomizedDifferential(t *testing.T) {
	rng := rand.New(rand.NewSource(20261119))
	labelPool := []string{"a", "b", "c", "host", "svc", "x", "y", "node"}
	stubPool := []string{
		"example.com",
		"corp.example.com",
		"a.corp.example.com",
		"test",
		"s0.test",
		"s1.test",
	}
	timeouts := []time.Duration{
		20 * time.Millisecond,
		50 * time.Millisecond,
		100 * time.Millisecond,
	}

	for caseIndex := 0; caseIndex < 400; caseIndex++ {
		caseIndex := caseIndex
		t.Run(fmt.Sprintf("case-%03d", caseIndex), func(t *testing.T) {
			cfg := formal.Config{
				DefaultForwarders: randomForwarders(rng, 1+rng.Intn(3), timeouts),
				Ndots:             rng.Intn(6),
				Timeout:           timeouts[rng.Intn(len(timeouts))],
			}

			searchCount := rng.Intn(4)
			for i := 0; i < searchCount; i++ {
				cfg.SearchDomains = append(cfg.SearchDomains, fmt.Sprintf("s%d.test", i))
			}

			stubCount := rng.Intn(4)
			perm := rng.Perm(len(stubPool))
			cfg.StubDomains = make(map[string][]formal.Forwarder)
			for i := 0; i < stubCount; i++ {
				domain := stubPool[perm[i]]
				cfg.StubDomains[domain] = randomForwarders(rng, 1+rng.Intn(2), timeouts)
			}

			dots := rng.Intn(5)
			parts := make([]string, dots+1)
			for i := range parts {
				parts[i] = labelPool[rng.Intn(len(labelPool))]
			}
			name := strings.Join(parts, ".")
			if rng.Intn(3) == 0 {
				name += "."
			}

			allForwarders := collectForwarders(cfg)
			namePool := scenarioNames(name, cfg)
			replies := make(map[exchangeKey]formal.Reply)
			for _, candidate := range namePool {
				for _, f := range allForwarders {
					replies[exchangeKey{name: candidate, forwarder: f.Address}] = randomReply(rng, effectiveTimeout(cfg, f))
				}
			}

			var cache map[string]formal.CacheEntry
			if rng.Intn(5) != 0 {
				cache = make(map[string]formal.CacheEntry)
				cachedName := namePool[rng.Intn(len(namePool))]
				key := cachedName
				switch rng.Intn(3) {
				case 0:
					key = strings.TrimSuffix(strings.ToUpper(cachedName), ".")
				case 1:
					key = strings.TrimSuffix(cachedName, ".")
				}
				if rng.Intn(4) == 0 {
					cache[key] = formal.CacheEntry{Rcode: formal.RcodeNameError}
				} else {
					cache[key] = formal.CacheEntry{Values: []string{fmt.Sprintf("192.0.2.%d", 1+rng.Intn(250))}}
				}
			}

			runDifferential(t, scenario{
				name:      "randomized",
				config:    cfg,
				queryName: name,
				cache:     cache,
				transport: staticTransport(replies, formal.Reply{
					Rcode:   formal.RcodeNameError,
					Latency: time.Millisecond,
				}),
			})
		})
	}
}

func randomForwarders(rng *rand.Rand, count int, timeouts []time.Duration) []formal.Forwarder {
	out := make([]formal.Forwarder, count)
	for i := range out {
		timeout := time.Duration(0)
		if rng.Intn(2) == 0 {
			timeout = timeouts[rng.Intn(len(timeouts))]
		}
		out[i] = formal.Forwarder{
			Address: fmt.Sprintf("10.0.%d.%d", rng.Intn(3), i+1),
			Timeout: timeout,
		}
	}
	return out
}

func collectForwarders(cfg formal.Config) []formal.Forwarder {
	var out []formal.Forwarder
	out = append(out, cfg.DefaultForwarders...)
	for _, list := range cfg.StubDomains {
		out = append(out, list...)
	}
	return out
}

func effectiveTimeout(cfg formal.Config, f formal.Forwarder) time.Duration {
	if f.Timeout > 0 {
		return f.Timeout
	}
	return cfg.Timeout
}

func scenarioNames(name string, cfg formal.Config) []string {
	absolute := strings.ToLower(strings.TrimSuffix(name, ".")) + "."
	body := strings.TrimSuffix(absolute, ".")
	out := []string{absolute}
	for _, domain := range cfg.SearchDomains {
		out = append(out, body+"."+strings.ToLower(strings.TrimSuffix(domain, "."))+".")
	}
	return out
}

func randomReply(rng *rand.Rand, timeout time.Duration) formal.Reply {
	switch rng.Intn(10) {
	case 0, 1, 2:
		return formal.Reply{
			Rcode:   formal.RcodeSuccess,
			Latency: randomLatency(rng, timeout),
		}
	case 3, 4, 5:
		return formal.Reply{
			Rcode:   formal.RcodeNameError,
			Latency: randomLatency(rng, timeout),
		}
	case 6, 7:
		return formal.Reply{
			Latency: timeout + time.Duration(1+rng.Intn(1_000_000)),
		}
	case 8:
		return formal.Reply{
			Err:     errors.New("simulated transport failure"),
			Latency: randomLatency(rng, timeout),
		}
	default:
		return formal.Reply{
			Rcode:   formal.RcodeServerFailure,
			Latency: randomLatency(rng, timeout),
		}
	}
}

func randomLatency(rng *rand.Rand, timeout time.Duration) time.Duration {
	switch rng.Intn(6) {
	case 0:
		return timeout
	case 1:
		return 0
	default:
		return time.Duration(rng.Int63n(int64(timeout) + 1))
	}
}
