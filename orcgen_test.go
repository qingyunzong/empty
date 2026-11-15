package dataeng

import (
	"bytes"
	"compress/zlib"
	"fmt"
	"os"
	"path/filepath"
	"testing"
	"time"
)

type q0206TestRow map[string]any

type q0206TestSchema struct {
	timezone        string
	writerVersion   uint32
	hasVersion      bool
	legacyStats     bool
	legacyEpoch2015 bool
	compression     CompressionKind
	stride          int
	bloomColumns    []string
	omitIndex       bool
	omitMetadata    bool
	omitFooterStats bool
	noRowStats      bool
}

func q0206BuildTestORC(t *testing.T, schema q0206TestSchema, stripes [][]q0206TestRow) string {
	t.Helper()
	if schema.compression == 0 {
		schema.compression = CompressionNone
	}
	if schema.stride <= 0 {
		schema.stride = 2
	}
	if !schema.hasVersion {
		schema.writerVersion = 0
	}
	var out bytes.Buffer
	out.WriteString("ORC")

	type stripeBuilt struct {
		info       stripeInformation
		footer     []byte
		stripeStat []*ColumnStatistics
	}
	var built []stripeBuilt
	for _, rows := range stripes {
		stripeOffset := uint64(out.Len())
		indexStreams := q0206WriteStripeIndexStreams(t, schema, rows)
		indexLength := uint64(0)
		for _, s := range indexStreams {
			out.Write(s.data)
			indexLength += uint64(len(s.data))
		}
		var sf []byte
		for _, s := range indexStreams {
			msg := appendVarintField(nil, 1, uint64(s.kind))
			msg = appendVarintField(msg, 2, uint64(s.column))
			msg = appendVarintField(msg, 3, uint64(len(s.data)))
			sf = appendBytesField(sf, 1, msg)
		}
		for id := uint32(0); id < 4; id++ {
			enc := appendVarintField(nil, 1, uint64(EncodingDirect))
			if id == 3 {
				enc = appendVarintField(enc, 3, 1)
			}
			sf = appendBytesField(sf, 2, enc)
		}
		sf = appendStringField(sf, 3, schema.timezone)
		stripeFooter := q0206Compress(sf, schema.compression)
		out.Write(stripeFooter)
		built = append(built, stripeBuilt{
			info: stripeInformation{
				Offset:       stripeOffset,
				IndexLength:  indexLength,
				DataLength:   0,
				FooterLength: uint64(len(stripeFooter)),
				NumberOfRows: uint64(len(rows)),
			},
			footer:     stripeFooter,
			stripeStat: q0206BuildStripeStats(schema, rows),
		})
	}

	// Metadata
	var meta []byte
	for _, b := range built {
		var ss []byte
		for _, s := range b.stripeStat {
			ss = appendBytesField(ss, 1, q0206MarshalColumnStats(s))
		}
		meta = appendBytesField(meta, 1, ss)
	}
	metaCompressed := q0206Compress(meta, schema.compression)
	if schema.omitMetadata {
		metaCompressed = nil
	} else {
		out.Write(metaCompressed)
	}

	types := []byte{}
	types = appendBytesField(types, 4, q0206MarshalType(KindStruct, []uint32{1, 2, 3, 4}, []string{"id", "name", "ts", "flag"}))
	types = appendBytesField(types, 4, q0206MarshalType(KindLong, nil, nil))
	types = appendBytesField(types, 4, q0206MarshalType(KindString, nil, nil))
	types = appendBytesField(types, 4, q0206MarshalType(KindTimestamp, nil, nil))
	types = appendBytesField(types, 4, q0206MarshalType(KindBoolean, nil, nil))

	var foot []byte
	foot = appendVarintField(foot, 1, 3)
	foot = appendVarintField(foot, 2, uint64(out.Len()))
	for _, b := range built {
		si := appendVarintField(nil, 1, b.info.Offset)
		si = appendVarintField(si, 2, b.info.IndexLength)
		si = appendVarintField(si, 3, b.info.DataLength)
		si = appendVarintField(si, 4, b.info.FooterLength)
		si = appendVarintField(si, 5, b.info.NumberOfRows)
		foot = appendBytesField(foot, 3, si)
	}
	foot = append(foot, types...)
	totalRows := uint64(0)
	for _, s := range stripes {
		totalRows += uint64(len(s))
	}
	foot = appendVarintField(foot, 6, totalRows)
	if !schema.omitFooterStats {
		fileStats := q0206BuildStripeStats(schema, q0206FlattenRows(stripes))
		for _, s := range fileStats {
			foot = appendBytesField(foot, 7, q0206MarshalColumnStats(s))
		}
	}
	foot = appendVarintField(foot, 8, uint64(schema.stride))
	foot = appendStringField(foot, 9, "dataeng-test-writer")
	foot = appendVarintField(foot, 11, 2)
	footCompressed := q0206Compress(foot, schema.compression)
	out.Write(footCompressed)

	ps := appendVarintField(nil, 1, uint64(len(footCompressed)))
	ps = appendVarintField(ps, 2, uint64(schema.compression))
	ps = appendVarintField(ps, 3, 256*1024)
	ps = appendPackedUvarints(ps, 4, []uint64{0, 12})
	ps = appendVarintField(ps, 5, uint64(len(metaCompressed)))
	if schema.hasVersion {
		ps = appendVarintField(ps, 6, uint64(schema.writerVersion))
	}
	ps = appendStringField(ps, 8000, "ORC")
	out.Write(ps)
	out.WriteByte(byte(len(ps)))
	out.WriteString("ORC")

	path := filepath.Join(t.TempDir(), "test.orc")
	if err := os.WriteFile(path, out.Bytes(), 0o644); err != nil {
		t.Fatal(err)
	}
	return path
}

