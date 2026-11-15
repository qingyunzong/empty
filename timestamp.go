package dataeng

import (
	"errors"
	"fmt"
	"strconv"
	"strings"
	"time"
	_ "time/tzdata"
)

const (
	// ORC-135 is the writer version that started writing UTC timestamp
	// statistics. Older writers wrote local wall-clock values in the stripe's
	// writer timezone.
	writerVersionORC135 = 6
	// ORC-101 is the version that standardized UTF-8 bloom filter hashing.
	writerVersionORC101 = 5

	orc2015EpochMillis int64 = 1420070400000
)

// WriterVersionORC135 is the first ORC writer version that stores timestamp
// statistics in UTC (minimumUtc/maximumUtc). Earlier writers use local
// wall-clock values from the stripe's writer timezone.
const WriterVersionORC135 = writerVersionORC135

// TimestampMode controls how legacy (pre-ORC-135) timestamp statistics are
// interpreted. Auto is the safe default.
type TimestampMode int

const (
	// TimestampAuto interprets modern UTC statistics as Unix milliseconds. For
	// legacy local statistics it accepts both Unix-epoch and 2015-epoch
	// milliseconds when the value is small enough to be ambiguous. This can
	// over-select, but never drops a row.
	TimestampAuto TimestampMode = iota
	// TimestampUnixMillis forces legacy values to be Unix epoch milliseconds.
	TimestampUnixMillis
	// TimestampMillisSince2015 forces legacy values to be milliseconds since
	// 2015-01-01T00:00:00Z.
	TimestampMillisSince2015
)

type timestampPoint struct {
	ms int64
	ns int32
}

func (p timestampPoint) compare(q timestampPoint) int {
	if p.ms < q.ms {
		return -1
	}
	if p.ms > q.ms {
		return 1
	}
	if p.ns < q.ns {
		return -1
	}
	if p.ns > q.ns {
		return 1
	}
	return 0
}

type timestampSpan struct {
	lo timestampPoint
	hi timestampPoint
}

func (s timestampSpan) contains(p timestampPoint) bool {
	return s.lo.compare(p) <= 0 && s.hi.compare(p) >= 0
}

func timePoint(t time.Time) timestampPoint {
	return timestampPoint{ms: t.UnixMilli(), ns: int32(t.Nanosecond() % 1e6)}
}

func maxPoint(a, b timestampPoint) timestampPoint {
	if a.compare(b) >= 0 {
		return a
	}
	return b
}

func minPoint(a, b timestampPoint) timestampPoint {
	if a.compare(b) <= 0 {
		return a
	}
	return b
}

// loadWriterTimezone accepts IANA names as well as the fixed-offset spellings
// emitted by a few older Hive writers.
func loadWriterTimezone(name string) (*time.Location, error) {
	name = strings.TrimSpace(name)
	if name == "" {
		return nil, errors.New("dataeng: writer timezone is missing")
	}
	if name == "UTC" || name == "GMT" || name == "Z" || name == "Etc/UTC" {
		return time.UTC, nil
	}
	if loc, err := time.LoadLocation(name); err == nil {
		return loc, nil
	}
	if loc := parseFixedOffsetZone(name); loc != nil {
		return loc, nil
	}
	return nil, fmt.Errorf("dataeng: unknown writer timezone %q", name)
}

func parseFixedOffsetZone(name string) *time.Location {
	upper := strings.ToUpper(strings.TrimSpace(name))
	for _, prefix := range []string{"GMT", "UTC"} {
		if strings.HasPrefix(upper, prefix) {
			rest := strings.TrimSpace(name[len(prefix):])
			if rest == "" {
				return time.UTC
			}
			if loc, ok := parseOffset(rest); ok {
				return loc
			}
		}
	}
	if loc, ok := parseOffset(name); ok {
		return loc
	}
	return nil
}

func parseOffset(s string) (*time.Location, bool) {
	s = strings.TrimSpace(s)
	label := s
	if s == "" {
		return nil, false
	}
	sign := 1
	switch s[0] {
	case '+':
		s = s[1:]
	case '-':
		sign = -1
		s = s[1:]
	default:
		if s[0] < '0' || s[0] > '9' {
			return nil, false
		}
	}
	parts := strings.Split(s, ":")
	if len(parts) > 2 {
		return nil, false
	}
	hours, err := strconv.Atoi(parts[0])
	if err != nil || hours > 23 {
		return nil, false
	}
	mins := 0
	if len(parts) == 2 {
		mins, err = strconv.Atoi(parts[1])
		if err != nil || mins > 59 {
			return nil, false
		}
	}
	offset := sign * (hours*3600 + mins*60)
	return time.FixedZone(label, offset), true
}

