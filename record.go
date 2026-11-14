package dataeng

import (
	"errors"
	"fmt"
	"reflect"
	"strconv"
	"strings"
	"time"
)

const (
	// TagPartial marks a fragment that continues on a later line.
	TagPartial = "P"
	// TagFull marks the final fragment of a record.
	TagFull = "F"
	// P and F are short aliases for the CRI tags.
	P = TagPartial
	F = TagFull

	// Stdout and Stderr are the CRI stream names.
	Stdout = "stdout"
	Stderr = "stderr"
	// StreamStdout and StreamStderr are descriptive aliases.
	StreamStdout = Stdout
	StreamStderr = Stderr

	// TruncationMarker is appended to content when a record could not be
	// completed normally.
	TruncationMarker = "[truncated]"

	// TruncatedMarker and DefaultTruncationMarker are aliases for callers
	// that prefer a more descriptive name.
	TruncatedMarker         = TruncationMarker
	DefaultTruncationMarker = TruncationMarker
	TruncationMark          = TruncationMarker
)

var (
	// ErrInvalidLine reports input that is not a CRI log line.
	ErrInvalidLine = errors.New("dataeng: invalid CRI log line")
	// ErrInvalidTimestamp reports a CRI timestamp that cannot be parsed.
	ErrInvalidTimestamp = errors.New("dataeng: invalid CRI timestamp")
)

// Record is one CRI log fragment, or a record produced by Reassembler.
//
// Timestamp and Generation intentionally accept the common representations
// used by node log collectors. Timestamp may be a time.Time, a string in
// RFC3339/RFC3339Nano form, an integer Unix timestamp, or a number of
// nanoseconds. Generation may be an integer or a string file identity.
// Parsed timestamps are also available through Time.
//
// For input records Tag is the CRI P/F flag by default. A collector that has
// an additional source tag can set Source (or SourceTag); then Tag remains
// available as the P/F flag and Source participates in the grouping key.
// Partial and Flag are accepted as alternative ways to express the flag.
type Record struct {
	Timestamp  any
	Stream     string
	Tag        string
	Content    string
	Generation any

	// FileGeneration, GenerationID, and FileID are accepted as aliases for
	// Generation.
	FileGeneration any
	GenerationID   any
	FileID         any
	File           string
	FileIndex      int

	// Source identifies a log source within a stream. It is optional for
	// CRI files, which normally have exactly one source per stream.
	Source string
	// SourceTag is an alias for Source.
	SourceTag string

	// Partial and Flag are accepted on input and are set consistently on
	// output. Tag is also set to the effective P/F flag.
	Partial bool
	Flag    string

	// Truncated is true when the record was emitted without a final fragment,
	// or because a configured fragment/byte limit was exceeded.
	Truncated bool

	// Time holds the parsed form of Timestamp. ParseLine and Reassembler
	// populate it when the timestamp can be parsed.
	Time any
	// TimestampText is accepted as a string alternative to Timestamp.
	TimestampText string

	// Message and Data are accepted as aliases for Content by collectors
	// that use message-oriented record types.
	Message string
	Data    string
}

// IsPartial reports whether the record is a P fragment.
func (r Record) IsPartial() bool {
	return effectiveFlag(r) == TagPartial
}

// IsComplete reports whether the record is an F fragment and was not
// truncated while being reassembled.
func (r Record) IsComplete() bool {
	return !r.Truncated && effectiveFlag(r) == TagFull
}

// IsTruncated reports whether the record carries a truncation marker.
func (r Record) IsTruncated() bool { return r.Truncated }

// ParseLine parses one CRI log line. A trailing newline is ignored; content
// is otherwise preserved exactly, including leading spaces after the flag.
func ParseLine(line string) (Record, error) {
	line = strings.TrimSuffix(line, "\n")
	line = strings.TrimSuffix(line, "\r")

	part, rest, ok := nextField(line)
	if !ok {
		return Record{}, fmt.Errorf("%w: missing timestamp", ErrInvalidLine)
	}
	rawTime := part
	timestamp, err := parseTimestamp(rawTime)
	if err != nil {
		return Record{}, fmt.Errorf("%w: %q", ErrInvalidTimestamp, rawTime)
	}

	part, rest, ok = nextField(rest)
	if !ok {
		return Record{}, fmt.Errorf("%w: missing stream", ErrInvalidLine)
	}
	stream := part

	part, rest, ok = nextField(rest)
	if !ok {
		return Record{}, fmt.Errorf("%w: missing tag", ErrInvalidLine)
	}
	flag := strings.ToUpper(part)
	if flag != TagPartial && flag != TagFull {
		return Record{}, fmt.Errorf("%w: unknown tag %q", ErrInvalidLine, part)
	}

	return Record{
		Timestamp: rawTime,
		Time:      timestamp,
		Stream:    stream,
		Tag:       flag,
		Flag:      flag,
		Partial:   flag == TagPartial,
		Content:   rest,
	}, nil
}