type q0206IndexStream struct {
	kind   StreamKind
	column uint32
	data   []byte
}

func q0206WriteStripeIndexStreams(t *testing.T, schema q0206TestSchema, rows []q0206TestRow) []q0206IndexStream {
	t.Helper()
	if schema.omitIndex {
		return nil
	}
	groups := groupCount(uint64(len(rows)), schema.stride)
	var out []q0206IndexStream
	for col := uint32(1); col <= 4; col++ {
		var ri []byte
		for g := 0; g < groups; g++ {
			start := g * schema.stride
			end := start + schema.stride
			if end > len(rows) {
				end = len(rows)
			}
			st := q0206BuildColumnStats(schema, rows[start:end], col)
			entry := []byte{}
			if g > 0 {
				entry = appendPackedUvarints(entry, 1, []uint64{uint64(g * 7)})
			}
			if !schema.noRowStats {
				entry = appendBytesField(entry, 2, q0206MarshalColumnStats(st))
			}
			if len(entry) > 0 {
				ri = appendBytesField(ri, 1, entry)
			}
		}
		if len(ri) > 0 {
			out = append(out, q0206IndexStream{kind: StreamRowIndex, column: col, data: ri})
		}
	}
	for _, name := range schema.bloomColumns {
		col := q0206ColumnIDForName(name)
		if col == 0 {
			continue
		}
		var bloom []byte
		for g := 0; g < groups; g++ {
			start := g * schema.stride
			end := start + schema.stride
			if end > len(rows) {
				end = len(rows)
			}
			bf := q0206BuildBloom(name, rows[start:end])
			idx := appendBytesField(nil, 1, bf)
			bloom = appendUvarint(bloom, uint64(len(idx)))
			bloom = append(bloom, idx...)
		}
		out = append(out, q0206IndexStream{kind: StreamBloomFilter, column: col, data: bloom})
	}
	return out
}

func q0206ColumnIDForName(name string) uint32 {
	switch name {
	case "id":
		return 1
	case "name":
		return 2
	case "ts":
		return 3
	case "flag":
		return 4
	}
	return 0
}

func q0206FlattenRows(stripes [][]q0206TestRow) []q0206TestRow {
	var out []q0206TestRow
	for _, s := range stripes {
		out = append(out, s...)
	}
	return out
}

func q0206MarshalType(kind ColumnKind, subtypes []uint32, names []string) []byte {
	b := appendVarintField(nil, 1, uint64(kind))
	if len(subtypes) > 0 {
		b = appendPackedUvarints(b, 2, q0206Uint64Slice(subtypes))
	}
	for _, name := range names {
		b = appendStringField(b, 3, name)
	}
	return b
}

func q0206Uint64Slice(v []uint32) []uint64 {
	out := make([]uint64, len(v))
	for i := range v {
		out[i] = uint64(v[i])
	}
	return out
}

func q0206Compress(data []byte, codec CompressionKind) []byte {
	if codec == CompressionNone {
		return append([]byte(nil), data...)
	}
	var compressed bytes.Buffer
	zw := zlib.NewWriter(&compressed)
	if _, err := zw.Write(data); err != nil {
		panic(err)
	}
	if err := zw.Close(); err != nil {
		panic(err)
	}
	chunk := compressed.Bytes()
	header := len(chunk) << 1 // compressed chunk, low bit clear
	out := []byte{byte(header), byte(header >> 8), byte(header >> 16)}
	return append(out, chunk...)
}

func q0206BuildStripeStats(schema q0206TestSchema, rows []q0206TestRow) []*ColumnStatistics {
	out := make([]*ColumnStatistics, 5)
	out[0] = &ColumnStatistics{}
	for i := uint32(1); i <= 4; i++ {
		out[i] = q0206BuildColumnStats(schema, rows, i)
	}
	return out
}

