package dataeng

import (
	"encoding/binary"
	"errors"
	"math"
	"testing"
	"time"
)

// Packet builders used by every test. They only encode wire bytes; expected
// records below are hand-written literals rather than produced by the
// Collector under test.

func part(typ uint16, body []byte) []byte {
	out := make([]byte, 4+len(body))
	binary.BigEndian.PutUint16(out[0:2], typ)
	binary.BigEndian.PutUint16(out[2:4], uint16(4+len(body)))
	copy(out[4:], body)
	return out
}

func rawPart(typ, length uint16, body []byte) []byte {
	out := make([]byte, 4+len(body))
	binary.BigEndian.PutUint16(out[0:2], typ)
	binary.BigEndian.PutUint16(out[2:4], length)
	copy(out[4:], body)
	return out
}

func stringPart(typ uint16, s string) []byte {
	return part(typ, append([]byte(s), 0x00))
}

func be64(v uint64) []byte {
	b := make([]byte, 8)
	binary.BigEndian.PutUint64(b, v)
	return b
}

func le64(v uint64) []byte {
	b := make([]byte, 8)
	binary.LittleEndian.PutUint64(b, v)
	return b
}

func timePart(seconds uint64) []byte {
	return part(partTime, be64(seconds))
}

func intervalPart(seconds uint64) []byte {
	return part(partInterval, be64(seconds))
}

func metric(kind ValueKind, raw []byte) []byte {
	return append([]byte{byte(kind)}, raw...)
}

func valuesPart(values ...[]byte) []byte {
	body := make([]byte, 2)
	binary.BigEndian.PutUint16(body, uint16(len(values)))
	for _, value := range values {
		body = append(body, value...)
	}
	return part(partValues, body)
}

func concat(parts ...[]byte) []byte {
	var out []byte
	for _, p := range parts {
		out = append(out, p...)
	}
	return out
}

func collect(t *testing.T, maxPart int, packets ...[]byte) []Record {
	t.Helper()
	var got []Record
	c := NewCollector(maxPart, func(r Record) error {
		got = append(got, r)
		return nil
	})
	for _, packet := range packets {
		if err := c.Push(packet); err != nil {
			t.Fatalf("Push failed: %v", err)
		}
	}
	if err := c.Finish(); err != nil {
		t.Fatalf("Finish failed: %v", err)
	}
	return got
}

func durationPtr(d time.Duration) *time.Duration {
	return &d
}

func recordsEqual(got, want Record) bool {
	if got.Host != want.Host || got.Plugin != want.Plugin ||
		got.PluginInstance != want.PluginInstance ||
		got.TypeName != want.TypeName || got.TypeInstance != want.TypeInstance ||
		!got.Time.Equal(want.Time) {
		return false
	}
	if (got.Interval == nil) != (want.Interval == nil) {
		return false
	}
	if got.Interval != nil && *got.Interval != *want.Interval {
		return false
	}
	if len(got.Values) != len(want.Values) {
		return false
	}
	for i := range got.Values {
		if got.Values[i] != want.Values[i] {
			return false
		}
	}
	return true
}

func TestDeliversRecordWithAllValueKinds(t *testing.T) {
	var derive int64 = -7
	negativeDerive := uint64(derive)
	packet := concat(
		stringPart(partHost, "host-1"),
		timePart(1_700_000_000),
		stringPart(partPlugin, "cpu"),
		stringPart(partPluginInstance, "core-0"),
		stringPart(partTypeName, "usage"),
		stringPart(partTypeInstance, "user"),
		intervalPart(10),
		valuesPart(
			metric(KindCounter, be64(42)),
			metric(KindGauge, le64(math.Float64bits(3.5))),
			metric(KindDerive, be64(negativeDerive)),
			metric(KindAbsolute, be64(99)),
		),
	)

	got := collect(t, 1024, packet)

	want := Record{
		Host:           "host-1",
		Time:           time.Unix(1_700_000_000, 0).UTC(),
		Plugin:         "cpu",
		PluginInstance: "core-0",
		TypeName:       "usage",
		TypeInstance:   "user",
		Interval:       durationPtr(10 * time.Second),
		Values: []Value{
			{Kind: KindCounter, U64: 42},
			{Kind: KindGauge, Float: 3.5},
			{Kind: KindDerive, I64: -7},
			{Kind: KindAbsolute, U64: 99},
		},
	}
	if len(got) != 1 {
		t.Fatalf("delivered %d records, want 1", len(got))
	}
	if !recordsEqual(got[0], want) {
		t.Fatalf("record mismatch:\n got %+v\nwant %+v", got[0], want)
	}
}

