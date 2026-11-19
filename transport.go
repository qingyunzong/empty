package formal

import (
	"strconv"
	"time"
)

// Rcode is a DNS response code.
type Rcode uint16

const (
	RcodeSuccess        Rcode = 0
	RcodeFormError      Rcode = 1
	RcodeServerFailure  Rcode = 2
	RcodeNameError      Rcode = 3
	RcodeNotImplemented Rcode = 4
	RcodeRefused        Rcode = 5
)

func (r Rcode) String() string {
	switch r {
	case RcodeSuccess:
		return "NOERROR"
	case RcodeFormError:
		return "FORMERR"
	case RcodeServerFailure:
		return "SERVFAIL"
	case RcodeNameError:
		return "NXDOMAIN"
	case RcodeNotImplemented:
		return "NOTIMP"
	case RcodeRefused:
		return "REFUSED"
	default:
		return "RCODE(" + strconv.Itoa(int(r)) + ")"
	}
}

// Reply is the deterministic result of one simulated exchange.
//
// Latency models how long the upstream took to respond. If Latency exceeds the
// attempt's timeout, the attempt is recorded as a timeout and the resolver
// falls back to the next forwarder. Err models a transport failure (for example
// a connection reset); non-NXDOMAIN rcodes are retryable in the same way.
type Reply struct {
	Rcode   Rcode
	Latency time.Duration
	Err     error
}

// Transport performs one simulated exchange with a forwarder. The name is a
// canonical, lowercase FQDN with a trailing root dot. Implementations must be
// safe to call sequentially; Resolve never calls them concurrently.
type Transport interface {
	Exchange(name, forwarder string) Reply
}

// TransportFunc adapts a function to the Transport interface.
type TransportFunc func(name, forwarder string) Reply

// Exchange implements Transport.
func (f TransportFunc) Exchange(name, forwarder string) Reply { return f(name, forwarder) }