func q0206BuildColumnStats(schema q0206TestSchema, rows []q0206TestRow, col uint32) *ColumnStatistics {
	s := &ColumnStatistics{}
	var nulls bool
	for _, row := range rows {
		key := []string{"", "id", "name", "ts", "flag"}[col]
		if row[key] == nil {
			nulls = true
			continue
		}
		s.NumberOfValues++
		s.HasNumberOfValues = true
	}
	if len(rows) > 0 {
		s.HasNull = nulls
		s.HasNullSet = true
	}
	switch col {
	case 1:
		var min, max int64
		first := true
		for _, row := range rows {
			v, ok := row["id"].(int64)
			if !ok {
				continue
			}
			if first || v < min {
				min = v
			}
			if first || v > max {
				max = v
			}
			first = false
		}
		if !first {
			s.Integer = &IntegerStatistics{Minimum: min, Maximum: max, HasMinimum: true, HasMaximum: true}
		}
	case 2:
		var min, max string
		first := true
		for _, row := range rows {
			v, ok := row["name"].(string)
			if !ok {
				continue
			}
			if first || v < min {
				min = v
			}
			if first || v > max {
				max = v
			}
			first = false
		}
		if !first {
			s.String = &StringStatistics{Minimum: min, Maximum: max, HasMinimum: true, HasMaximum: true}
		}
	case 3:
		var min, max time.Time
		var minNanos, maxNanos uint32
		first := true
		for _, row := range rows {
			v, ok := row["ts"].(time.Time)
			if !ok {
				continue
			}
			if first || v.Before(min) {
				min = v
				minNanos = uint32(v.Nanosecond() % 1e6)
			}
			if first || v.After(max) {
				max = v
				maxNanos = uint32(v.Nanosecond() % 1e6)
			}
			first = false
		}
		if !first {
			s.Timestamp = &TimestampStatistics{
				MinimumNanos:    minNanos,
				MaximumNanos:    maxNanos,
				HasMinimumNanos: true,
				HasMaximumNanos: true,
			}
			if schema.legacyStats {
				loc, err := loadWriterTimezone(schema.timezone)
				if err != nil {
					loc = time.UTC
				}
				s.Timestamp.Minimum = q0206WallMillis(min, loc)
				s.Timestamp.Maximum = q0206WallMillis(max, loc)
				if schema.legacyEpoch2015 {
					s.Timestamp.Minimum -= orc2015EpochMillis
					s.Timestamp.Maximum -= orc2015EpochMillis
				}
				s.Timestamp.HasMinimum = true
				s.Timestamp.HasMaximum = true
			} else {
				s.Timestamp.MinimumUTC = min.UnixMilli()
				s.Timestamp.MaximumUTC = max.UnixMilli()
				s.Timestamp.HasMinimumUTC = true
				s.Timestamp.HasMaximumUTC = true
			}
		}
	case 4:
		var falseCount, trueCount uint64
		for _, row := range rows {
			v, ok := row["flag"].(bool)
			if !ok {
				continue
			}
			if v {
				trueCount++
			} else {
				falseCount++
			}
		}
		if falseCount+trueCount > 0 {
			s.Bucket = &BucketStatistics{Count: []uint64{falseCount, trueCount}}
		}
	}
	return s
}

func q0206WallMillis(t time.Time, loc *time.Location) int64 {
	local := t.In(loc)
	y, m, d := local.Date()
	h, min, sec := local.Clock()
	return time.Date(y, m, d, h, min, sec, local.Nanosecond(), time.UTC).UnixMilli()
}

func q0206MarshalColumnStats(s *ColumnStatistics) []byte {
	var b []byte
	if s.HasNumberOfValues {
		b = appendVarintField(b, 1, s.NumberOfValues)
	}
	if s.Integer != nil {
		var x []byte
		if s.Integer.HasMinimum {
			x = appendSvarintField(x, 1, s.Integer.Minimum)
		}
		if s.Integer.HasMaximum {
			x = appendSvarintField(x, 2, s.Integer.Maximum)
		}
		if s.Integer.HasSum {
			x = appendSvarintField(x, 3, s.Integer.Sum)
		}
		b = appendBytesField(b, 2, x)
	}
	if s.Double != nil {
		var x []byte
		if s.Double.HasMinimum {
			x = appendFixed64Field(x, 1, mathFloat64bits(s.Double.Minimum))
		}
		if s.Double.HasMaximum {
			x = appendFixed64Field(x, 2, mathFloat64bits(s.Double.Maximum))
		}
		b = appendBytesField(b, 3, x)
	}
	if s.String != nil {
		var x []byte
		if s.String.HasMinimum {
			x = appendStringField(x, 1, s.String.Minimum)
		}
		if s.String.HasMaximum {
			x = appendStringField(x, 2, s.String.Maximum)
		}
		if s.String.HasLower {
			x = appendStringField(x, 4, s.String.LowerBound)
		}
		if s.String.HasUpper {
			x = appendStringField(x, 5, s.String.UpperBound)
		}
		b = appendBytesField(b, 4, x)
	}
	if s.Bucket != nil {
		var x []byte
		x = appendPackedUvarints(x, 1, s.Bucket.Count)
		b = appendBytesField(b, 5, x)
	}
	if s.Decimal != nil {
		var x []byte
		if s.Decimal.HasMinimum {
			x = appendStringField(x, 1, s.Decimal.Minimum)
		}
		if s.Decimal.HasMaximum {
			x = appendStringField(x, 2, s.Decimal.Maximum)
		}
		b = appendBytesField(b, 6, x)
	}
	if s.Date != nil {
		var x []byte
		if s.Date.HasMinimum {
			x = appendSvarintField(x, 1, int64(s.Date.Minimum))
		}
		if s.Date.HasMaximum {
			x = appendSvarintField(x, 2, int64(s.Date.Maximum))
		}
		if s.Date.HasLower {
			x = appendSvarintField(x, 3, int64(s.Date.LowerBound))
		}
		if s.Date.HasUpper {
			x = appendSvarintField(x, 4, int64(s.Date.UpperBound))
		}
		b = appendBytesField(b, 7, x)
	}
	if s.Binary != nil {
		var x []byte
		if s.Binary.HasSum {
			x = appendSvarintField(x, 1, s.Binary.Sum)
		}
		b = appendBytesField(b, 8, x)
	}
	if s.Timestamp != nil {
		var x []byte
		if s.Timestamp.HasMinimum {
			x = appendSvarintField(x, 1, s.Timestamp.Minimum)
		}
		if s.Timestamp.HasMaximum {
			x = appendSvarintField(x, 2, s.Timestamp.Maximum)
		}
		if s.Timestamp.HasMinimumUTC {
			x = appendSvarintField(x, 3, s.Timestamp.MinimumUTC)
		}
		if s.Timestamp.HasMaximumUTC {
			x = appendSvarintField(x, 4, s.Timestamp.MaximumUTC)
		}
		if s.Timestamp.HasMinimumNanos {
			x = appendVarintField(x, 5, uint64(s.Timestamp.MinimumNanos))
		}
		if s.Timestamp.HasMaximumNanos {
			x = appendVarintField(x, 6, uint64(s.Timestamp.MaximumNanos))
		}
		b = appendBytesField(b, 9, x)
	}
	if s.HasNullSet {
		v := uint64(0)
		if s.HasNull {
			v = 1
		}
		b = appendVarintField(b, 10, v)
	}
	return b
}

