package dataeng_test

import (
	"bytes"
	"errors"
	"reflect"
	"strconv"
	"testing"

	"example.org/dataeng/q0366"
)

type header struct {
	name  string
	value string
}

func binaryFrame(channel byte, payload []byte) []byte {
	b := make([]byte, 4+len(payload))
	b[0] = 0x24
	b[1] = channel
	b[2] = byte(len(payload) >> 8)
	b[3] = byte(len(payload))
	copy(b[4:], payload)
	return b
}

func textStream(start string, headers []header, body []byte) []byte {
	b := []byte(start + "\r\n")
	for _, h := range headers {
		b = append(b, h.name...)
		b = append(b, ':')
		if h.value != "" {
			b = append(b, ' ')
		}
		b = append(b, h.value...)
		b = append(b, '\r', '\n')
	}
	b = append(b, '\r', '\n')
	b = append(b, body...)
	return b
}

func textWithLength(start string, headers []header, body []byte) []byte {
	h := append([]header(nil), headers...)
	h = append(h, header{name: "content-length", value: strconv.Itoa(len(body))})
	return textStream(start, h, body)
}

func expectedText(start string, headers map[string]string, body []byte) dataeng.Message {
	if headers == nil {
		headers = map[string]string{}
	}
	return dataeng.Message{
		Kind:      dataeng.TextMessage,
		StartLine: start,
		Headers:   headers,
		Body:      body,
	}
}

func expectedBinary(channel byte, payload []byte) dataeng.Message {
	return dataeng.Message{
		Kind:    dataeng.BinaryMessage,
		Channel: channel,
		Body:    payload,
	}
}

func appendParts(parts ...[]byte) []byte {
	var b []byte
	for _, part := range parts {
		b = append(b, part...)
	}
	return b
}

func assertMessages(t *testing.T, got, want []dataeng.Message) {
	t.Helper()
	if len(got) != len(want) {
		t.Fatalf("got %d messages, want %d\ngot: %#v\nwant: %#v", len(got), len(want), got, want)
	}
	for i := range want {
		if got[i].Kind != want[i].Kind {
			t.Fatalf("message %d kind = %v, want %v", i, got[i].Kind, want[i].Kind)
		}
		if got[i].Channel != want[i].Channel {
			t.Fatalf("message %d channel = %#x, want %#x", i, got[i].Channel, want[i].Channel)
		}
		if got[i].StartLine != want[i].StartLine {
			t.Fatalf("message %d start line = %q, want %q", i, got[i].StartLine, want[i].StartLine)
		}
		if !reflect.DeepEqual(got[i].Headers, want[i].Headers) {
			t.Fatalf("message %d headers = %#v, want %#v", i, got[i].Headers, want[i].Headers)
		}
		if !bytes.Equal(got[i].Body, want[i].Body) {
			t.Fatalf("message %d body = %q, want %q", i, got[i].Body, want[i].Body)
		}
	}
}

func parseStream(t *testing.T, maxFrame int, stream []byte, chunks ...int) ([]dataeng.Message, error) {
	t.Helper()
	d := dataeng.NewDecoder(maxFrame)
	var got []dataeng.Message
	offset := 0
	for offset < len(stream) {
		n := len(stream) - offset
		if len(chunks) > 0 {
			n = chunks[0]
			chunks = chunks[1:]
			if n > len(stream)-offset {
				n = len(stream) - offset
			}
		}
		messages, err := d.Push(stream[offset : offset+n])
		got = append(got, messages...)
		if err != nil {
			return got, err
		}
		offset += n
	}
	return got, d.Finish()
}

func TestTextBodyKeepsDollarBytes(t *testing.T) {
	body := []byte("a$\r\nb$")
	stream := appendParts(
		textWithLength("SEND", []header{{name: "destination", value: "/queue/a"}}, body),
		binaryFrame(9, []byte("x$y")),
	)
	want := []dataeng.Message{
		expectedText("SEND", map[string]string{
			"destination":    "/queue/a",
			"content-length": strconv.Itoa(len(body)),
		}, body),
		expectedBinary(9, []byte("x$y")),
	}

	got, err := parseStream(t, 1024, stream, 5, 7, 1, 2)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	assertMessages(t, got, want)
}

