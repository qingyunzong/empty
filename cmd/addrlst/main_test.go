package main

import (
	"bytes"
	"strings"
	"testing"
)

const cliInput = `"Doe, John" <john@x> (a, note), jane@y, "broken, tail@z
cont@x, last@w`

const wantOutput = `{"address":"\"Doe, John\" <john@x>","start":0,"end":30}
{"address":"jane@y","start":32,"end":38}
{"address":"\"broken, tail@z\ncont@x","start":40,"end":62}
{"address":"last@w","start":64,"end":70}
`

func TestRunChunkedMatchesWhole(t *testing.T) {
	for _, chunk := range []int{0, 1, 3, 4096} {
		var buf bytes.Buffer
		if err := run(chunk, nil, strings.NewReader(cliInput), &buf); err != nil {
			t.Fatalf("run(chunk=%d): %v", chunk, err)
		}
		if buf.String() != wantOutput {
			t.Errorf("run(chunk=%d) output:\n%s\nwant:\n%s", chunk, buf.String(), wantOutput)
		}
	}
}