func q0206BuildBloom(column string, rows []q0206TestRow) []byte {
	const words = 8
	const k = 4
	bits := make([]uint64, words)
	add := func(hash uint64) {
		h1 := int32(uint32(hash))
		h2 := int32(uint32(hash >> 32))
		for i := uint32(1); i <= k; i++ {
			combined := int32(int64(h1) + int64(i)*int64(h2))
			if combined < 0 {
				combined = ^combined
			}
			pos := uint32(combined) % (words * 64)
			bits[pos>>6] |= uint64(1) << (pos & 63)
		}
	}
	for _, row := range rows {
		switch column {
		case "id":
			if v, ok := row["id"].(int64); ok {
				add(wangHash64(uint64(v)))
			}
		case "name":
			if v, ok := row["name"].(string); ok {
				h1, _ := murmur3x64_128([]byte(v), 0)
				add(h1)
			}
		case "ts":
			if v, ok := row["ts"].(time.Time); ok {
				add(wangHash64(uint64(v.UnixMilli())))
			}
		case "flag":
			if v, ok := row["flag"].(bool); ok {
				x := int64(0)
				if v {
					x = 1
				}
				add(wangHash64(uint64(x)))
			}
		}
	}
	b := appendVarintField(nil, 1, k)
	for _, word := range bits {
		b = appendFixed64Field(b, 2, word)
	}
	return b
}

func q0206RowValueMap(row q0206TestRow) map[string]Value {
	out := map[string]Value{}
	if v, ok := row["id"].(int64); ok {
		out["id"] = IntValue(v)
	} else {
		out["id"] = NullValue()
	}
	if v, ok := row["name"].(string); ok {
		out["name"] = StringValue(v)
	} else {
		out["name"] = NullValue()
	}
	if v, ok := row["ts"].(time.Time); ok {
		out["ts"] = TimestampValue(v)
	} else {
		out["ts"] = NullValue()
	}
	if v, ok := row["flag"].(bool); ok {
		out["flag"] = BoolValue(v)
	} else {
		out["flag"] = NullValue()
	}
	return out
}

func q0206SimpleRows() []q0206TestRow {
	return []q0206TestRow{
		{"id": int64(1), "name": "alpha", "ts": time.Date(2020, 1, 1, 10, 0, 0, 0, time.UTC), "flag": true},
		{"id": int64(2), "name": "bravo", "ts": time.Date(2020, 1, 2, 10, 0, 0, 0, time.UTC), "flag": false},
		{"id": int64(3), "name": "charlie", "ts": time.Date(2020, 1, 3, 10, 0, 0, 0, time.UTC), "flag": true},
		{"id": int64(4), "name": "delta", "ts": time.Date(2020, 1, 4, 10, 0, 0, 0, time.UTC), "flag": false},
		{"id": int64(5), "name": "echo", "ts": time.Date(2020, 1, 5, 10, 0, 0, 0, time.UTC), "flag": true},
		{"id": int64(6), "name": "foxtrot", "ts": time.Date(2020, 1, 6, 10, 0, 0, 0, time.UTC), "flag": false},
	}
}

func TestQ0206ParseSyntheticFile(t *testing.T) {
	rows := q0206SimpleRows()
	path := q0206BuildTestORC(t, q0206TestSchema{timezone: "UTC", writerVersion: 6, hasVersion: true, stride: 2, bloomColumns: []string{"id", "name"}}, [][]q0206TestRow{rows})
	r, err := Open(path)
	if err != nil {
		t.Fatal(err)
	}
	defer r.Close()
	if got, want := r.NumberOfRows(), int64(len(rows)); got != want {
		t.Fatalf("rows = %d want %d", got, want)
	}
	if got, want := len(r.Stripes()), 1; got != want {
		t.Fatalf("stripes = %d want %d", got, want)
	}
	if r.RowIndexStride() != 2 {
		t.Fatalf("stride = %d", r.RowIndexStride())
	}
	groups, err := r.RowGroups()
	if err != nil {
		t.Fatal(err)
	}
	if len(groups) != 3 {
		t.Fatalf("groups = %d want 3", len(groups))
	}
	if groups[0].Statistics[1] == nil || groups[0].Statistics[1].Integer == nil {
		t.Fatalf("missing id stats: %#v", groups[0].Statistics[1])
	}
	if groups[0].Statistics[1].Integer.Minimum != 1 || groups[0].Statistics[1].Integer.Maximum != 2 {
		t.Fatalf("bad id stats: %#v", groups[0].Statistics[1].Integer)
	}
	if groups[0].BloomFilters[1] == nil || !groups[0].BloomFilters[1].Trusted() {
		t.Fatalf("missing trusted bloom filter")
	}
}