func TestDollarAtBoundaryStartsBinaryFrame(t *testing.T) {
	stream := appendParts(
		textStream("SEND", []header{{name: "receipt", value: "r1"}}, nil),
		binaryFrame(0xff, []byte{0x24, '$', '\r', '\n'}),
		textStream("MESSAGE", nil, nil),
	)
	want := []dataeng.Message{
		expectedText("SEND", map[string]string{"receipt": "r1"}, nil),
		expectedBinary(0xff, []byte{0x24, '$', '\r', '\n'}),
		expectedText("MESSAGE", map[string]string{}, nil),
	}

	got, err := parseStream(t, 1024, stream, 1, 1, 1, 1)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	assertMessages(t, got, want)
}

func TestDuplicateContentLengthStopsAfterDeliveredMessage(t *testing.T) {
	first := binaryFrame(3, []byte("first"))
	bad := textStream("SEND", []header{
		{name: "Content-Length", value: "0"},
		{name: "content-length", value: "0"},
	}, nil)
	d := dataeng.NewDecoder(32)

	got, err := d.Push(appendParts(first, bad))
	if !errors.Is(err, dataeng.ErrDuplicateContentLength) {
		t.Fatalf("error = %v, want ErrDuplicateContentLength", err)
	}
	assertMessages(t, got, []dataeng.Message{expectedBinary(3, []byte("first"))})
	assertMessages(t, d.Delivered(), []dataeng.Message{expectedBinary(3, []byte("first"))})

	more, err2 := d.Push(binaryFrame(4, []byte("later")))
	if len(more) != 0 || !errors.Is(err2, dataeng.ErrDuplicateContentLength) {
		t.Fatalf("after failure: messages=%#v error=%v", more, err2)
	}
	if err := d.Finish(); !errors.Is(err, dataeng.ErrDuplicateContentLength) {
		t.Fatalf("Finish error = %v, want sticky duplicate error", err)
	}
}

func TestFrameSplitAtEveryByte(t *testing.T) {
	payload := []byte{0x00, 0x24, 0xff, '\r', '\n', '$'}
	stream := binaryFrame(0x42, payload)
	want := []dataeng.Message{expectedBinary(0x42, payload)}

	for split := 0; split <= len(stream); split++ {
		d := dataeng.NewDecoder(64)
		var got []dataeng.Message
		messages, err := d.Push(stream[:split])
		got = append(got, messages...)
		if err != nil {
			t.Fatalf("split %d first half: %v", split, err)
		}
		messages, err = d.Push(stream[split:])
		got = append(got, messages...)
		if err != nil {
			t.Fatalf("split %d second half: %v", split, err)
		}
		if err := d.Finish(); err != nil {
			t.Fatalf("split %d Finish: %v", split, err)
		}
		assertMessages(t, got, want)
	}

	d := dataeng.NewDecoder(64)
	var got []dataeng.Message
	for i := range stream {
		messages, err := d.Push(stream[i : i+1])
		got = append(got, messages...)
		if err != nil {
			t.Fatalf("byte %d: %v", i, err)
		}
	}
	if err := d.Finish(); err != nil {
		t.Fatalf("Finish: %v", err)
	}
	assertMessages(t, got, want)
}

func TestTextBodySplitAtEveryByte(t *testing.T) {
	body := []byte("ab$c\r\nd$e")
	stream := textWithLength("SEND", []header{{name: "x", value: "y"}}, body)
	want := []dataeng.Message{expectedText("SEND", map[string]string{
		"x":              "y",
		"content-length": strconv.Itoa(len(body)),
	}, body)}

	for split := 0; split <= len(stream); split++ {
		d := dataeng.NewDecoder(1024)
		var got []dataeng.Message
		messages, err := d.Push(stream[:split])
		got = append(got, messages...)
		if err != nil {
			t.Fatalf("split %d first half: %v", split, err)
		}
		messages, err = d.Push(stream[split:])
		got = append(got, messages...)
		if err != nil {
			t.Fatalf("split %d second half: %v", split, err)
		}
		if err := d.Finish(); err != nil {
			t.Fatalf("split %d Finish: %v", split, err)
		}
		assertMessages(t, got, want)
	}
}