// ParseCRILine is an alias for ParseLine.
func ParseCRILine(line string) (Record, error) { return ParseLine(line) }

// ParseCRILog is an alias for ParseLine.
func ParseCRILog(line string) (Record, error) { return ParseLine(line) }

// ParseLogLine is an alias for ParseLine.
func ParseLogLine(line string) (Record, error) { return ParseLine(line) }

// ParseRecord is an alias for ParseLine.
func ParseRecord(line string) (Record, error) { return ParseLine(line) }

// Parse is an alias for ParseLine.
func Parse(line string) (Record, error) { return ParseLine(line) }

// ParseLines parses CRI lines in order. On the first malformed line it
// returns the successfully parsed prefix together with the error.
func ParseLines(lines []string) ([]Record, error) {
	out := make([]Record, 0, len(lines))
	for i, line := range lines {
		r, err := ParseLine(line)
		if err != nil {
			return out, fmt.Errorf("line %d: %w", i+1, err)
		}
		out = append(out, r)
	}
	return out, nil
}

func nextField(s string) (field, rest string, ok bool) {
	if s == "" {
		return "", "", false
	}
	i := 0
	for i < len(s) && s[i] == ' ' {
		i++
	}
	if i == len(s) {
		return "", "", false
	}
	start := i
	for i < len(s) && s[i] != ' ' {
		i++
	}
	field = s[start:i]
	if i < len(s) && s[i] == ' ' {
		i++
	}
	return field, s[i:], true
}

func parseTimestamp(v any) (time.Time, error) {
	switch t := v.(type) {
	case time.Time:
		return t, nil
	case *time.Time:
		if t == nil {
			return time.Time{}, ErrInvalidTimestamp
		}
		return *t, nil
	case string:
		return parseTimestampString(t)
	case []byte:
		return parseTimestampString(string(t))
	case int:
		return timeFromUnix(int64(t)), nil
	case int32:
		return timeFromUnix(int64(t)), nil
	case int64:
		return timeFromUnix(t), nil
	case uint:
		return timeFromUnix(int64(t)), nil
	case uint32:
		return timeFromUnix(int64(t)), nil
	case uint64:
		return timeFromUnix(int64(t)), nil
	case float32:
		return timeFromUnixFloat(float64(t)), nil
	case float64:
		return timeFromUnixFloat(t), nil
	default:
		return time.Time{}, ErrInvalidTimestamp
	}
}

func parseTimestampString(s string) (time.Time, error) {
	s = strings.TrimSpace(s)
	if s == "" {
		return time.Time{}, ErrInvalidTimestamp
	}
	if t, err := time.Parse(time.RFC3339Nano, s); err == nil {
		return t, nil
	}
	if t, err := time.Parse(time.RFC3339, s); err == nil {
		return t, nil
	}
	if n, err := strconv.ParseInt(s, 10, 64); err == nil {
		return timeFromUnix(n), nil
	}
	return time.Time{}, ErrInvalidTimestamp
}

func timeFromUnix(n int64) time.Time {
	// Node collectors commonly pass either seconds or nanoseconds. Values
	// with more than 12 digits are treated as nanoseconds; the rest are
	// Unix seconds.
	if n > 1e12 || n < -1e12 {
		return time.Unix(0, n).UTC()
	}
	return time.Unix(n, 0).UTC()
}

func timeFromUnixFloat(n float64) time.Time {
	sec := int64(n)
	nsec := int64((n - float64(sec)) * 1e9)
	return time.Unix(sec, nsec).UTC()
}

// fragment is the normalized form used internally by Reassembler.
type fragment struct {
	record Record

	timestamp    time.Time
	timestampRaw any
	hasTimestamp bool
	timestampKey string

	stream string
	source string

	flag    string
	partial bool

	content string

	generation    any
	generationKey string
	hasGeneration bool
}