func TestQ0206PruneZeroFalseNegatives(t *testing.T) {
	rows := q0206SimpleRows()
	path := q0206BuildTestORC(t, q0206TestSchema{timezone: "UTC", writerVersion: 6, hasVersion: true, stride: 2, bloomColumns: []string{"id", "name"}}, [][]q0206TestRow{rows})
	r, err := Open(path)
	if err != nil {
		t.Fatal(err)
	}
	defer r.Close()

	preds := []Predicate{
		Eq("id", IntValue(4)),
		Lt("id", IntValue(3)),
		Ge("id", IntValue(3)),
		In("id", IntValue(1), IntValue(5)),
		In("id", NullValue(), IntValue(3)),
		Eq("name", StringValue("echo")),
		Lt("name", StringValue("charlie")),
		Eq("flag", BoolValue(true)),
		IsNull("id"),
		Eq("id", NullValue()),
	}
	for _, p := range preds {
		res, err := r.Prune(p)
		if err != nil {
			t.Fatalf("%s: %v", p, err)
		}
		for i, row := range rows {
			if p.Evaluate(q0206RowValueMap(row)) && !ContainsRow(res.Ranges, int64(i)) {
				t.Fatalf("%s: false negative at row %d", p, i)
			}
		}
		t.Logf("%s -> %v (%d/%d rows)", p, res.Ranges, res.CandidateRows, res.TotalRows)
	}
}

func TestQ0206PruneCanSkipGroups(t *testing.T) {
	rows := q0206SimpleRows()
	path := q0206BuildTestORC(t, q0206TestSchema{timezone: "UTC", writerVersion: 6, hasVersion: true, stride: 2, bloomColumns: []string{"id", "name"}}, [][]q0206TestRow{rows})
	r, err := Open(path)
	if err != nil {
		t.Fatal(err)
	}
	defer r.Close()
	res, err := r.Prune(Eq("id", IntValue(6)))
	if err != nil {
		t.Fatal(err)
	}
	if len(res.Ranges) != 1 || res.Ranges[0].Start != 4 || res.Ranges[0].End != 6 {
		t.Fatalf("ranges = %v", res.Ranges)
	}
	res, err = r.Prune(Eq("name", StringValue("not-present")))
	if err != nil {
		t.Fatal(err)
	}
	if len(res.Ranges) != 0 {
		t.Fatalf("expected bloom filter to prune, ranges = %v", res.Ranges)
	}
}

func TestQ0206ZlibFile(t *testing.T) {
	rows := q0206SimpleRows()
	path := q0206BuildTestORC(t, q0206TestSchema{timezone: "UTC", writerVersion: 6, hasVersion: true, stride: 2, compression: CompressionZlib}, [][]q0206TestRow{rows})
	r, err := Open(path)
	if err != nil {
		t.Fatal(err)
	}
	defer r.Close()
	if got, want := r.NumberOfRows(), int64(len(rows)); got != want {
		t.Fatalf("rows = %d want %d", got, want)
	}
	res, err := r.Prune(Ge("id", IntValue(5)))
	if err != nil {
		t.Fatal(err)
	}
	for i, row := range rows {
		if Ge("id", IntValue(5)).Evaluate(q0206RowValueMap(row)) && !ContainsRow(res.Ranges, int64(i)) {
			t.Fatalf("false negative at row %d", i)
		}
	}
}

func TestQ0206LegacyTimezoneStats(t *testing.T) {
	loc, err := time.LoadLocation("America/New_York")
	if err != nil {
		t.Fatal(err)
	}
	// 01:30 on the fall-back day is ambiguous in New York. A legacy writer
	// records local wall time, so both UTC instants must be considered.
	ambiguous := time.Date(2020, 11, 1, 1, 30, 0, 0, loc)
	rows := []q0206TestRow{
		{"id": int64(1), "name": "before", "ts": ambiguous.Add(-2 * time.Hour), "flag": true},
		{"id": int64(2), "name": "ambiguous", "ts": ambiguous, "flag": true},
		{"id": int64(3), "name": "after", "ts": ambiguous.Add(2 * time.Hour), "flag": true},
	}
	path := q0206BuildTestORC(t, q0206TestSchema{timezone: "America/New_York", writerVersion: 3, hasVersion: true, legacyStats: true, stride: 3}, [][]q0206TestRow{rows})
	r, err := OpenWithOptions(path, Options{TimestampMode: TimestampUnixMillis})
	if err != nil {
		t.Fatal(err)
	}
	defer r.Close()
	// The quoted instant is the second 01:30; a safe result must include the
	// row group even though local min/max mapping is not unique.
	res, err := r.Prune(Eq("ts", TimestampValue(ambiguous)))
	if err != nil {
		t.Fatal(err)
	}
	for i, row := range rows {
		if Eq("ts", TimestampValue(ambiguous)).Evaluate(q0206RowValueMap(row)) && !ContainsRow(res.Ranges, int64(i)) {
			t.Fatalf("false negative at row %d", i)
		}
	}
	if len(res.Ranges) == 0 {
		t.Fatal("ambiguous DST time was incorrectly pruned")
	}
}

