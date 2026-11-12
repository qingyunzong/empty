package qpackdec

import "testing"

func TestDrainAndErrorFormatting(t *testing.T) {
	d, _ := New(0, 0, testStatic())
	hb := HeaderBlock{StreamID: 1, Fields: []Field{{Kind: FieldStatic, Index: 0}}}
	out, err := d.HeaderBlockReceived(hb)
	if err != nil {
		t.Fatal(err)
	}
	if len(out) != 1 {
		t.Fatalf("immediate delivery = %d", len(out))
	}
	if drained := d.Drain(); len(drained) != 1 || drained[0].StreamID != 1 {
		t.Fatalf("drain mismatch: %+v", drained)
	}
	if drained := d.Drain(); len(drained) != 0 {
		t.Fatal("drain must clear the outbox")
	}

	// Trigger an error and check the message plus evidence retention.
	_, _ = d.HeaderBlockReceived(hb) // duplicate id
	derr := d.Err()
	if derr == nil {
		t.Fatal("expected terminal error")
	}
	if s := derr.Error(); s == "" {
		t.Fatal("error string must be non-empty")
	}
	if derr.Evidence.Op != "header_block" || derr.Evidence.Header == nil {
		t.Fatalf("evidence not retained: %+v", derr.Evidence)
	}
	// itoa must render a negative stream id path too.
	if _, err := New(-1, 0, nil); err == nil {
		t.Fatal("constructor must reject negative M")
	}
}

func TestInvalidFieldAndStaticIndex(t *testing.T) {
	cases := []struct {
		name string
		hb   HeaderBlock
		code string
	}{
		{
			name: "static index out of range high",
			hb:   HeaderBlock{StreamID: 1, Fields: []Field{{Kind: FieldStatic, Index: 99}}},
			code: "invalid_static_index",
		},
		{
			name: "static index negative",
			hb:   HeaderBlock{StreamID: 2, Fields: []Field{{Kind: FieldStatic, Index: -1}}},
			code: "invalid_static_index",
		},
		{
			name: "unknown field kind",
			hb:   HeaderBlock{StreamID: 3, Fields: []Field{{Kind: FieldKind(99)}}},
			code: "invalid_field_kind",
		},
		{
			name: "negative encoded count",
			hb:   HeaderBlock{StreamID: 4, EncodedCount: -1},
			code: "invalid_encoded_insert_count",
		},
		{
			name: "invalid sign",
			hb:   HeaderBlock{StreamID: 5, Sign: 7},
			code: "invalid_base_sign",
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			dec, _ := New(0, 0, testStatic())
			if _, err := dec.HeaderBlockReceived(tc.hb); err == nil {
				t.Fatal("expected error")
			} else if de, ok := err.(*DecodeError); !ok || de.Code != tc.code {
				t.Fatalf("got %v want code %s", err, tc.code)
			}
		})
	}
}

func TestCancelUnknownStreamIsIdempotentReservation(t *testing.T) {
	d, _ := New(320, 4, testStatic())
	if err := d.CancelStream(123); err != nil {
		t.Fatalf("cancelling an unknown stream reserves its id: %v", err)
	}
	// The reserved id cannot be used by a later header block.
	hb := HeaderBlock{StreamID: 123, Fields: []Field{{Kind: FieldStatic, Index: 0}}}
	if _, err := d.HeaderBlockReceived(hb); err == nil {
		t.Fatal("cancelled id must remain reserved")
	}
	// A second cancel of the same cancelled id is itself a reuse error.
	if err := d.CancelStream(123); err == nil {
		t.Fatal("double cancel must report reuse")
	}
}

func TestInsertTooLargeForCurrentCapacity(t *testing.T) {
	d, _ := New(1024, 0, testStatic())
	_ = d.SetCapacity(64)
	big := make([]byte, 128)
	for i := range big {
		big[i] = 'a'
	}
	if _, err := d.Insert(string(big), "x"); err == nil {
		t.Fatal("entry exceeding current capacity must error and stop the decoder")
	}
	if d.Err() == nil || d.Err().Code != "dynamic_table_insertion_failed" {
		t.Fatalf("unexpected state: %+v", d.Err())
	}
}

func TestRelativeNegativeAbsoluteRejected(t *testing.T) {
	d, _ := New(320, 2, testStatic())
	_ = d.SetCapacity(320)
	_, _ = d.Insert("a", "b")
	// R=1, base=1 (S=0,delta=0); relative i=2 -> base-2-1 = -2.
	hb := HeaderBlock{
		StreamID: 1, EncodedCount: 2, Sign: 0, Delta: 0,
		Fields: []Field{rel(2)},
	}
	if _, err := d.HeaderBlockReceived(hb); err == nil {
		t.Fatal("negative absolute dynamic index must be rejected")
	}
}
