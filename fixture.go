package counterrate

import (
	"bufio"
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"time"
)

// fixtureLine is one synthesized telemetry event. Ts accepts an RFC3339
// string or unix seconds (number).
type fixtureLine struct {
	Ts      json.RawMessage `json:"ts"`
	Value   float64         `json:"value"`
	Restart bool            `json:"restart,omitempty"`
}

func parseTs(raw json.RawMessage) (time.Time, error) {
	var str string
	if err := json.Unmarshal(raw, &str); err == nil {
		t, err := time.Parse(time.RFC3339Nano, str)
		if err != nil {
			return time.Time{}, fmt.Errorf("counterrate: bad ts %q: %w", str, err)
		}
		return t, nil
	}
	var sec float64
	if err := json.Unmarshal(raw, &sec); err != nil {
		return time.Time{}, fmt.Errorf("counterrate: unsupported ts %s", raw)
	}
	whole := int64(sec)
	return time.Unix(whole, int64((sec-float64(whole))*1e9)).UTC(), nil
}

// ReplayFixture reads JSONL telemetry events and ingests them in file
// order (which may be deliberately shuffled to exercise out-of-order
// handling). Blank lines and lines starting with '#' are ignored.
func ReplayFixture(r io.Reader, s *Series) (int, error) {
	sc := bufio.NewScanner(r)
	sc.Buffer(make([]byte, 64*1024), 1<<20)
	n, line := 0, 0
	for sc.Scan() {
		line++
		b := bytes.TrimSpace(sc.Bytes())
		if len(b) == 0 || b[0] == '#' {
			continue
		}
		var fl fixtureLine
		if err := json.Unmarshal(b, &fl); err != nil {
			return n, fmt.Errorf("counterrate: fixture line %d: %w", line, err)
		}
		ts, err := parseTs(fl.Ts)
		if err != nil {
			return n, fmt.Errorf("counterrate: fixture line %d: %w", line, err)
		}
		s.Add(Sample{Ts: ts, Value: fl.Value, Restart: fl.Restart})
		n++
	}
	return n, sc.Err()
}