func TestQ0206OldWriterMissingTimezoneIsMayMatch(t *testing.T) {
	rows := q0206SimpleRows()
	path := q0206BuildTestORC(t, q0206TestSchema{timezone: "", writerVersion: 0, stride: 2, legacyStats: true}, [][]q0206TestRow{rows})
	r, err := Open(path)
	if err != nil {
		t.Fatal(err)
	}
	defer r.Close()
	res, err := r.Prune(Eq("ts", TimestampValue(time.Date(2020, 1, 1, 10, 0, 0, 0, time.UTC))))
	if err != nil {
		t.Fatal(err)
	}
	if res.CandidateRows != res.TotalRows {
		t.Fatalf("missing timezone should may-match all, got %d/%d", res.CandidateRows, res.TotalRows)
	}
}

func TestQ0206NewWriterWithoutUTCStatsIsMayMatch(t *testing.T) {
	rows := q0206SimpleRows()
	path := q0206BuildTestORC(t, q0206TestSchema{timezone: "UTC", writerVersion: 6, hasVersion: true, legacyStats: true, stride: 2}, [][]q0206TestRow{rows})
	r, err := Open(path)
	if err != nil {
		t.Fatal(err)
	}
	defer r.Close()
	res, err := r.Prune(Lt("ts", TimestampValue(time.Date(1990, 1, 1, 0, 0, 0, 0, time.UTC))))
	if err != nil {
		t.Fatal(err)
	}
	if res.CandidateRows != res.TotalRows {
		t.Fatalf("inconsistent timestamp stats should may-match all, got %d/%d", res.CandidateRows, res.TotalRows)
	}
}

func TestQ0206VerifyNoFalseNegatives(t *testing.T) {
	rows := q0206SimpleRows()
	path := q0206BuildTestORC(t, q0206TestSchema{timezone: "UTC", writerVersion: 6, hasVersion: true, stride: 2}, [][]q0206TestRow{rows})
	r, err := Open(path)
	if err != nil {
		t.Fatal(err)
	}
	defer r.Close()
	if err := r.VerifyNoFalseNegatives(Ge("id", IntValue(2)), func(row int64) (map[string]Value, error) {
		if row < 0 || row >= int64(len(rows)) {
			return nil, fmt.Errorf("bad row %d", row)
		}
		return q0206RowValueMap(rows[row]), nil
	}); err != nil {
		t.Fatal(err)
	}
}

func TestQ0206MultiStripeNulls(t *testing.T) {
	s1 := []q0206TestRow{
		{"id": int64(1), "name": nil, "ts": time.Date(2021, 1, 1, 0, 0, 0, 0, time.UTC), "flag": true},
		{"id": int64(2), "name": nil, "ts": time.Date(2021, 1, 2, 0, 0, 0, 0, time.UTC), "flag": true},
		{"id": int64(3), "name": "x", "ts": time.Date(2021, 1, 3, 0, 0, 0, 0, time.UTC), "flag": true},
	}
	s2 := []q0206TestRow{
		{"id": int64(4), "name": "y", "ts": time.Date(2021, 1, 4, 0, 0, 0, 0, time.UTC), "flag": true},
		{"id": int64(5), "name": nil, "ts": time.Date(2021, 1, 5, 0, 0, 0, 0, time.UTC), "flag": true},
	}
	rows := append(append([]q0206TestRow{}, s1...), s2...)
	path := q0206BuildTestORC(t, q0206TestSchema{timezone: "UTC", writerVersion: 6, hasVersion: true, stride: 2, bloomColumns: []string{"name"}}, [][]q0206TestRow{s1, s2})
	r, err := Open(path)
	if err != nil {
		t.Fatal(err)
	}
	defer r.Close()
	if got := len(r.Stripes()); got != 2 {
		t.Fatalf("stripes = %d", got)
	}
	preds := []Predicate{
		IsNull("name"),
		In("name", StringValue("x"), StringValue("y")),
		Eq("id", IntValue(5)),
		Ge("id", IntValue(4)),
	}
	for _, p := range preds {
		res, err := r.Prune(p)
		if err != nil {
			t.Fatal(err)
		}
		for i, row := range rows {
			if p.Evaluate(q0206RowValueMap(row)) && !ContainsRow(res.Ranges, int64(i)) {
				t.Fatalf("%s: false negative at row %d (ranges %v)", p, i, res.Ranges)
			}
		}
	}
	res, err := r.Prune(IsNull("name"))
	if err != nil {
		t.Fatal(err)
	}
	if len(res.Ranges) != 2 {
		t.Fatalf("IS NULL ranges = %v", res.Ranges)
	}
}

