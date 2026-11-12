package ipfix_test

import (
	"testing"

	"example.org/dataeng/q0289/ipfix"
)

// TestTruncatedEOFExternal exercises the public API the collector host uses
// when the ordered TCP stream ends before a buffered frame is complete.
func TestTruncatedEOFExternal(t *testing.T) {
	r := ipfix.NewReceiver(ipfix.ConnIdentity{RemoteAddr: "peer-a"}, ipfix.Limits{})
	if _, err := r.Append([]byte{0, 10, 0, 30}); err != nil {
		t.Fatalf("partial header should stay buffered: %v", err)
	}
	if err := r.EndInput(); err == nil {
		t.Fatal("expected truncation error at real EOF")
	}
	if !r.Failed() {
		t.Fatal("truncated EOF must move the receiver into its failed terminal state")
	}
	if _, err := r.Append(nil); err != ipfix.ErrReceiverFailed {
		t.Fatalf("later append error = %v, want ErrReceiverFailed", err)
	}
}

func TestExternalIdentityIsolation(t *testing.T) {
	limits := ipfix.Limits{}
	first := ipfix.NewReceiver(ipfix.ConnIdentity{RemoteAddr: "peer-a"}, limits)
	rebuilt := ipfix.NewReceiver(ipfix.ConnIdentity{RemoteAddr: "peer-b"}, limits)
	if first.Identity().RemoteAddr == rebuilt.Identity().RemoteAddr {
		t.Fatal("rebuilt connection must carry a distinct identity")
	}
	if rebuilt.TemplateCount() != 0 {
		t.Fatal("new identity must not inherit templates")
	}
}
