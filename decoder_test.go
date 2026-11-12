package dataeng_test

import (
	"errors"
	"reflect"
	"strings"
	"testing"

	"example.org/dataeng/q0328"
)

func TestDecoderCompleteMessagesAndChunkEverywhere(t *testing.T) {
	first := emptyPayload
	second := `<17>1 2000-02-29T23:59:59.000001Z host app proc msg [x a="1\\2\"3\]4" b="2"][y] ` + "\xef\xbb\xbfbody"
	third := "<191>1 - - - - - - plain body"
	stream := frame(first) + frame(second) + frame(third)

	want := []dataeng.Message{
		{
			PRI: 134, Facility: 16, Severity: 6, Version: '1',
			Timestamp: dataeng.Timestamp{Raw: "-", Nil: true},
			Raw:       []byte(first),
		},
		{
			PRI: 17, Facility: 2, Severity: 1, Version: '1',
			Timestamp: dataeng.Timestamp{
				Raw: "2000-02-29T23:59:59.000001Z", Year: 2000, Month: 2, Day: 29,
				Hour: 23, Minute: 59, Second: 59, Fraction: "000001", Zone: "Z",
			},
			Host: "host", AppName: "app", ProcID: "proc", MsgID: "msg",
			StructuredData: []dataeng.SDElement{
				{
					ID: "x",
					Params: []dataeng.SDParam{
						{Name: "a", Value: `1\2"3]4`},
						{Name: "b", Value: "2"},
					},
				},
				{ID: "y"},
			},
			Message: "body", HasMessage: true, BOM: true,
			Raw: []byte(second),
		},
		{
			PRI: 191, Facility: 23, Severity: 7, Version: '1',
			Timestamp:  dataeng.Timestamp{Raw: "-", Nil: true},
			Message:    "plain body",
			HasMessage: true,
			Raw:        []byte(third),
		},
	}

	for split := 0; split <= len(stream); split++ {
		decoder := dataeng.NewDecoder(1024)
		got := feedAll(t, decoder, stream[:split], stream[split:])
		if !reflect.DeepEqual(got, want) {
			t.Fatalf("split %d: messages = %#v, want %#v", split, got, want)
		}
	}

	decoder := dataeng.NewDecoder(1024)
	var chunks []string
	for i := 0; i < len(stream); i++ {
		chunks = append(chunks, stream[i:i+1])
	}
	if got := feedAll(t, decoder, chunks...); !reflect.DeepEqual(got, want) {
		t.Fatalf("one-byte chunks: messages = %#v, want %#v", got, want)
	}
}

func TestDecoderRawLengthCountsEscapesAndBOM(t *testing.T) {
	payload := `<134>1 - host app proc msg [a b="\\\"\]"] ` + "\xef\xbb\xbftext"
	if len(payload) != len([]byte(payload)) {
		t.Fatal("string length unexpectedly differs from byte length")
	}

	decoder := dataeng.NewDecoder(len(payload))
	got := feedAll(t, decoder, frame(payload))
	if len(got) != 1 {
		t.Fatalf("got %d messages", len(got))
	}
	if len(got[0].Raw) != len(payload) {
		t.Errorf("Raw length = %d, want %d", len(got[0].Raw), len(payload))
	}
	if got[0].StructuredData[0].Params[0].Value != `\"]` {
		t.Errorf("unescaped value = %q", got[0].StructuredData[0].Params[0].Value)
	}
	if !got[0].BOM || got[0].Message != "text" {
		t.Errorf("BOM/body = %v/%q", got[0].BOM, got[0].Message)
	}
}

func TestDecoderHeaderRejectsImmediately(t *testing.T) {
	tests := []struct {
		name    string
		maximum int
		chunk   string
	}{
		{"first byte not digit", 100, "x"},
		{"length zero", 100, "0"},
		{"leading zero", 100, "01"},
		{"too many digits", 1_000_000_000, "1000000000"},
		{"over maximum before delimiter", 10, "11"},
		{"over nine digits maximum", 999_999_998, "999999999"},
		{"delimiter is not space", 100, "1\t"},
	}
	for _, test := range tests {
		decoder := dataeng.NewDecoder(test.maximum)
		if _, err := decoder.Feed([]byte(test.chunk)); err == nil {
			t.Errorf("%s: Feed(%q) unexpectedly succeeded", test.name, test.chunk)
		}
		if err := decoder.Finish(); err == nil {
			t.Errorf("%s: Finish unexpectedly succeeded after failure", test.name)
		}
	}

	decoder := dataeng.NewDecoder(999_999_999)
	if _, err := decoder.Feed([]byte("999999999")); err != nil {
		t.Errorf("nine-digit length rejected before its delimiter: %v", err)
	}
	if err := decoder.Finish(); !errors.Is(err, dataeng.ErrIncomplete) {
		t.Errorf("Finish after nine-digit prefix = %v, want ErrIncomplete", err)
	}
}