func normalize(v any) (fragment, bool) {
	switch r := v.(type) {
	case Record:
		return normalizeRecord(r)
	case *Record:
		if r == nil {
			return fragment{}, false
		}
		return normalizeRecord(*r)
	case string:
		rec, err := ParseLine(r)
		if err != nil {
			return fragment{}, false
		}
		return normalizeRecord(rec)
	case []byte:
		rec, err := ParseLine(string(r))
		if err != nil {
			return fragment{}, false
		}
		return normalizeRecord(rec)
	}

	rv := reflect.ValueOf(v)
	if !rv.IsValid() {
		return fragment{}, false
	}
	for rv.Kind() == reflect.Pointer || rv.Kind() == reflect.Interface {
		if rv.IsNil() {
			return fragment{}, false
		}
		rv = rv.Elem()
	}

	switch rv.Kind() {
	case reflect.Struct:
		return normalizeStruct(rv)
	case reflect.Map:
		return normalizeMap(rv)
	default:
		return fragment{}, false
	}
}

func normalizeRecord(r Record) (fragment, bool) {
	f := fragment{record: r}
	f.content = firstNonEmpty(r.Content, r.Message, r.Data)

	if r.Source != "" {
		f.source = r.Source
	} else {
		f.source = r.SourceTag
	}

	tag := strings.TrimSpace(r.Tag)
	flag := strings.TrimSpace(r.Flag)
	if isFlag(tag) {
		if flag == "" {
			flag = tag
		}
		tag = ""
	}
	if isFlag(flag) {
		flag = strings.ToUpper(flag)
	} else {
		flag = ""
	}
	if flag == "" && r.Partial {
		flag = TagPartial
	}
	if flag == "" {
		flag = TagFull
	}
	f.flag = flag
	f.partial = flag == TagPartial
	if f.source == "" {
		f.source = tag
	}

	f.stream = r.Stream

	if r.Timestamp != nil {
		f.timestampRaw = r.Timestamp
		f.hasTimestamp = true
		if t, err := parseTimestamp(r.Timestamp); err == nil {
			f.timestamp = t
		} else {
			f.timestampKey = fmt.Sprint(r.Timestamp)
		}
	} else if r.TimestampText != "" {
		f.timestampRaw = r.TimestampText
		f.hasTimestamp = true
		if t, err := parseTimestamp(r.TimestampText); err == nil {
			f.timestamp = t
		} else {
			f.timestampKey = r.TimestampText
		}
	} else if r.Time != nil {
		f.timestampRaw = r.Time
		f.hasTimestamp = true
		if t, err := parseTimestamp(r.Time); err == nil {
			f.timestamp = t
		} else {
			f.timestampKey = fmt.Sprint(r.Time)
		}
	}
	if f.hasTimestamp && f.timestampKey == "" {
		f.timestampKey = timestampKey(f.timestamp)
	}

	generation := r.Generation
	if generation == nil {
		generation = r.FileGeneration
	}
	if generation == nil {
		generation = r.GenerationID
	}
	if generation == nil {
		generation = r.FileID
	}
	if generation == nil && r.File != "" {
		generation = r.File
	}
	if generation == nil && r.FileIndex != 0 {
		generation = r.FileIndex
	}
	if generation != nil {
		f.generation = generation
		f.hasGeneration = true
		f.generationKey = generationKey(generation)
	}

	return f, true
}

func normalizeStruct(rv reflect.Value) (fragment, bool) {
	var r Record
	if v, ok := findField(rv, "Timestamp", "Time", "TS", "At", "TimestampText"); ok {
		r.Timestamp = v.Interface()
	}
	if v, ok := findField(rv, "Stream", "Channel"); ok {
		r.Stream = stringValue(v)
	}
	if v, ok := findField(rv, "Tag", "LogTag", "Kind", "PartialFlag"); ok {
		r.Tag = stringValue(v)
	}
	if v, ok := findField(rv, "Flag", "PartialFlag"); ok {
		r.Flag = stringValue(v)
	}
	if v, ok := findField(rv, "Partial", "IsPartial"); ok {
		r.Partial = boolValue(v)
	}
	if v, ok := findField(rv, "Content", "Message", "Data", "Line", "Msg", "Text", "Log", "Body", "Raw"); ok {
		r.Content = stringValue(v)
	}
	if v, ok := findField(rv, "Generation", "FileGeneration", "GenerationID", "FileID", "File", "Gen", "Segment"); ok {
		r.Generation = v.Interface()
	}
	if v, ok := findField(rv, "Source", "SourceTag", "Container", "ContainerID", "TagName"); ok {
		r.Source = stringValue(v)
	}
	if v, ok := findField(rv, "Truncated", "IsTruncated"); ok {
		r.Truncated = boolValue(v)
	}
	return normalizeRecord(r)
}

func findField(rv reflect.Value, names ...string) (reflect.Value, bool) {
	for _, name := range names {
		f := rv.FieldByName(name)
		if f.IsValid() && f.CanInterface() {
			return f, true
		}
	}
	return reflect.Value{}, false
}

