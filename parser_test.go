package dataeng_test

import (
	"errors"
	"reflect"
	"strings"
	"testing"

	"example.org/dataeng/q0328"
)

const emptyPayload = "<134>1 - - - - - -"

func frame(payload string) string {
	// Build the wire bytes without consulting the decoder under test. len on a
	// string counts raw bytes, including escapes and a UTF-8 BOM.
	return decimalLength(len(payload)) + " " + payload
}

func decimalLength(n int) string {
	if n < 0 {
		panic("negative length")
	}
	if n == 0 {
		return "0"
	}
	var digits [10]byte
	pos := len(digits)
	for n > 0 {
		pos--
		digits[pos] = byte('0' + n%10)
		n /= 10
	}
	return string(digits[pos:])
}

func feedAll(t *testing.T, decoder *dataeng.Decoder, chunks ...string) []dataeng.Message {
	t.Helper()
	var messages []dataeng.Message
	for _, chunk := range chunks {
		decoded, err := decoder.Feed([]byte(chunk))
		if err != nil {
			t.Fatalf("Feed(%q): %v", chunk, err)
		}
		messages = append(messages, decoded...)
	}
	if err := decoder.Finish(); err != nil {
		t.Fatalf("Finish: %v", err)
	}
	return messages
}

func TestParseEmptyMessage(t *testing.T) {
	if got, want := len(emptyPayload), 18; got != want {
		t.Fatalf("empty payload length = %d, want %d", got, want)
	}

	message, err := dataeng.ParseMessage([]byte(emptyPayload))
	if err != nil {
		t.Fatalf("ParseMessage: %v", err)
	}
	if message.PRI != 134 || message.Facility != 16 || message.Severity != 6 {
		t.Errorf("PRI/facility/severity = %d/%d/%d", message.PRI, message.Facility, message.Severity)
	}
	if message.Version != '1' {
		t.Errorf("Version = %q", message.Version)
	}
	if !message.Timestamp.Nil || message.Timestamp.Raw != "-" {
		t.Errorf("Timestamp = %+v", message.Timestamp)
	}
	if message.Host != "" || message.AppName != "" || message.ProcID != "" || message.MsgID != "" {
		t.Errorf("empty fields decoded as %q %q %q %q", message.Host, message.AppName, message.ProcID, message.MsgID)
	}
	if message.StructuredData != nil {
		t.Errorf("StructuredData = %#v", message.StructuredData)
	}
	if message.HasMessage || message.Message != "" || message.BOM {
		t.Errorf("message presence = %v/%q/%v", message.HasMessage, message.Message, message.BOM)
	}
	if string(message.Raw) != emptyPayload {
		t.Errorf("Raw = %q", message.Raw)
	}
}

func TestPRIBoundaries(t *testing.T) {
	valid := []struct {
		pri      int
		facility int
		severity int
	}{
		{0, 0, 0},
		{1, 0, 1},
		{7, 0, 7},
		{8, 1, 0},
		{134, 16, 6},
		{191, 23, 7},
	}
	for _, test := range valid {
		payload := "<" + decimalLength(test.pri) + ">1 - - - - - -"
		message, err := dataeng.ParseMessage([]byte(payload))
		if err != nil {
			t.Errorf("PRI %d: %v", test.pri, err)
			continue
		}
		if message.PRI != test.pri || message.Facility != test.facility || message.Severity != test.severity {
			t.Errorf("PRI %d decoded as %d/%d/%d", test.pri, message.PRI, message.Facility, message.Severity)
		}
	}

	invalid := []string{
		"<00>1 - - - - - -",
		"<000>1 - - - - - -",
		"<0000>1 - - - - - -",
		"<192>1 - - - - - -",
		"<999>1 - - - - - -",
		"<>1 - - - - - -",
		"<x>1 - - - - - -",
		"<12x>1 - - - - - -",
	}
	for _, payload := range invalid {
		if _, err := dataeng.ParseMessage([]byte(payload)); err == nil {
			t.Errorf("ParseMessage(%q) unexpectedly succeeded", payload)
		}
	}
}