func TestPushAcceptsPartsSplitAtEveryBoundary(t *testing.T) {
	packet := concat(
		stringPart(partHost, "host"),
		timePart(555),
		stringPart(partPlugin, "plug"),
		stringPart(partPluginInstance, "pi"),
		stringPart(partTypeName, "type"),
		valuesPart(
			metric(KindCounter, be64(7)),
			metric(KindAbsolute, be64(8)),
		),
	)

	want := Record{
		Host: "host", Time: time.Unix(555, 0).UTC(),
		Plugin: "plug", PluginInstance: "pi",
		TypeName: "type", Interval: nil,
		Values: []Value{
			{Kind: KindCounter, U64: 7},
			{Kind: KindAbsolute, U64: 8},
		},
	}

	for cut := 1; cut < len(packet); cut++ {
		var got []Record
		c := NewCollector(1024, func(r Record) error {
			got = append(got, r)
			return nil
		})
		if err := c.Push(packet[:cut]); err != nil {
			t.Fatalf("cut %d first Push failed: %v", cut, err)
		}
		if err := c.Push(packet[cut:]); err != nil {
			t.Fatalf("cut %d second Push failed: %v", cut, err)
		}
		if err := c.Finish(); err != nil {
			t.Fatalf("cut %d Finish failed: %v", cut, err)
		}
		if len(got) != 1 || !recordsEqual(got[0], want) {
			t.Fatalf("cut %d record mismatch: %+v", cut, got)
		}
	}

	t.Run("byte by byte", func(t *testing.T) {
		var got []Record
		c := NewCollector(1024, func(r Record) error {
			got = append(got, r)
			return nil
		})
		for _, b := range packet {
			if err := c.Push([]byte{b}); err != nil {
				t.Fatalf("byte Push failed: %v", err)
			}
		}
		if err := c.Finish(); err != nil {
			t.Fatalf("Finish failed: %v", err)
		}
		if len(got) != 1 || !recordsEqual(got[0], want) {
			t.Fatalf("byte-by-byte record mismatch: %+v", got)
		}
	})
}

func TestFinishFailsOnUnfinishedPart(t *testing.T) {
	full := stringPart(partHost, "host")
	c := NewCollector(1024, func(Record) error {
		t.Fatal("partial part must not deliver")
		return nil
	})
	if err := c.Push(full[:len(full)-1]); err != nil {
		t.Fatalf("partial Push should be buffered, got %v", err)
	}
	if err := c.Finish(); !errors.Is(err, errUnfinishedPart) {
		t.Fatalf("Finish err = %v, want errUnfinishedPart", err)
	}
	if err := c.Finish(); !errors.Is(err, errUnfinishedPart) {
		t.Fatalf("second Finish err = %v, want the same failure", err)
	}
	if err := c.Push(full[len(full)-1:]); !errors.Is(err, errUnfinishedPart) {
		t.Fatalf("Push after failure err = %v, want the same failure", err)
	}
}

func TestIntervalIsOptionalAndSticksUntilChanged(t *testing.T) {
	packet := concat(
		stringPart(partHost, "h"), timePart(10),
		stringPart(partPlugin, "p"), stringPart(partTypeName, "t"),
		valuesPart(metric(KindCounter, be64(1))),
		intervalPart(30),
		valuesPart(metric(KindCounter, be64(2))),
		valuesPart(metric(KindCounter, be64(3))),
	)
	got := collect(t, 1024, packet)

	if got[0].Interval != nil {
		t.Fatalf("first record should have no interval, got %v", *got[0].Interval)
	}
	for i := 1; i < 3; i++ {
		if got[i].Interval == nil || *got[i].Interval != 30*time.Second {
			t.Fatalf("record %d interval = %v, want 30s", i, got[i].Interval)
		}
	}
	if got[2].Values[0].U64 != 3 {
		t.Fatalf("last value = %d, want 3", got[2].Values[0].U64)
	}
}