func sameWallClock(a, b time.Time) bool {
	ay, am, ad := a.Date()
	by, bm, bd := b.Date()
	ah, ami, as := a.Clock()
	bh, bmi, bs := b.Clock()
	return ay == by && am == bm && ad == bd && ah == bh && ami == bmi && as == bs
}

// possibleInstants returns every UTC millisecond that renders as wallMillis in
// loc. During a fall-back transition there are two; during a spring-forward gap
// there may be none, in which case both bracketing offsets are returned so the
// caller widens rather than dropping a row.
func possibleInstants(wallMillis int64, loc *time.Location) []int64 {
	if loc == nil {
		return nil
	}
	offsets := map[int]struct{}{}
	addAt := func(ms int64) {
		_, off := time.UnixMilli(ms).In(loc).Zone()
		offsets[off] = struct{}{}
	}
	for d := int64(-3 * 24 * time.Hour / time.Millisecond); d <= int64(3*24*time.Hour/time.Millisecond); d += int64(6 * time.Hour / time.Millisecond) {
		addAt(wallMillis + d)
	}
	for d := int64(-200 * 24 * time.Hour / time.Millisecond); d <= int64(200*24*time.Hour/time.Millisecond); d += int64(7 * 24 * time.Hour / time.Millisecond) {
		addAt(wallMillis + d)
	}
	wall := time.UnixMilli(wallMillis).UTC()
	var valid []int64
	var all []int64
	for off := range offsets {
		instant := wallMillis - int64(off)*1000
		if instant < -(1<<62) || instant > 1<<62 {
			continue
		}
		all = append(all, instant)
		if sameWallClock(time.UnixMilli(instant).In(loc), wall) {
			valid = append(valid, instant)
		}
	}
	if len(valid) > 0 {
		return sortUniqueInt64(valid)
	}
	// A local time in the spring-forward gap has no exact instant. Use every
	// offset seen around the transition.
	return sortUniqueInt64(all)
}

func sortUniqueInt64(v []int64) []int64 {
	if len(v) < 2 {
		return v
	}
	// Small slices, insertion sort keeps this dependency-free.
	for i := 1; i < len(v); i++ {
		for j := i; j > 0 && v[j] < v[j-1]; j-- {
			v[j], v[j-1] = v[j-1], v[j]
		}
	}
	out := v[:1]
	for _, x := range v[1:] {
		if x != out[len(out)-1] {
			out = append(out, x)
		}
	}
	return out
}

func legacyWallEpochs(raw int64, mode TimestampMode) []int64 {
	switch mode {
	case TimestampMillisSince2015:
		return []int64{raw + orc2015EpochMillis}
	case TimestampUnixMillis:
		return []int64{raw}
	default:
		// Any value below this threshold could be either Unix milliseconds
		// (before 2001) or milliseconds since 2015. Keeping both is safe and
		// still prunes the common modern cases tightly.
		const ambiguous = int64(1_000_000_000_000)
		if raw > -ambiguous && raw < ambiguous {
			out := []int64{raw, raw + orc2015EpochMillis}
			// Some pre-ORC-135 producers wrote seconds even though the
			// statistics field is documented as milliseconds. Include that
			// interpretation when the magnitude is plausible.
			if raw > -10_000_000_000 && raw < 10_000_000_000 {
				out = append(out, raw*1000, raw*1000+orc2015EpochMillis)
			}
			return out
		}
		return []int64{raw}
	}
}

