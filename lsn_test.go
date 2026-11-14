package dataeng

import (
	"encoding/json"
	"testing"
)

func TestLSNParseFormatRoundTrip(t *testing.T) {
	t.Parallel()
	cases := []string{"0/0", "0/1", "0/16B6C50", "1/0", "FFFFFFFF/FFFFFFFF"}
	for _, text := range cases {
		lsn, err := ParseLSN(text)
		if err != nil {
			t.Fatalf("ParseLSN(%q): %v", text, err)
		}
		if got := lsn.String(); got != text {
			t.Fatalf("round trip %q -> %q", text, got)
		}
	}
	if MustParseLSN("0/16B6C50") <= MustParseLSN("0/16B6C49") {
		t.Fatal("LSN comparison is incorrect")
	}
}

func TestLSNRejectsMalformedInput(t *testing.T) {
	t.Parallel()
	for _, text := range []string{"", "1", "1/", "/1", "1/2/3", "xyz/1", "1/xyz"} {
		if _, err := ParseLSN(text); err == nil {
			t.Fatalf("ParseLSN(%q) unexpectedly succeeded", text)
		}
	}
}

func TestLSNJSONAndText(t *testing.T) {
	t.Parallel()
	type payload struct {
		Position LSN `json:"position"`
	}
	original := payload{Position: MustParseLSN("0/16B6C50")}
	data, err := json.Marshal(original)
	if err != nil {
		t.Fatal(err)
	}
	if string(data) != `{"position":"0/16B6C50"}` {
		t.Fatalf("unexpected JSON: %s", data)
	}
	var decoded payload
	if err := json.Unmarshal(data, &decoded); err != nil {
		t.Fatal(err)
	}
	if decoded.Position != original.Position {
		t.Fatalf("got %s, want %s", decoded.Position, original.Position)
	}
	var numeric payload
	if err := json.Unmarshal([]byte(`{"position":1500000}`), &numeric); err != nil {
		t.Fatal(err)
	}
	if numeric.Position != LSN(1500000) {
		t.Fatalf("got %s", numeric.Position)
	}
}

func TestLSNAddOverflow(t *testing.T) {
	t.Parallel()
	got, ok := LSN(10).Add(5)
	if !ok || got != 15 {
		t.Fatalf("Add = %d, %v", got, ok)
	}
	if _, ok := LSN(^LSN(0)).Add(1); ok {
		t.Fatal("overflow was not reported")
	}
}