func TestFailureStopsComponentAndKeepsDeliveredRecords(t *testing.T) {
	good := concat(
		stringPart(partHost, "h"), timePart(1),
		stringPart(partPlugin, "p"), stringPart(partTypeName, "t"),
		valuesPart(metric(KindCounter, be64(1))),
	)
	unknown := rawPart(99, 4, nil)

	var deliveries int
	c := NewCollector(1024, func(Record) error {
		deliveries++
		return nil
	})
	if err := c.Push(good); err != nil {
		t.Fatalf("good packet failed: %v", err)
	}
	if err := c.Push(unknown); !errors.Is(err, errUnknownPart) {
		t.Fatalf("unknown part err = %v, want errUnknownPart", err)
	}
	if err := c.Push(good); !errors.Is(err, errUnknownPart) {
		t.Fatalf("Push after failure err = %v, want the original failure", err)
	}
	if err := c.Finish(); !errors.Is(err, errUnknownPart) {
		t.Fatalf("Finish after failure err = %v, want the original failure", err)
	}
	if deliveries != 1 || len(c.Delivered()) != 1 {
		t.Fatalf("deliveries=%d retained=%d, want 1/1", deliveries, len(c.Delivered()))
	}
	if !errors.Is(c.Err(), errUnknownPart) {
		t.Fatalf("Err = %v, want errUnknownPart", c.Err())
	}
}

func TestCallbackErrorStopsComponent(t *testing.T) {
	boom := errors.New("callback boom")
	c := NewCollector(1024, func(Record) error {
		return boom
	})
	packet := concat(
		stringPart(partHost, "h"), timePart(1),
		stringPart(partPlugin, "p"), stringPart(partTypeName, "t"),
		valuesPart(metric(KindCounter, be64(1))),
	)
	if err := c.Push(packet); !errors.Is(err, boom) {
		t.Fatalf("err = %v, want callback error", err)
	}
	if len(c.Delivered()) != 0 {
		t.Fatalf("failed delivery must not be retained, got %d records", len(c.Delivered()))
	}
}

func TestRejectsMalformedParts(t *testing.T) {
	context := func(extra []byte) []byte {
		return concat(
			stringPart(partHost, "h"), timePart(1),
			stringPart(partPlugin, "p"), stringPart(partTypeName, "t"),
			extra,
		)
	}

	cases := map[string]struct {
		packet []byte
		want   error
	}{
		"length smaller than header": {
			rawPart(partHost, 3, nil), errPartTooShort,
		},
		"length zero": {
			rawPart(partHost, 0, nil), errPartTooShort,
		},
		"unknown part type": {
			rawPart(8, 4, nil), errUnknownPart,
		},
		"string without terminator": {
			part(partHost, []byte("abc")), errStringTerminator,
		},
		"empty string part": {
			part(partHost, nil), errStringTerminator,
		},
		"embedded NUL": {
			part(partHost, []byte{'a', 0x00, 'b', 0x00}), errStringNUL,
		},
		"invalid UTF-8": {
			part(partHost, []byte{0xff, 0xfe, 0x00}), errStringUTF8,
		},
		"time wrong length": {
			part(partTime, be64(1)[:4]), errBadTimeLength,
		},
		"interval wrong length": {
			part(partInterval, be64(1)[:4]), errBadIntervalLength,
		},
		"values count zero": {
			part(partValues, []byte{0x00, 0x00}), errEmptyValues,
		},
		"values body too short for count": {
			part(partValues, []byte{0x00, 0x01, 0x00}), errBadValuesLength,
		},
		"values body longer than declared": {
			part(partValues, append(append([]byte{0x00, 0x01, byte(KindCounter)}, be64(1)...), 0x00)), errBadValuesLength,
		},
		"unknown value kind": {
			context(part(partValues, append([]byte{0x00, 0x01, 9}, be64(1)...))), errUnknownKind,
		},
	}

	for name, tc := range cases {
		t.Run(name, func(t *testing.T) {
			c := NewCollector(1024, func(Record) error {
				t.Fatal("malformed part must not deliver a record")
				return nil
			})
			err := c.Push(tc.packet)
			if !errors.Is(err, tc.want) {
				t.Fatalf("err = %v, want %v", err, tc.want)
			}
			if c.Err() == nil {
				t.Fatal("component must be stopped after failure")
			}
		})
	}
}