func localTimestampSpan(minRaw, maxRaw int64, minNanos, maxNanos uint32, hasMinNanos, hasMaxNanos bool, loc *time.Location, mode TimestampMode) (timestampSpan, bool) {
	if loc == nil {
		return timestampSpan{}, false
	}
	minWalls := legacyWallEpochs(minRaw, mode)
	maxWalls := legacyWallEpochs(maxRaw, mode)
	var minInstants, maxInstants []int64
	for _, w := range minWalls {
		minInstants = append(minInstants, possibleInstants(w, loc)...)
	}
	for _, w := range maxWalls {
		maxInstants = append(maxInstants, possibleInstants(w, loc)...)
	}
	if len(minInstants) == 0 || len(maxInstants) == 0 {
		return timestampSpan{}, false
	}
	loMS, hiMS := minInstants[0], maxInstants[0]
	for _, v := range minInstants[1:] {
		if v < loMS {
			loMS = v
		}
	}
	for _, v := range maxInstants[1:] {
		if v > hiMS {
			hiMS = v
		}
	}
	loNS := int32(0)
	if hasMinNanos {
		if minNanos > 999_999 {
			return timestampSpan{}, false
		}
		loNS = int32(minNanos)
	}
	hiNS := int32(999_999)
	if hasMaxNanos {
		if maxNanos > 999_999 {
			return timestampSpan{}, false
		}
		hiNS = int32(maxNanos)
	}
	span := timestampSpan{
		lo: timestampPoint{ms: loMS, ns: loNS},
		hi: timestampPoint{ms: hiMS, ns: hiNS},
	}
	if span.lo.compare(span.hi) > 0 {
		return timestampSpan{}, false
	}
	return span, true
}

func utcTimestampSpan(minRaw, maxRaw int64, minNanos, maxNanos uint32, hasMinNanos, hasMaxNanos bool) (timestampSpan, bool) {
	loNS := int32(0)
	if hasMinNanos {
		if minNanos > 999_999 {
			return timestampSpan{}, false
		}
		loNS = int32(minNanos)
	}
	hiNS := int32(999_999)
	if hasMaxNanos {
		if maxNanos > 999_999 {
			return timestampSpan{}, false
		}
		hiNS = int32(maxNanos)
	}
	span := timestampSpan{
		lo: timestampPoint{ms: minRaw, ns: loNS},
		hi: timestampPoint{ms: maxRaw, ns: hiNS},
	}
	if span.lo.compare(span.hi) > 0 {
		return timestampSpan{}, false
	}
	return span, true
}

// timestampBounds returns a safe superset of all timestamp values in a row
// group. The boolean is false when the statistics cannot be trusted.
func timestampBounds(ts *TimestampStatistics, writerVersion uint32, versionKnown bool, timezoneName string, mode TimestampMode) (timestampSpan, bool) {
	if ts == nil {
		return timestampSpan{}, false
	}
	if ts.HasMinimumUTC && ts.HasMaximumUTC {
		span, ok := utcTimestampSpan(ts.MinimumUTC, ts.MaximumUTC, ts.MinimumNanos, ts.MaximumNanos, ts.HasMinimumNanos, ts.HasMaximumNanos)
		if !ok {
			return timestampSpan{}, false
		}
		// A few early UTC-statistics writers still stored values relative to
		// ORC's 2015 epoch. Include that reading when it is plausible; the
		// union can only widen the candidate interval.
		const ambiguous = int64(1_000_000_000_000)
		if (ts.MinimumUTC > -ambiguous && ts.MinimumUTC < ambiguous) ||
			(ts.MaximumUTC > -ambiguous && ts.MaximumUTC < ambiguous) {
			if alt, altOK := utcTimestampSpan(ts.MinimumUTC+orc2015EpochMillis, ts.MaximumUTC+orc2015EpochMillis, ts.MinimumNanos, ts.MaximumNanos, ts.HasMinimumNanos, ts.HasMaximumNanos); altOK {
				span.lo = minPoint(span.lo, alt.lo)
				span.hi = maxPoint(span.hi, alt.hi)
			}
		}
		return span, true
	}

	// New writers are required to emit UTC statistics. Seeing only local
	// statistics from such a writer means the data is inconsistent.
	if versionKnown && writerVersion >= writerVersionORC135 {
		return timestampSpan{}, false
	}

	hasMin := ts.HasMinimum || ts.HasLower
	hasMax := ts.HasMaximum || ts.HasUpper
	if !hasMin || !hasMax {
		return timestampSpan{}, false
	}
	minRaw, maxRaw := ts.Minimum, ts.Maximum
	if ts.HasLower {
		minRaw = ts.LowerBound
	}
	if ts.HasUpper {
		maxRaw = ts.UpperBound
	}
	loc, err := loadWriterTimezone(timezoneName)
	if err != nil {
		return timestampSpan{}, false
	}
	return localTimestampSpan(minRaw, maxRaw, ts.MinimumNanos, ts.MaximumNanos, ts.HasMinimumNanos, ts.HasMaximumNanos, loc, mode)
}