func TestMaxFrameRejectedAsSoonAsLengthIsReadable(t *testing.T) {
	d := dataeng.NewDecoder(4)
	if messages, err := d.Push([]byte{0x24, 0x01, 0x00}); err != nil || len(messages) != 0 {
		t.Fatalf("partial length: messages=%#v error=%v", messages, err)
	}

	messages, err := d.Push([]byte{0x05})
	if len(messages) != 0 || !errors.Is(err, dataeng.ErrFrameTooLarge) {
		t.Fatalf("oversize length: messages=%#v error=%v", messages, err)
	}
	if d.Delivered() != nil {
		t.Fatalf("no message should have been delivered")
	}
	if _, err := d.Push(binaryFrame(1, []byte("ok"))); !errors.Is(err, dataeng.ErrFrameTooLarge) {
		t.Fatalf("decoder did not stop: %v", err)
	}
	if err := d.Finish(); !errors.Is(err, dataeng.ErrFrameTooLarge) {
		t.Fatalf("Finish error = %v, want frame-too-large", err)
	}
}

func TestMaxFrameBoundaryAndZeroLengthFrame(t *testing.T) {
	payload := []byte{1, 2, 3, 4}
	stream := appendParts(binaryFrame(7, payload), binaryFrame(8, nil))
	want := []dataeng.Message{
		expectedBinary(7, payload),
		expectedBinary(8, nil),
	}
	got, err := parseStream(t, 4, stream, 1, 1, 1, 1, 1)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	assertMessages(t, got, want)
}

func TestFinishRejectsIncompleteMessages(t *testing.T) {
	frame := binaryFrame(1, []byte("abc"))
	for cut := 1; cut < len(frame); cut++ {
		d := dataeng.NewDecoder(16)
		if _, err := d.Push(frame[:cut]); err != nil {
			t.Fatalf("cut %d Push: %v", cut, err)
		}
		if err := d.Finish(); !errors.Is(err, dataeng.ErrIncomplete) {
			t.Fatalf("cut %d Finish = %v, want ErrIncomplete", cut, err)
		}
		if _, err := d.Push(binaryFrame(2, nil)); !errors.Is(err, dataeng.ErrIncomplete) {
			t.Fatalf("cut %d decoder did not stop: %v", cut, err)
		}
	}

	body := []byte("body$")
	text := textWithLength("SEND", nil, body)
	for cut := len(text) - len(body); cut < len(text); cut++ {
		d := dataeng.NewDecoder(16)
		if _, err := d.Push(text[:cut]); err != nil {
			t.Fatalf("body cut %d Push: %v", cut, err)
		}
		if err := d.Finish(); !errors.Is(err, dataeng.ErrIncomplete) {
			t.Fatalf("body cut %d Finish = %v, want ErrIncomplete", cut, err)
		}
	}

	d := dataeng.NewDecoder(16)
	if _, err := d.Push([]byte("SEND\r")); err != nil {
		t.Fatalf("Push: %v", err)
	}
	if err := d.Finish(); !errors.Is(err, dataeng.ErrIncomplete) {
		t.Fatalf("Finish = %v, want ErrIncomplete", err)
	}
}

func TestFinishAtBoundarySucceeds(t *testing.T) {
	d := dataeng.NewDecoder(16)
	if err := d.Finish(); err != nil {
		t.Fatalf("empty stream Finish: %v", err)
	}
	if err := d.Finish(); err != nil {
		t.Fatalf("second Finish: %v", err)
	}
	if _, err := d.Push(textStream("SEND", nil, nil)); !errors.Is(err, dataeng.ErrFinished) {
		t.Fatalf("Push after Finish = %v, want ErrFinished", err)
	}
}

func TestFinishIncompleteRetainsDeliveredMessages(t *testing.T) {
	first := binaryFrame(1, []byte("done"))
	body := []byte("partial")
	text := textWithLength("SEND", nil, body)
	d := dataeng.NewDecoder(32)

	got, err := d.Push(appendParts(first, text[:len(text)-len(body)+3]))
	if err != nil {
		t.Fatalf("Push: %v", err)
	}
	assertMessages(t, got, []dataeng.Message{expectedBinary(1, []byte("done"))})
	if err := d.Finish(); !errors.Is(err, dataeng.ErrIncomplete) {
		t.Fatalf("Finish = %v, want ErrIncomplete", err)
	}
	assertMessages(t, d.Delivered(), []dataeng.Message{expectedBinary(1, []byte("done"))})
}