func TestOverlongPartRejectedBeforeBodiesArrive(t *testing.T) {
	// Header declares 20 bytes while maxPart is 12; reject on Push even though
	// only the 4-byte header is currently available, and never wait for the
	// declared payload.
	header := rawPart(partHost, 20, nil)
	c := NewCollector(12, func(Record) error {
		t.Fatal("overlong part must not deliver")
		return nil
	})
	if err := c.Push(header); !errors.Is(err, errPartTooLong) {
		t.Fatalf("err = %v, want errPartTooLong", err)
	}
}

func TestMultipleGroupsAndPartsInOnePush(t *testing.T) {
	first := concat(
		stringPart(partHost, "h1"), timePart(100),
		stringPart(partPlugin, "p1"), stringPart(partTypeName, "t1"),
		valuesPart(metric(KindCounter, be64(11))),
	)
	second := concat(
		stringPart(partHost, "h2"), timePart(200),
		stringPart(partPlugin, "p2"), stringPart(partTypeName, "t2"),
		valuesPart(metric(KindGauge, le64(math.Float64bits(2.5)))),
	)
	got := collect(t, 1024, append(first, second...))

	if len(got) != 2 {
		t.Fatalf("delivered %d records, want 2", len(got))
	}
	if got[0].Host != "h1" || got[0].Values[0].U64 != 11 {
		t.Fatalf("first record mismatch: %+v", got[0])
	}
	if got[1].Host != "h2" || got[1].Values[0].Float != 2.5 {
		t.Fatalf("second record mismatch: %+v", got[1])
	}
}

func TestValidMultibyteUTF8String(t *testing.T) {
	packet := concat(
		stringPart(partHost, "主机-α"),
		timePart(1), stringPart(partPlugin, "p"), stringPart(partTypeName, "t"),
		valuesPart(metric(KindCounter, be64(1))),
	)
	got := collect(t, 1024, packet)
	if got[0].Host != "主机-α" {
		t.Fatalf("host = %q, want 主机-α", got[0].Host)
	}
}

func TestFinishWithoutAnyPartsSucceeds(t *testing.T) {
	c := NewCollector(1024, nil)
	if err := c.Push(nil); err != nil {
		t.Fatalf("empty Push failed: %v", err)
	}
	if err := c.Finish(); err != nil {
		t.Fatalf("Finish failed: %v", err)
	}
}

func TestNewPluginClearsPluginInstance(t *testing.T) {
	packet := concat(
		stringPart(partHost, "h"),
		timePart(100),
		stringPart(partPlugin, "plugin-a"),
		stringPart(partPluginInstance, "instance-a"),
		stringPart(partTypeName, "metric"),
		valuesPart(metric(KindCounter, be64(1))),
		stringPart(partPlugin, "plugin-b"),
		valuesPart(metric(KindCounter, be64(2))),
	)

	got := collect(t, 1024, packet)

	want := []Record{
		{
			Host: "h", Time: time.Unix(100, 0).UTC(),
			Plugin: "plugin-a", PluginInstance: "instance-a",
			TypeName: "metric", Interval: nil,
			Values: []Value{{Kind: KindCounter, U64: 1}},
		},
		{
			Host: "h", Time: time.Unix(100, 0).UTC(),
			Plugin: "plugin-b", PluginInstance: "",
			TypeName: "metric", Interval: nil,
			Values: []Value{{Kind: KindCounter, U64: 2}},
		},
	}
	if len(got) != len(want) {
		t.Fatalf("delivered %d records, want %d", len(got), len(want))
	}
	for i := range want {
		if !recordsEqual(got[i], want[i]) {
			t.Fatalf("record %d mismatch:\n got %+v\nwant %+v", i, got[i], want[i])
		}
	}
}