func TestQ0206Legacy2015Epoch(t *testing.T) {
	rows := q0206SimpleRows()
	path := q0206BuildTestORC(t, q0206TestSchema{
		timezone: "UTC", writerVersion: 3, hasVersion: true,
		legacyStats: true, legacyEpoch2015: true, stride: 2,
	}, [][]q0206TestRow{rows})
	r, err := Open(path)
	if err != nil {
		t.Fatal(err)
	}
	defer r.Close()
	res, err := r.Prune(Eq("ts", TimestampValue(time.Date(2020, 1, 3, 10, 0, 0, 0, time.UTC))))
	if err != nil {
		t.Fatal(err)
	}
	for i, row := range rows {
		if Eq("ts", TimestampValue(time.Date(2020, 1, 3, 10, 0, 0, 0, time.UTC))).Evaluate(q0206RowValueMap(row)) && !ContainsRow(res.Ranges, int64(i)) {
			t.Fatalf("false negative at row %d, ranges %v", i, res.Ranges)
		}
	}
	if len(res.Ranges) == 0 {
		t.Fatal("2015-relative stats were incorrectly pruned")
	}
}

func TestQ0206MissingRowStatsWithBloom(t *testing.T) {
	rows := q0206SimpleRows()
	path := q0206BuildTestORC(t, q0206TestSchema{
		timezone: "UTC", writerVersion: 6, hasVersion: true, stride: 2,
		bloomColumns: []string{"ts"}, omitMetadata: true, omitFooterStats: true, noRowStats: true,
	}, [][]q0206TestRow{rows})
	r, err := Open(path)
	if err != nil {
		t.Fatal(err)
	}
	defer r.Close()
	// A timestamp far outside the data must be rejected by the bloom filter
	// when no statistics are available.
	res, err := r.Prune(Eq("ts", TimestampValue(time.Date(1995, 6, 1, 0, 0, 0, 0, time.UTC))))
	if err != nil {
		t.Fatal(err)
	}
	if len(res.Ranges) != 0 {
		t.Fatalf("expected bloom-only pruning, got %v", res.Ranges)
	}
}

func TestQ0206MissingEverythingIsMayMatch(t *testing.T) {
	rows := q0206SimpleRows()
	path := q0206BuildTestORC(t, q0206TestSchema{
		timezone: "UTC", writerVersion: 6, hasVersion: true, stride: 2,
		omitIndex: true, omitMetadata: true, omitFooterStats: true,
	}, [][]q0206TestRow{rows})
	r, err := Open(path)
	if err != nil {
		t.Fatal(err)
	}
	defer r.Close()
	res, err := r.Prune(Lt("id", IntValue(-100)))
	if err != nil {
		t.Fatal(err)
	}
	if res.CandidateRows != res.TotalRows || len(res.Ranges) != 1 || res.Ranges[0].End != 6 {
		t.Fatalf("missing statistics should may-match all, got %+v", res)
	}
}

func TestQ0206StripeStatisticsFallback(t *testing.T) {
	rows := q0206SimpleRows()
	path := q0206BuildTestORC(t, q0206TestSchema{
		timezone: "UTC", writerVersion: 6, hasVersion: true, stride: 2,
		omitIndex: true,
	}, [][]q0206TestRow{rows})
	r, err := Open(path)
	if err != nil {
		t.Fatal(err)
	}
	defer r.Close()
	res, err := r.Prune(Lt("id", IntValue(-100)))
	if err != nil {
		t.Fatal(err)
	}
	if len(res.Ranges) != 0 {
		t.Fatalf("stripe statistics should prune, got %v", res.Ranges)
	}
	res, err = r.Prune(Ge("id", IntValue(1)))
	if err != nil {
		t.Fatal(err)
	}
	if res.CandidateRows != res.TotalRows {
		t.Fatalf("expected whole stripe may-match, got %d/%d", res.CandidateRows, res.TotalRows)
	}
	res, err = r.Prune(IsNull("name"))
	if err != nil {
		t.Fatal(err)
	}
	if len(res.Ranges) != 0 {
		t.Fatalf("stripe stats prove no NULLs, got %v", res.Ranges)
	}
}

func TestQ0206FooterStatisticsFallback(t *testing.T) {
	rows := q0206SimpleRows()
	path := q0206BuildTestORC(t, q0206TestSchema{
		timezone: "UTC", writerVersion: 6, hasVersion: true, stride: 2,
		omitIndex: true, omitMetadata: true,
	}, [][]q0206TestRow{rows})
	r, err := Open(path)
	if err != nil {
		t.Fatal(err)
	}
	defer r.Close()
	res, err := r.Prune(Gt("id", IntValue(1000)))
	if err != nil {
		t.Fatal(err)
	}
	if len(res.Ranges) != 0 {
		t.Fatalf("footer statistics should prune, got %v", res.Ranges)
	}
}

func TestQ0206TimestampRangeAcrossDST(t *testing.T) {
	loc, err := time.LoadLocation("America/New_York")
	if err != nil {
		t.Fatal(err)
	}
	base := time.Date(2020, 11, 1, 0, 30, 0, 0, loc)
	rows := []q0206TestRow{
		{"id": int64(1), "name": "a", "ts": base, "flag": true},
		{"id": int64(2), "name": "b", "ts": base.Add(time.Hour), "flag": true},
		{"id": int64(3), "name": "c", "ts": base.Add(2 * time.Hour), "flag": true},
		{"id": int64(4), "name": "d", "ts": base.Add(3 * time.Hour), "flag": true},
	}
	path := q0206BuildTestORC(t, q0206TestSchema{timezone: "America/New_York", writerVersion: 3, hasVersion: true, legacyStats: true, stride: 2}, [][]q0206TestRow{rows})
	r, err := OpenWithOptions(path, Options{TimestampMode: TimestampAuto})
	if err != nil {
		t.Fatal(err)
	}
	defer r.Close()
	from := time.Date(2020, 11, 1, 1, 30, 0, 0, loc)
	to := from.Add(90 * time.Minute)
	p := And(Ge("ts", TimestampValue(from)), Lt("ts", TimestampValue(to)))
	res, err := r.Prune(p)
	if err != nil {
		t.Fatal(err)
	}
	for i, row := range rows {
		if p.Evaluate(q0206RowValueMap(row)) && !ContainsRow(res.Ranges, int64(i)) {
			t.Fatalf("false negative at row %d, ranges %v", i, res.Ranges)
		}
	}
}