func normalizeMap(rv reflect.Value) (fragment, bool) {
	if rv.IsNil() {
		return fragment{}, false
	}
	if rv.Type().Key().Kind() != reflect.String {
		return fragment{}, false
	}
	get := func(keys ...string) (any, bool) {
		for _, key := range keys {
			v := rv.MapIndex(reflect.ValueOf(key))
			if v.IsValid() && v.CanInterface() {
				return v.Interface(), true
			}
		}
		return nil, false
	}

	var r Record
	if v, ok := get("Timestamp", "timestamp", "Time", "time", "ts", "TS"); ok {
		r.Timestamp = v
	}
	if v, ok := get("Stream", "stream"); ok {
		r.Stream = fmt.Sprint(v)
	}
	if v, ok := get("Tag", "tag", "logtag", "LogTag"); ok {
		r.Tag = fmt.Sprint(v)
	}
	if v, ok := get("Flag", "flag"); ok {
		r.Flag = fmt.Sprint(v)
	}
	if v, ok := get("Partial", "partial"); ok {
		r.Partial = boolValue(reflect.ValueOf(v))
	}
	if v, ok := get("Content", "content", "Message", "message", "Data", "data", "log", "Log"); ok {
		r.Content = fmt.Sprint(v)
	}
	if v, ok := get("Generation", "generation", "FileGeneration", "file_generation", "File", "file", "FileID", "file_id"); ok {
		r.Generation = v
	}
	if v, ok := get("Source", "source", "SourceTag", "source_tag"); ok {
		r.Source = fmt.Sprint(v)
	}
	return normalizeRecord(r)
}

func effectiveFlag(r Record) string {
	if isFlag(r.Flag) {
		return strings.ToUpper(strings.TrimSpace(r.Flag))
	}
	if isFlag(r.Tag) {
		return strings.ToUpper(strings.TrimSpace(r.Tag))
	}
	if r.Partial {
		return TagPartial
	}
	return TagFull
}

func isFlag(s string) bool {
	s = strings.ToUpper(strings.TrimSpace(s))
	return s == TagPartial || s == TagFull
}

func firstNonEmpty(values ...string) string {
	for _, v := range values {
		if v != "" {
			return v
		}
	}
	return ""
}

func timestampKey(t time.Time) string {
	if t.IsZero() {
		return "zero"
	}
	return "t:" + strconv.FormatInt(t.UnixNano(), 10)
}

func generationKey(v any) string {
	switch g := v.(type) {
	case nil:
		return ""
	case string:
		if n, err := strconv.ParseInt(strings.TrimSpace(g), 10, 64); err == nil {
			return "g:" + strconv.FormatInt(n, 10)
		}
		return "s:" + g
	case []byte:
		return generationKey(string(g))
	case int:
		return "g:" + strconv.FormatInt(int64(g), 10)
	case int8:
		return "g:" + strconv.FormatInt(int64(g), 10)
	case int16:
		return "g:" + strconv.FormatInt(int64(g), 10)
	case int32:
		return "g:" + strconv.FormatInt(int64(g), 10)
	case int64:
		return "g:" + strconv.FormatInt(g, 10)
	case uint:
		return "g:" + strconv.FormatUint(uint64(g), 10)
	case uint8:
		return "g:" + strconv.FormatUint(uint64(g), 10)
	case uint16:
		return "g:" + strconv.FormatUint(uint64(g), 10)
	case uint32:
		return "g:" + strconv.FormatUint(uint64(g), 10)
	case uint64:
		return "g:" + strconv.FormatUint(g, 10)
	default:
		return "s:" + fmt.Sprint(v)
	}
}

func stringValue(v reflect.Value) string {
	for v.Kind() == reflect.Pointer || v.Kind() == reflect.Interface {
		if v.IsNil() {
			return ""
		}
		v = v.Elem()
	}
	switch v.Kind() {
	case reflect.String:
		return v.String()
	case reflect.Slice:
		if v.Type().Elem().Kind() == reflect.Uint8 {
			return string(v.Bytes())
		}
	}
	return fmt.Sprint(v.Interface())
}

func boolValue(v reflect.Value) bool {
	for v.Kind() == reflect.Pointer || v.Kind() == reflect.Interface {
		if v.IsNil() {
			return false
		}
		v = v.Elem()
	}
	if v.Kind() == reflect.Bool {
		return v.Bool()
	}
	b, _ := strconv.ParseBool(fmt.Sprint(v.Interface()))
	return b
}