func TestStrictUTF8ForStartLineAndHeaders(t *testing.T) {
	t.Run("start line", func(t *testing.T) {
		stream := append([]byte("SEND\xff\r\n"), []byte("x: y\r\n\r\n")...)
		if _, err := parseStream(t, 16, stream); !errors.Is(err, dataeng.ErrInvalidUTF8) {
			t.Fatalf("error = %v, want ErrInvalidUTF8", err)
		}
	})
	t.Run("header", func(t *testing.T) {
		stream := append([]byte("SEND\r\nx: \xff\r\n\r\n"), nil...)
		if _, err := parseStream(t, 16, stream); !errors.Is(err, dataeng.ErrInvalidUTF8) {
			t.Fatalf("error = %v, want ErrInvalidUTF8", err)
		}
	})
}

func TestLoneCRAndBareLFInText(t *testing.T) {
	t.Run("lone CR", func(t *testing.T) {
		if _, err := parseStream(t, 16, []byte("SEND\rX\r\n\r\n")); !errors.Is(err, dataeng.ErrLoneCR) {
			t.Fatalf("error = %v, want ErrLoneCR", err)
		}
	})
	t.Run("bare LF", func(t *testing.T) {
		if _, err := parseStream(t, 16, []byte("SEND\nX: y\r\n\r\n")); !errors.Is(err, dataeng.ErrBareLF) {
			t.Fatalf("error = %v, want ErrBareLF", err)
		}
	})
	t.Run("CR is raw in body", func(t *testing.T) {
		body := []byte{'\r', '$'}
		stream := appendParts(textWithLength("SEND", nil, body), binaryFrame(1, []byte{'\r'}))
		want := []dataeng.Message{
			expectedText("SEND", map[string]string{"content-length": "2"}, body),
			expectedBinary(1, []byte{'\r'}),
		}
		got, err := parseStream(t, 16, stream)
		if err != nil {
			t.Fatalf("unexpected error: %v", err)
		}
		assertMessages(t, got, want)
	})
}

func TestContentLengthMustBeCanonicalDecimal(t *testing.T) {
	invalid := []string{"", "00", "01", "-1", "+1", " 1", "1 ", "0x10", "1  ", "999999999999999999999999"}
	for _, value := range invalid {
		t.Run(value, func(t *testing.T) {
			stream := textStream("SEND", []header{{name: "content-length", value: value}}, nil)
			_, err := parseStream(t, 16, stream)
			if !errors.Is(err, dataeng.ErrInvalidContentLength) {
				t.Fatalf("value %q: error = %v, want ErrInvalidContentLength", value, err)
			}
		})
	}

	stream := textStream("SEND", []header{{name: "Content-Length", value: "0"}}, nil)
	got, err := parseStream(t, 16, stream)
	if err != nil {
		t.Fatalf("zero content-length: %v", err)
	}
	assertMessages(t, got, []dataeng.Message{
		expectedText("SEND", map[string]string{"content-length": "0"}, nil),
	})
}

func TestHeaderNamesAreLowercaseAndValuesPreserved(t *testing.T) {
	stream := appendParts(
		textStream("SEND /queue", []header{
			{name: "Content-Type", value: "application/json"},
			{name: "X-Empty", value: ""},
			{name: "X-Colon", value: "a:b"},
			{name: "X-OneSpace", value: "value"},
			{name: "X-TwoSpaces", value: " value"},
			{name: "X-Dollar", value: "$"},
			{name: "X-Dup", value: "one"},
			{name: "x-dup", value: "two"},
		}, nil),
		textStream("SEND2", nil, nil),
	)
	want := []dataeng.Message{
		expectedText("SEND /queue", map[string]string{
			"content-type": "application/json",
			"x-empty":      "",
			"x-colon":      "a:b",
			"x-onespace":   "value",
			"x-twospaces":  " value",
			"x-dollar":     "$",
			"x-dup":        "two",
		}, nil),
		expectedText("SEND2", map[string]string{}, nil),
	}

	got, err := parseStream(t, 16, stream, 3, 2, 1)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	assertMessages(t, got, want)
}

func TestOptionalSpaceAfterColon(t *testing.T) {
	raw := []byte("SEND\r\nX-NoSpace:value\r\nX-OneSpace: value\r\nX-Empty:\r\n\r\n")
	got, err := parseStream(t, 16, raw)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	assertMessages(t, got, []dataeng.Message{
		expectedText("SEND", map[string]string{
			"x-nospace":  "value",
			"x-onespace": "value",
			"x-empty":    "",
		}, nil),
	})
}