func TestTimestamp(t *testing.T) {
	type expectation struct {
		nilTimestamp bool
		year, month  int
		day          int
		hour, minute int
		second       int
		fraction     string
		zone         string
	}
	valid := []struct {
		timestamp string
		want      expectation
	}{
		{"-", expectation{nilTimestamp: true}},
		{"2000-02-29T23:59:59Z", expectation{year: 2000, month: 2, day: 29, hour: 23, minute: 59, second: 59, zone: "Z"}},
		{"0000-02-29T00:00:00.1Z", expectation{year: 0, month: 2, day: 29, fraction: "1", zone: "Z"}},
		{"2024-01-02T03:04:05.123456+05:30", expectation{year: 2024, month: 1, day: 2, hour: 3, minute: 4, second: 5, fraction: "123456", zone: "+05:30"}},
		{"2024-01-02T03:04:05+00:00", expectation{year: 2024, month: 1, day: 2, hour: 3, minute: 4, second: 5, zone: "+00:00"}},
		{"2024-01-02T03:04:05-00:00", expectation{year: 2024, month: 1, day: 2, hour: 3, minute: 4, second: 5, zone: "-00:00"}},
		{"2400-02-29T12:00:00.000001-11:45", expectation{year: 2400, month: 2, day: 29, hour: 12, fraction: "000001", zone: "-11:45"}},
	}
	for _, test := range valid {
		payload := "<134>1 " + test.timestamp + " - - - - -"
		message, err := dataeng.ParseMessage([]byte(payload))
		if err != nil {
			t.Errorf("timestamp %q: %v", test.timestamp, err)
			continue
		}
		got := message.Timestamp
		if got.Raw != test.timestamp || got.Nil != test.want.nilTimestamp {
			t.Errorf("timestamp %q raw/nil = %q/%v", test.timestamp, got.Raw, got.Nil)
		}
		if test.want.nilTimestamp {
			continue
		}
		if got.Year != test.want.year || got.Month != test.want.month || got.Day != test.want.day ||
			got.Hour != test.want.hour || got.Minute != test.want.minute || got.Second != test.want.second ||
			got.Fraction != test.want.fraction || got.Zone != test.want.zone {
			t.Errorf("timestamp %q decoded as %+v", test.timestamp, got)
		}
	}

	invalid := []string{
		"1900-02-29T00:00:00Z",
		"2100-02-29T00:00:00Z",
		"2023-02-29T00:00:00Z",
		"2024-04-31T00:00:00Z",
		"2024-13-01T00:00:00Z",
		"2024-00-01T00:00:00Z",
		"2024-01-00T00:00:00Z",
		"2024-01-01T24:00:00Z",
		"2024-01-01T23:60:00Z",
		"2024-01-01T23:59:60Z",
		"2024-01-01T23:59:59.Z",
		"2024-01-01T23:59:59.1234567Z",
		"2024-01-01T23:59:59+24:00",
		"2024-01-01T23:59:59+00:60",
		"2024-01-01T23:59:59z",
		"2024-01-01T23:59:59",
		"2024-01-01 23:59:59Z",
	}
	for _, timestamp := range invalid {
		payload := "<134>1 " + timestamp + " - - - - -"
		if _, err := dataeng.ParseMessage([]byte(payload)); err == nil {
			t.Errorf("timestamp %q unexpectedly succeeded", timestamp)
		}
	}
}

func TestFields(t *testing.T) {
	host := strings.Repeat("h", 255)
	app := strings.Repeat("a", 48)
	proc := strings.Repeat("p", 128)
	msgid := strings.Repeat("m", 32)
	payload := "<134>1 - " + host + " " + app + " " + proc + " " + msgid + " -"
	message, err := dataeng.ParseMessage([]byte(payload))
	if err != nil {
		t.Fatalf("maximum-length fields: %v", err)
	}
	if message.Host != host || message.AppName != app || message.ProcID != proc || message.MsgID != msgid {
		t.Errorf("maximum-length fields decoded incorrectly")
	}

	invalid := []struct {
		name    string
		payload string
	}{
		{"host too long", "<134>1 - " + host + "h - - - -"},
		{"app too long", "<134>1 - - " + app + "a - - -"},
		{"procid too long", "<134>1 - - - " + proc + "p - -"},
		{"msgid too long", "<134>1 - - - - " + msgid + "m -"},
		{"empty host", "<134>1 -  - - - - -"},
		{"control in host", "<134>1 - x\x1fy - - - -"},
		{"DEL in host", "<134>1 - x\x7fy - - - -"},
		{"non-ASCII in host", "<134>1 - \xc3\xa9 - - - -"},
		{"tab in app", "<134>1 - - x\ty - - -"},
	}
	for _, test := range invalid {
		if _, err := dataeng.ParseMessage([]byte(test.payload)); err == nil {
			t.Errorf("%s unexpectedly succeeded", test.name)
		}
	}

	payload = "<134>1 - -- - - - -"
	message, err = dataeng.ParseMessage([]byte(payload))
	if err != nil {
		t.Fatalf("double dash must be a non-empty host: %v", err)
	}
	if message.Host != "--" {
		t.Errorf("host = %q, want --", message.Host)
	}
}

func TestStructuredDataEscapesAndDuplicates(t *testing.T) {
	sd := `[one first="1\\2\"3\]4" second="" first="duplicate"][two empty=""]`
	payload := "<134>1 - host app proc msgid " + sd
	message, err := dataeng.ParseMessage([]byte(payload))
	if err != nil {
		t.Fatalf("ParseMessage: %v", err)
	}

	want := []dataeng.SDElement{
		{
			ID: "one",
			Params: []dataeng.SDParam{
				{Name: "first", Value: `1\2"3]4`},
				{Name: "second", Value: ""},
				{Name: "first", Value: "duplicate"},
			},
		},
		{ID: "two", Params: []dataeng.SDParam{{Name: "empty", Value: ""}}},
	}
	if !reflect.DeepEqual(message.StructuredData, want) {
		t.Errorf("StructuredData = %#v, want %#v", message.StructuredData, want)
	}
}

