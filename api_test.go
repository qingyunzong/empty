package formal_test

import (
	"errors"
	"testing"
	"time"

	"example.org/dlks/formal/q10059"
)

func TestConfigValidate(t *testing.T) {
	valid := formal.Config{
		DefaultForwarders: forwarders("10.0.0.1"),
		SearchDomains:     []string{"example.test"},
		Ndots:             1,
	}
	if err := valid.Validate(); err != nil {
		t.Fatalf("valid config rejected: %v", err)
	}

	invalid := valid
	invalid.Ndots = -1
	if err := invalid.Validate(); !errors.Is(err, formal.ErrInvalidConfig) {
		t.Fatalf("invalid config error = %v", err)
	}
}

func TestRootQueryUsesDefaultForwarder(t *testing.T) {
	cfg := formal.Config{
		DefaultForwarders: forwarders("10.0.0.1"),
		SearchDomains:     []string{"should.not.apply"},
		Timeout:           time.Second,
	}
	tr := formal.TransportFunc(func(name, forwarder string) formal.Reply {
		if name != "." || forwarder != "10.0.0.1" {
			t.Fatalf("unexpected exchange: %q via %q", name, forwarder)
		}
		return formal.Reply{Latency: time.Millisecond}
	})

	res, err := formal.Resolve(formal.Query{Name: ".", Config: cfg, Transport: tr})
	if err != nil {
		t.Fatal(err)
	}
	if len(res.Queries) != 1 || res.Queries[0].Name != "." {
		t.Fatalf("root query sequence: %#v", res.Queries)
	}
	if res.Source.Kind != formal.SourceDefault || res.Source.Name != "." {
		t.Fatalf("root source: %#v", res.Source)
	}
}

func TestCacheFuncAdapter(t *testing.T) {
	cfg := formal.Config{DefaultForwarders: forwarders("10.0.0.1")}
	transportCalled := false
	tr := formal.TransportFunc(func(name, forwarder string) formal.Reply {
		transportCalled = true
		return formal.Reply{Rcode: formal.RcodeNameError}
	})
	cache := formal.CacheFunc(func(name string) (formal.CacheEntry, bool) {
		if name == "host.test." {
			return formal.CacheEntry{Values: []string{"192.0.2.9"}}, true
		}
		return formal.CacheEntry{}, false
	})

	res, err := formal.Resolve(formal.Query{
		Name:      "host.test.",
		Config:    cfg,
		Cache:     cache,
		Transport: tr,
	})
	if err != nil {
		t.Fatal(err)
	}
	if transportCalled {
		t.Fatal("cache hit used the transport")
	}
	if res.Source.Kind != formal.SourceCache || len(res.Entry.Values) != 1 {
		t.Fatalf("cache result: %#v", res)
	}
}

func TestRcodeString(t *testing.T) {
	tests := map[formal.Rcode]string{
		formal.RcodeSuccess:        "NOERROR",
		formal.RcodeServerFailure:  "SERVFAIL",
		formal.RcodeNameError:      "NXDOMAIN",
		formal.RcodeNotImplemented: "NOTIMP",
		formal.Rcode(99):           "RCODE(99)",
	}
	for rcode, want := range tests {
		if got := rcode.String(); got != want {
			t.Fatalf("%d.String() = %q, want %q", rcode, got, want)
		}
	}
}