func TestMalformedHeader(t *testing.T) {
	streams := [][]byte{
		[]byte("SEND\r\nNoColon\r\n\r\n"),
		[]byte("SEND\r\n: value\r\n\r\n"),
	}
	for i, stream := range streams {
		if _, err := parseStream(t, 16, stream); !errors.Is(err, dataeng.ErrMalformedHeader) {
			t.Fatalf("stream %d error = %v, want ErrMalformedHeader", i, err)
		}
	}
}

func TestNoContentLengthMeansEmptyBodyAndNextMessageStartsImmediately(t *testing.T) {
	stream := appendParts(
		textStream("ONE", nil, nil),
		textStream("TWO", []header{{name: "a", value: "b"}}, nil),
		binaryFrame(0, []byte("$")),
	)
	want := []dataeng.Message{
		expectedText("ONE", map[string]string{}, nil),
		expectedText("TWO", map[string]string{"a": "b"}, nil),
		expectedBinary(0, []byte("$")),
	}
	got, err := parseStream(t, 16, stream)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	assertMessages(t, got, want)
}

func TestContentLengthStopsExactlyAtDeclaredByteCount(t *testing.T) {
	body := []byte("abc")
	stream := appendParts(
		textWithLength("SEND", nil, body),
		binaryFrame(5, []byte("$frame")),
		textStream("NEXT", nil, nil),
	)
	want := []dataeng.Message{
		expectedText("SEND", map[string]string{"content-length": "3"}, body),
		expectedBinary(5, []byte("$frame")),
		expectedText("NEXT", map[string]string{}, nil),
	}
	got, err := parseStream(t, 16, stream, 4, 4, 2, 2, 1)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	assertMessages(t, got, want)
}

func TestBinaryPayloadIsRawAndLengthIsBigEndian(t *testing.T) {
	payload := make([]byte, 258)
	for i := range payload {
		payload[i] = byte(i)
	}
	payload[0] = 0x24
	payload[1] = '\r'
	payload[2] = '\n'
	stream := binaryFrame(0x7f, payload)
	want := []dataeng.Message{expectedBinary(0x7f, payload)}

	got, err := parseStream(t, 258, stream, 1, 1, 1, 1, 10, 100)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	assertMessages(t, got, want)
}

func TestMixedStreamAtEverySplit(t *testing.T) {
	body := []byte("left$right")
	payload := []byte{0x24, 0x00, '\r', '\n', '$'}
	stream := appendParts(
		textWithLength("SEND", []header{{name: "X-Test", value: "one"}}, body),
		binaryFrame(6, payload),
		textStream("MESSAGE", []header{{name: "content-type", value: "text/plain"}}, nil),
	)
	want := []dataeng.Message{
		expectedText("SEND", map[string]string{
			"x-test":         "one",
			"content-length": strconv.Itoa(len(body)),
		}, body),
		expectedBinary(6, payload),
		expectedText("MESSAGE", map[string]string{"content-type": "text/plain"}, nil),
	}

	for split := 0; split <= len(stream); split++ {
		d := dataeng.NewDecoder(128)
		var got []dataeng.Message
		messages, err := d.Push(stream[:split])
		got = append(got, messages...)
		if err != nil {
			t.Fatalf("split %d first half: %v", split, err)
		}
		messages, err = d.Push(stream[split:])
		got = append(got, messages...)
		if err != nil {
			t.Fatalf("split %d second half: %v", split, err)
		}
		if err := d.Finish(); err != nil {
			t.Fatalf("split %d Finish: %v", split, err)
		}
		assertMessages(t, got, want)
	}
}

func TestInputBufferMayBeReused(t *testing.T) {
	body := []byte("body$")
	payload := []byte("$payload")
	var buf []byte
	d := dataeng.NewDecoder(128)
	var got []dataeng.Message

	buf = append(buf[:0], textWithLength("SEND", nil, body)...)
	messages, err := d.Push(buf)
	got = append(got, messages...)
	if err != nil {
		t.Fatalf("text Push: %v", err)
	}

	buf = append(buf[:0], binaryFrame(2, payload)...)
	messages, err = d.Push(buf)
	got = append(got, messages...)
	if err != nil {
		t.Fatalf("binary Push: %v", err)
	}
	if err := d.Finish(); err != nil {
		t.Fatalf("Finish: %v", err)
	}

	for i := range buf {
		buf[i] = 0xaa
	}
	assertMessages(t, got, []dataeng.Message{
		expectedText("SEND", map[string]string{"content-length": "5"}, body),
		expectedBinary(2, payload),
	})
}
