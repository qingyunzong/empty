package sse_test

import (
	"strings"
	"testing"

	"example.org/dataeng/q0079/sse"
)

func TestAliasPackage(t *testing.T) {
	p := sse.NewDecoder(strings.NewReader("id: 1\ndata: hello\n\n"))
	event, err := p.Decode()
	if err != nil {
		t.Fatal(err)
	}
	if event.Data != "hello" {
		t.Errorf("Data = %q, want hello", event.Data)
	}
	if err := p.Ack(event); err != nil {
		t.Fatal(err)
	}
	if p.CommittedID() != "1" {
		t.Errorf("CommittedID = %q, want 1", p.CommittedID())
	}
}
