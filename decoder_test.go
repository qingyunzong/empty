package q150

import (
	"math/rand"
	"testing"
)

func collectDecoder() (*Decoder, *[]Event, *[]int) {
	var events []Event
	var retries []int
	dec := NewDecoder(
		func(e Event) { events = append(events, e) },
		func(millis int) { retries = append(retries, millis) },
	)
	return dec, &events, &retries
}

// feedChunks 按给定切点把 data 拆成多个 Write 调用。
func feedChunks(t *testing.T, dec *Decoder, data string, cuts []int) {
	t.Helper()
	prev := 0
	for _, cut := range cuts {
		if _, err := dec.Write([]byte(data[prev:cut])); err != nil {
			t.Fatalf("write: %v", err)
		}
		prev = cut
	}
	if _, err := dec.Write([]byte(data[prev:])); err != nil {
		t.Fatalf("write tail: %v", err)
	}
	if err := dec.Close(); err != nil {
		t.Fatalf("close: %v", err)
	}
}

func TestDecoderAllChunkBoundaries(t *testing.T) {
	stream := ": comment line\n" +
		"id: e1\n" +
		"event: update\n" +
		"data: first\n" +
		"data: second\n" +
		"\n" +
		"id:\n" +
		"data: only\n" +
		"\n" +
		"retry: 1500\n" +
		"data: retry-event\n" +
		"id:e3\n" +
		"data:no-space\n" +
		"\n" +
		"data:\n" +
		"\n"

	want := []Event{
		{Type: "update", Data: "first\nsecond", LastEventID: "e1"},
		{Type: "message", Data: "only", LastEventID: ""},
		// retry-event 与 no-space 之间无空行，按规范合并为同一事件，
		// 事件内设置的 id 对派发结果生效。
		{Type: "message", Data: "retry-event\nno-space", LastEventID: "e3"},
		{Type: "message", Data: "", LastEventID: "e3"},
	}

	// 穷举所有单切点，覆盖换行与多字节字符跨块。
	for cut := 1; cut < len(stream); cut++ {
		dec, events, retries := collectDecoder()
		feedChunks(t, dec, stream, []int{cut})
		assertEvents(t, *events, want)
		if len(*retries) != 1 || (*retries)[0] != 1500 {
			t.Fatalf("cut %d: retries = %v, want [1500]", cut, *retries)
		}
		if dec.RetryMillis() != 1500 {
			t.Fatalf("cut %d: RetryMillis = %d", cut, dec.RetryMillis())
		}
	}

	// 逐字节喂入。
	dec, events, _ := collectDecoder()
	var cuts []int
	for i := 1; i < len(stream); i++ {
		cuts = append(cuts, i)
	}
	feedChunks(t, dec, stream, cuts)
	assertEvents(t, *events, want)

	// 随机切块，多个种子。
	for seed := int64(0); seed < 20; seed++ {
		dec, events, _ := collectDecoder()
		rng := rand.New(rand.NewSource(seed))
		var randomCuts []int
		pos := 0
		for pos < len(stream) {
			pos += 1 + rng.Intn(7)
			if pos < len(stream) {
				randomCuts = append(randomCuts, pos)
			}
		}
		feedChunks(t, dec, stream, randomCuts)
		assertEvents(t, *events, want)
	}
}

func assertEvents(t *testing.T, got, want []Event) {
	t.Helper()
	if len(got) != len(want) {
		t.Fatalf("event count = %d, want %d; got=%v", len(got), len(want), got)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Fatalf("event %d = %+v, want %+v", i, got[i], want[i])
		}
	}
}

func TestDecoderCRLFAndCRAcrossChunks(t *testing.T) {
	cases := map[string]struct {
		stream string
		want   []Event
	}{
		"crlf": {
			stream: "data: a\r\ndata: b\r\n\r\n",
			want:   []Event{{Type: "message", Data: "a\nb", LastEventID: ""}},
		},
		"cr": {
			stream: "data: a\rdata: b\r\r",
			want:   []Event{{Type: "message", Data: "a\nb", LastEventID: ""}},
		},
		"mixed": {
			stream: "data: a\rdata: b\n\r\n",
			want:   []Event{{Type: "message", Data: "a\nb", LastEventID: ""}},
		},
		"cr_lf_split": {
			stream: "data: x\r\n\n",
			want:   []Event{{Type: "message", Data: "x", LastEventID: ""}},
		},
	}
	for name, tc := range cases {
		t.Run(name, func(t *testing.T) {
			// 逐字节喂入，保证 CR 与 LF 被拆到不同 Write。
			dec, events, _ := collectDecoder()
			for i := 0; i < len(tc.stream); i++ {
				if _, err := dec.Write([]byte{tc.stream[i]}); err != nil {
					t.Fatal(err)
				}
			}
			if err := dec.Close(); err != nil {
				t.Fatal(err)
			}
			assertEvents(t, *events, tc.want)
		})
	}
}