func TestRepeatedPluginKeepsInstanceAndNewTypeClearsTypeInstance(t *testing.T) {
	packet := concat(
		stringPart(partHost, "h"),
		timePart(100),
		stringPart(partPlugin, "p"),
		stringPart(partPluginInstance, "pi"),
		stringPart(partTypeName, "t1"),
		stringPart(partTypeInstance, "ti"),
		valuesPart(metric(KindAbsolute, be64(1))),
		stringPart(partPlugin, "p"),
		valuesPart(metric(KindAbsolute, be64(2))),
		stringPart(partTypeName, "t2"),
		valuesPart(metric(KindAbsolute, be64(3))),
	)

	got := collect(t, 1024, packet)

	if got[0].PluginInstance != "pi" || got[0].TypeInstance != "ti" {
		t.Fatalf("first record lost context: %+v", got[0])
	}
	if got[1].PluginInstance != "pi" {
		t.Fatalf("repeated plugin cleared instance: got %q", got[1].PluginInstance)
	}
	if got[1].TypeInstance != "ti" {
		t.Fatalf("type instance changed unexpectedly: got %q", got[1].TypeInstance)
	}
	if got[2].PluginInstance != "pi" {
		t.Fatalf("plugin instance lost after type switch: got %q", got[2].PluginInstance)
	}
	if got[2].TypeInstance != "" {
		t.Fatalf("new type kept old type instance: got %q", got[2].TypeInstance)
	}
}

func TestGaugeRequiresLittleEndianAndFinite(t *testing.T) {
	bits := math.Float64bits(3.5)

	t.Run("little endian accepted", func(t *testing.T) {
		packet := concat(
			stringPart(partHost, "h"), timePart(1),
			stringPart(partPlugin, "p"), stringPart(partTypeName, "t"),
			valuesPart(metric(KindGauge, le64(bits))),
		)
		got := collect(t, 1024, packet)
		if got[0].Values[0].Float != 3.5 {
			t.Fatalf("little-endian gauge = %v, want 3.5", got[0].Values[0].Float)
		}
	})

	t.Run("big endian decodes to the wrong value", func(t *testing.T) {
		packet := concat(
			stringPart(partHost, "h"), timePart(1),
			stringPart(partPlugin, "p"), stringPart(partTypeName, "t"),
			valuesPart(metric(KindGauge, be64(bits))),
		)
		got := collect(t, 1024, packet)
		if got[0].Values[0].Float == 3.5 {
			t.Fatalf("big-endian gauge was accepted as 3.5; endianness not enforced")
		}
	})

	for name, raw := range map[string][]byte{
		"+inf": le64(math.Float64bits(math.Inf(1))),
		"nan":  le64(math.Float64bits(math.NaN())),
	} {
		t.Run(name+" rejected", func(t *testing.T) {
			packet := concat(
				stringPart(partHost, "h"), timePart(1),
				stringPart(partPlugin, "p"), stringPart(partTypeName, "t"),
				valuesPart(metric(KindGauge, raw)),
			)
			c := NewCollector(1024, func(Record) error {
				t.Fatal("non-finite gauge must not be delivered")
				return nil
			})
			if err := c.Push(packet); !errors.Is(err, errNonFiniteGauge) {
				t.Fatalf("err = %v, want errNonFiniteGauge", err)
			}
		})
	}
}

func TestValuesBeforeTypeNameFails(t *testing.T) {
	packet := concat(
		stringPart(partHost, "h"),
		timePart(1),
		stringPart(partPlugin, "p"),
		valuesPart(metric(KindCounter, be64(1))),
	)
	c := NewCollector(1024, func(Record) error {
		t.Fatal("record delivered without type name")
		return nil
	})
	if err := c.Push(packet); !errors.Is(err, errMissingContext) {
		t.Fatalf("err = %v, want errMissingContext", err)
	}
	if len(c.Delivered()) != 0 {
		t.Fatalf("delivered %d records after failure", len(c.Delivered()))
	}
}

func TestMissingContextTable(t *testing.T) {
	values := valuesPart(metric(KindCounter, be64(1)))
	cases := map[string][][]byte{
		"no host": {
			timePart(1), stringPart(partPlugin, "p"), stringPart(partTypeName, "t"), values,
		},
		"no time": {
			stringPart(partHost, "h"), stringPart(partPlugin, "p"), stringPart(partTypeName, "t"), values,
		},
		"no plugin": {
			stringPart(partHost, "h"), timePart(1), stringPart(partTypeName, "t"), values,
		},
	}
	for name, parts := range cases {
		t.Run(name, func(t *testing.T) {
			c := NewCollector(1024, func(Record) error {
				t.Fatal("record delivered with missing context")
				return nil
			})
			packet := concat(parts...)
			if err := c.Push(packet); !errors.Is(err, errMissingContext) {
				t.Fatalf("err = %v, want errMissingContext", err)
			}
		})
	}
}