func TestStructuredDataLimitsAndSyntax(t *testing.T) {
	id32 := strings.Repeat("i", 32)
	name32 := strings.Repeat("n", 32)
	valid := []string{
		"-",
		"[id]",
		"[" + id32 + "]",
		"[id " + name32 + `="value"]`,
		`[a b="x" a="y"]`,
		"[a][b empty=\"\"]",
		`[a b="雪"]`,
	}
	for _, sd := range valid {
		payload := "<134>1 - - - - - " + sd
		if _, err := dataeng.ParseMessage([]byte(payload)); err != nil {
			t.Errorf("structured data %q: %v", sd, err)
		}
	}

	invalid := []string{
		"",
		"--",
		"[]",
		"[" + id32 + "i]",
		"[a " + name32 + "n=\"x\"]",
		"[a=b]",
		"[a\"b]",
		"[a b]",
		"[a b=c]",
		`[a b="x"c="y"]`,
		`[a b="x" ]`,
		`[a b="x"`,
		`[a b="x"]x`,
		`[a b="x\q"]`,
		`[a b="x\"]`,
		`[a b="]"]`,
		`[a b="` + "\x01" + `"]`,
		"[a b=\"\xff\"]",
	}
	for _, sd := range invalid {
		payload := "<134>1 - - - - - " + sd
		if _, err := dataeng.ParseMessage([]byte(payload)); err == nil {
			t.Errorf("structured data %q unexpectedly succeeded", sd)
		}
	}
}

func TestMessagePresenceBOMAndUTF8(t *testing.T) {
	base := "<134>1 - - - - - -"
	tests := []struct {
		name       string
		payload    string
		hasMessage bool
		bom        bool
		body       string
	}{
		{"absent", base, false, false, ""},
		{"empty", base + " ", true, false, ""},
		{"BOM only", base + " \xef\xbb\xbf", true, true, ""},
		{"BOM text", base + " \xef\xbb\xbfhello", true, true, "hello"},
		{"text", base + " hello", true, false, "hello"},
		{"UTF-8 text", base + " 雪", true, false, "雪"},
		{"BOM in middle", base + " a\xef\xbb\xbfb", true, false, "a\xef\xbb\xbfb"},
	}
	for _, test := range tests {
		message, err := dataeng.ParseMessage([]byte(test.payload))
		if err != nil {
			t.Errorf("%s: %v", test.name, err)
			continue
		}
		if message.HasMessage != test.hasMessage || message.BOM != test.bom || message.Message != test.body {
			t.Errorf("%s: got presence/BOM/body %v/%v/%q", test.name, message.HasMessage, message.BOM, message.Message)
		}
	}

	for _, body := range []string{"\x00", "\x01", "\x1f", "\xff", "\xc3"} {
		payload := base + " " + body
		if _, err := dataeng.ParseMessage([]byte(payload)); err == nil {
			t.Errorf("body %q unexpectedly succeeded", body)
		}
	}
}

func TestPayloadMustBeExact(t *testing.T) {
	valid := "<134>1 - - - - - -"
	invalid := []string{
		valid + "x",
		valid + "\n",
		"<134>1 - - - - -",
		"<134>1 - - - - - --",
		"<134>2 - - - - - -",
		"<134>1 - - - - - - " + "\xff",
	}
	for _, payload := range invalid {
		if _, err := dataeng.ParseMessage([]byte(payload)); err == nil {
			t.Errorf("payload %q unexpectedly succeeded", payload)
		}
	}
}

func TestParseErrorIsReportable(t *testing.T) {
	_, err := dataeng.ParseMessage([]byte("<134>1 2024-13-01T00:00:00Z - - - - -"))
	if err == nil {
		t.Fatal("expected an error")
	}
	var parseErr *dataeng.ParseError
	if !errors.As(err, &parseErr) {
		t.Fatalf("error type = %T, want *ParseError", err)
	}
	if parseErr.Offset <= 0 {
		t.Errorf("offset = %d", parseErr.Offset)
	}
}

func FuzzParseMessageDoesNotPanic(f *testing.F) {
	f.Add([]byte(emptyPayload))
	f.Add([]byte("<191>1 2000-02-29T23:59:59.123456-00:00 - - - - [a b=\"x\"] body"))
	f.Add([]byte(`<134>1 - - - - - [a b="\\\"]"]`))
	f.Fuzz(func(t *testing.T, payload []byte) {
		_, _ = dataeng.ParseMessage(payload)
	})
}