func TestDecoderFinishRequiresFrameBoundary(t *testing.T) {
	tests := []string{
		"1",
		"10",
		"10 ",
		"18 <134>1 - - - - - -"[:10],
	}
	for _, input := range tests {
		decoder := dataeng.NewDecoder(100)
		_, err := decoder.Feed([]byte(input))
		if err != nil {
			t.Errorf("Feed(%q): %v", input, err)
			continue
		}
		if err := decoder.Finish(); !errors.Is(err, dataeng.ErrIncomplete) {
			t.Errorf("Finish(%q) = %v, want ErrIncomplete", input, err)
		}
	}

	decoder := dataeng.NewDecoder(18)
	messages, err := decoder.Feed([]byte(frame(emptyPayload)))
	if err != nil || len(messages) != 1 {
		t.Fatalf("Feed complete frame = %d messages, %v", len(messages), err)
	}
	if err := decoder.Finish(); err != nil {
		t.Fatalf("Finish on boundary: %v", err)
	}
	if _, err := decoder.Feed([]byte("1 ")); !errors.Is(err, dataeng.ErrFinished) {
		t.Errorf("Feed after Finish = %v, want ErrFinished", err)
	}
}

func TestDecoderStopsAfterErrorAndKeepsDeliveredMessages(t *testing.T) {
	decoder := dataeng.NewDecoder(100)
	good := frame(emptyPayload)
	bad := "x"
	messages, err := decoder.Feed([]byte(good + bad))
	if err == nil {
		t.Fatal("expected an error")
	}
	if len(messages) != 1 {
		t.Fatalf("got %d messages, want 1", len(messages))
	}
	if string(messages[0].Raw) != emptyPayload {
		t.Errorf("delivered Raw = %q", messages[0].Raw)
	}

	if _, secondErr := decoder.Feed([]byte(good)); secondErr != err {
		t.Errorf("Feed after error = %v, want original error %v", secondErr, err)
	}
	if finishErr := decoder.Finish(); finishErr != err {
		t.Errorf("Finish after error = %v, want original error %v", finishErr, err)
	}
}

func TestFrameLengthCannotConsumeNextFrame(t *testing.T) {
	first := emptyPayload
	second := "<134>1 - host app proc msg [a b=\"x\"] body"
	nextFrame := frame(second)
	swallowedLength := len(first) + len(nextFrame)
	stream := decimalLength(swallowedLength) + " " + first + nextFrame

	decoder := dataeng.NewDecoder(1024)
	messages, err := decoder.Feed([]byte(stream))
	if err == nil {
		t.Fatal("expected an error for a payload containing two messages")
	}
	if len(messages) != 0 {
		t.Fatalf("got %d messages, want 0", len(messages))
	}
}

func TestFrameLengthCannotBeShort(t *testing.T) {
	first := emptyPayload
	shortened := first[:len(first)-1]
	stream := frame(shortened) + frame(first)

	decoder := dataeng.NewDecoder(1024)
	messages, err := decoder.Feed([]byte(stream))
	if err == nil {
		t.Fatal("expected an error for a truncated payload")
	}
	if len(messages) != 0 {
		t.Fatalf("got %d messages, want 0", len(messages))
	}
}

func TestDecoderLengthBoundaries(t *testing.T) {
	payload := emptyPayload
	decoder := dataeng.NewDecoder(len(payload))
	if got := feedAll(t, decoder, frame(payload)); len(got) != 1 {
		t.Fatalf("exact maximum produced %d messages", len(got))
	}

	decoder = dataeng.NewDecoder(len(payload) - 1)
	if _, err := decoder.Feed([]byte(frame(payload))); err == nil {
		t.Fatal("payload over maximum unexpectedly succeeded")
	}
}

func TestDecoderMultipleFramesInOneChunk(t *testing.T) {
	payloads := []string{
		emptyPayload,
		"<0>1 - - - - - -",
		"<8>1 - - - - - -",
		"<191>1 2000-02-29T23:59:59Z - - - - - snow",
	}
	var stream strings.Builder
	for _, payload := range payloads {
		stream.WriteString(frame(payload))
	}

	decoder := dataeng.NewDecoder(1024)
	messages := feedAll(t, decoder, stream.String())
	if len(messages) != len(payloads) {
		t.Fatalf("got %d messages, want %d", len(messages), len(payloads))
	}
	for i, message := range messages {
		if string(message.Raw) != payloads[i] {
			t.Errorf("message %d Raw = %q, want %q", i, message.Raw, payloads[i])
		}
	}
}

func FuzzDecoderDoesNotPanic(f *testing.F) {
	f.Add([]byte(frame(emptyPayload)), uint16(1024))
	f.Add([]byte("18 <134>1 - - - - - -"[:10]), uint16(32))
	f.Fuzz(func(t *testing.T, data []byte, maximum uint16) {
		decoder := dataeng.NewDecoder(int(maximum))
		_, _ = decoder.Feed(data)
		_ = decoder.Finish()
	})
}
