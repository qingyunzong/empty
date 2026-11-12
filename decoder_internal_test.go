package dataeng

import "testing"

func TestOversizedHeaderDoesNotAllocatePayload(t *testing.T) {
	decoder := NewDecoder(1024)
	if _, err := decoder.Feed([]byte("1025")); err == nil {
		t.Fatal("expected oversized length error")
	}
	if decoder.payload != nil {
		t.Errorf("oversized frame allocated payload with capacity %d", cap(decoder.payload))
	}
	if decoder.payloadNeed != 0 || decoder.state != readingLength {
		t.Errorf("decoder entered payload state: %+v", decoder)
	}
}