func TestQ0206LegacyLocalStatsUseWriterTimezone(t *testing.T) {
	loc, err := time.LoadLocation("America/New_York")
	if err != nil {
		t.Fatal(err)
	}
	ts := time.Date(2020, 1, 15, 10, 0, 0, 0, loc) // 15:00 UTC
	rows := []q0206TestRow{{"id": int64(1), "name": "x", "ts": ts, "flag": true}}
	path := q0206BuildTestORC(t, q0206TestSchema{
		timezone: "America/New_York", writerVersion: 3, hasVersion: true,
		legacyStats: true, stride: 1,
	}, [][]q0206TestRow{rows})
	r, err := OpenWithOptions(path, Options{TimestampMode: TimestampUnixMillis})
	if err != nil {
		t.Fatal(err)
	}
	defer r.Close()
	// The same wall-clock value in UTC is five hours away and must not match.
	res, err := r.Prune(Eq("ts", TimestampValue(time.Date(2020, 1, 15, 10, 0, 0, 0, time.UTC))))
	if err != nil {
		t.Fatal(err)
	}
	if len(res.Ranges) != 0 {
		t.Fatalf("local stats were interpreted as UTC: %v", res.Ranges)
	}
	res, err = r.Prune(Eq("ts", TimestampValue(ts)))
	if err != nil {
		t.Fatal(err)
	}
	if len(res.Ranges) != 1 {
		t.Fatalf("actual local value not selected: %v", res.Ranges)
	}
}

func TestQ0206BloomFilterAbsentValue(t *testing.T) {
	bf := q0206BuildBloom("name", []q0206TestRow{{"name": "alpha"}, {"name": "bravo"}})
	b, err := parseBloomFilter(bf)
	if err != nil {
		t.Fatal(err)
	}
	if !b.MightContainString("alpha") {
		t.Fatal("present value not found")
	}
	if b.MightContainString("zulu") {
		t.Fatal("absent value found (possible but unlikely with this fixture)")
	}
}

func TestQ0206DecompressSnappyLiteral(t *testing.T) {
	// Raw Snappy: uncompressed length 3, literal tag (2<<2), then "abc".
	src := []byte{3, 2 << 2, 'a', 'b', 'c'}
	out, err := decodeSnappy(src, 100)
	if err != nil {
		t.Fatal(err)
	}
	if string(out) != "abc" {
		t.Fatalf("got %q", out)
	}
}

func TestQ0206DecompressLZ4Literal(t *testing.T) {
	// LZ4 token: 3 literals, no match, then "abc".
	out, err := decodeLZ4([]byte{3 << 4, 'a', 'b', 'c'}, 100)
	if err != nil {
		t.Fatal(err)
	}
	if string(out) != "abc" {
		t.Fatalf("got %q", out)
	}
}

func TestQ0206FixedOffsetTimezone(t *testing.T) {
	loc, err := loadWriterTimezone("GMT+08:00")
	if err != nil {
		t.Fatal(err)
	}
	if _, off := time.Date(2020, 1, 1, 0, 0, 0, 0, loc).Zone(); off != 8*3600 {
		t.Fatalf("offset = %d", off)
	}
}

func TestQ0206SpringForwardGapWidens(t *testing.T) {
	loc, err := time.LoadLocation("America/New_York")
	if err != nil {
		t.Fatal(err)
	}
	wall := time.Date(2020, 3, 8, 2, 30, 0, 0, time.UTC).UnixMilli()
	got := possibleInstants(wall, loc)
	if len(got) < 2 {
		t.Fatalf("gap should produce bracketing instants, got %v", got)
	}
	before := time.Date(2020, 3, 8, 1, 30, 0, 0, loc).UnixMilli()
	after := time.Date(2020, 3, 8, 3, 30, 0, 0, loc).UnixMilli()
	if !q0206ContainsInt64(got, before) || !q0206ContainsInt64(got, after) {
		t.Fatalf("gap instants = %v, want %d and %d", got, before, after)
	}
}

func q0206ContainsInt64(v []int64, x int64) bool {
	for _, y := range v {
		if y == x {
			return true
		}
	}
	return false
}

func TestQ0206RangeHelpers(t *testing.T) {
	if !And().Evaluate(nil) {
		t.Fatal("empty and should be true")
	}
	if Or().Evaluate(nil) {
		t.Fatal("empty or should be false")
	}
	if got := len(Between("id", IntValue(1), IntValue(3)).Columns()); got != 2 {
		t.Fatalf("columns = %d", got)
	}
}