func TestDecoderBOMAcrossChunks(t *testing.T) {
	stream := "\xEF\xBB\xBFdata: bom\n\n"
	for cut := 1; cut < len(stream); cut++ {
		dec, events, _ := collectDecoder()
		feedChunks(t, dec, stream, []int{cut})
		assertEvents(t, *events, []Event{{Type: "message", Data: "bom", LastEventID: ""}})
	}
}

func TestDecoderEdgeCases(t *testing.T) {
	t.Run("nul_in_id_ignored", func(t *testing.T) {
		dec, events, _ := collectDecoder()
		feedChunks(t, dec, "id: a\x00b\n\ndata: x\n\n", nil)
		assertEvents(t, *events, []Event{
			{Type: "message", Data: "x", LastEventID: ""},
		})
		if dec.LastEventID() != "" {
			t.Fatalf("last id = %q, want empty", dec.LastEventID())
		}
	})

	t.Run("invalid_retry_ignored", func(t *testing.T) {
		dec, _, retries := collectDecoder()
		feedChunks(t, dec, "retry: 12x\nretry: 2500\nretry:\n", nil)
		if dec.RetryMillis() != 2500 {
			t.Fatalf("RetryMillis = %d, want 2500", dec.RetryMillis())
		}
		if len(*retries) != 1 || (*retries)[0] != 2500 {
			t.Fatalf("retries = %v, want [2500]", *retries)
		}
	})

	t.Run("invalid_utf8_replaced", func(t *testing.T) {
		dec, events, _ := collectDecoder()
		feedChunks(t, dec, "data: \xffok\xfe\n\n", nil)
		assertEvents(t, *events, []Event{
			{Type: "message", Data: "\ufffdok\ufffd", LastEventID: ""},
		})
	})

	t.Run("multibyte_utf8_split", func(t *testing.T) {
		dec, events, _ := collectDecoder()
		feedChunks(t, dec, "data: 你好\n\n", []int{8, 9, 10})
		assertEvents(t, *events, []Event{
			{Type: "message", Data: "你好", LastEventID: ""},
		})
	})

	t.Run("comment_emits_nothing", func(t *testing.T) {
		dec, events, _ := collectDecoder()
		feedChunks(t, dec, ": heartbeat\n: another\n\n", nil)
		if len(*events) != 0 {
			t.Fatalf("comments produced events: %v", *events)
		}
	})

	t.Run("field_without_colon", func(t *testing.T) {
		dec, events, _ := collectDecoder()
		feedChunks(t, dec, "data\n\n", nil)
		assertEvents(t, *events, []Event{
			{Type: "message", Data: "", LastEventID: ""},
		})
	})

	t.Run("eof_flushes_event", func(t *testing.T) {
		dec, events, _ := collectDecoder()
		if _, err := dec.Write([]byte("data: tail")); err != nil {
			t.Fatal(err)
		}
		if err := dec.Close(); err != nil {
			t.Fatal(err)
		}
		assertEvents(t, *events, []Event{
			{Type: "message", Data: "tail", LastEventID: ""},
		})
	})

	t.Run("empty_id_clears_marker", func(t *testing.T) {
		dec, events, _ := collectDecoder()
		feedChunks(t, dec, "id: keep\ndata: a\n\nid:\ndata: b\n\n", nil)
		assertEvents(t, *events, []Event{
			{Type: "message", Data: "a", LastEventID: "keep"},
			{Type: "message", Data: "b", LastEventID: ""},
		})
		if dec.LastEventID() != "" {
			t.Fatalf("last id = %q, want cleared", dec.LastEventID())
		}
	})

	t.Run("initial_retry_sentinel", func(t *testing.T) {
		dec, _, _ := collectDecoder()
		if dec.RetryMillis() != -1 {
			t.Fatalf("initial RetryMillis = %d, want -1", dec.RetryMillis())
		}
	})
}
