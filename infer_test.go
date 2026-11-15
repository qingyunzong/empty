package dataeng

import (
	"errors"
	"strings"
	"testing"
	"unicode/utf16"
)

func TestInferQuotedCommaBeatsStableExpansion(t *testing.T) {
	data := "a,b,\"x,y\"\nc,d,\"u,v\"\n"
	result, err := Infer([]Sample{{Name: "one.csv", Data: []byte(data)}})
	if err != nil {
		t.Fatalf("Infer: %v", err)
	}
	if result.Ambiguous {
		t.Fatalf("unexpected ambiguity: %v", result.Reasons)
	}
	best := result.Best
	if best.Dialect.Delimiter != ',' {
		t.Fatalf("delimiter = %q, want comma", best.Dialect.Delimiter)
	}
	if best.Dialect.Quote != '"' {
		t.Fatalf("quote = %q, want double quote", best.Dialect.Quote)
	}
	if best.Evidence.DominantWidth != 3 {
		t.Fatalf("dominant width = %d, want 3", best.Evidence.DominantWidth)
	}
	if !best.ValidQuotes {
		t.Fatal("best candidate should have valid quote structure")
	}
	if best.QuotePriority != 3 {
		t.Fatalf("best quote priority = %d, want 3", best.QuotePriority)
	}

	var unquoted *Candidate
	for i := range result.Candidates {
		candidate := &result.Candidates[i]
		if candidate.Dialect.Delimiter == ',' && candidate.Dialect.Quote == 0 {
			unquoted = candidate
			break
		}
	}
	if unquoted == nil {
		t.Fatal("expected a comma/no-quote candidate")
	}
	if unquoted.Evidence.DominantWidth != 4 {
		t.Fatalf("unquoted dominant width = %d, want the stable-looking 4", unquoted.Evidence.DominantWidth)
	}
	if unquoted.ValidQuotes {
		t.Fatal("width-stable unquoted parse must not be considered quote-valid")
	}
	if unquoted.QuotePriority != 0 {
		t.Fatalf("unquoted quote priority = %d, want 0", unquoted.QuotePriority)
	}
	if unquoted.Score >= best.Score {
		t.Fatalf("unquoted score %.3f >= quoted score %.3f", unquoted.Score, best.Score)
	}
	for i := 1; i < len(result.Candidates); i++ {
		previous := result.Candidates[i-1]
		current := result.Candidates[i]
		if current.QuotePriority > previous.QuotePriority {
			t.Fatalf("quote priority increased at %d: %d -> %d", i, previous.QuotePriority, current.QuotePriority)
		}
		if current.QuotePriority == previous.QuotePriority && current.Score > previous.Score+1e-9 {
			t.Fatalf("candidates not sorted by score within tier at %d: %.6f > %.6f",
				i, current.Score, previous.Score)
		}
	}
}

func TestInferSemicolonWithQuotedDelimiters(t *testing.T) {
	data := "a;b;\"x;y\"\r\nc;d;\"u;v\"\r\n"
	result, err := Infer([]Sample{{Name: "semi.csv", Data: []byte(data)}})
	if err != nil {
		t.Fatalf("Infer: %v", err)
	}
	best := result.Best
	if best.Dialect.Delimiter != ';' || best.Dialect.Quote != '"' {
		t.Fatalf("got delimiter=%q quote=%q", best.Dialect.Delimiter, best.Dialect.Quote)
	}
	if best.Dialect.Newline != "\r\n" {
		t.Fatalf("newline = %q, want CRLF", best.Dialect.Newline)
	}
	if best.Evidence.DominantWidth != 3 {
		t.Fatalf("width = %d, want 3", best.Evidence.DominantWidth)
	}
	if best.Evidence.QuotedFields != 2 {
		t.Fatalf("quoted fields = %d, want 2", best.Evidence.QuotedFields)
	}
	if best.Evidence.EmbeddedDelimiters != 2 {
		t.Fatalf("embedded delimiters = %d, want 2", best.Evidence.EmbeddedDelimiters)
	}
}

func TestInferMostlyQuotedPrefersQuoteStructure(t *testing.T) {
	data := "a,b,c\n\"x,y\",1,2\n\"u,v\",3,4\n\"p,q\",5,6\nplain\"quote,7,8\n"
	result, err := Infer([]Sample{{Name: "mostly.csv", Data: []byte(data)}})
	if err != nil {
		t.Fatalf("Infer: %v", err)
	}
	best := result.Best
	if best.Dialect.Delimiter != ',' || best.Dialect.Quote != '"' {
		t.Fatalf("got delimiter=%q quote=%q, reasons=%v", best.Dialect.Delimiter, best.Dialect.Quote, best.Reasons)
	}
	if best.Evidence.DominantWidth != 3 {
		t.Fatalf("width = %d, want 3", best.Evidence.DominantWidth)
	}
}

func TestInferTabSeparated(t *testing.T) {
	data := "id\tvalue\n1\t\"hello\tworld\"\n2\tplain\n"
	result, err := Infer([]Sample{{Name: "tab.tsv", Data: []byte(data)}})
	if err != nil {
		t.Fatalf("Infer: %v", err)
	}
	best := result.Best
	if best.Dialect.Delimiter != '\t' || best.Dialect.Quote != '"' {
		t.Fatalf("got delimiter=%q quote=%q", best.Dialect.Delimiter, best.Dialect.Quote)
	}
	if best.Evidence.DominantWidth != 2 {
		t.Fatalf("width = %d, want 2", best.Evidence.DominantWidth)
	}
}

func TestInferCRLFAndQuotedNewline(t *testing.T) {
	data := "a,b\r\n\"x\r\ny\",2\r\n\"z\",3\r\n"
	result, err := Infer([]Sample{{Name: "crlf.csv", Data: []byte(data)}})
	if err != nil {
		t.Fatalf("Infer: %v", err)
	}
	best := result.Best
	if best.Dialect.Newline != "\r\n" {
		t.Fatalf("newline = %q, want CRLF", best.Dialect.Newline)
	}
	if best.Evidence.Records != 3 {
		t.Fatalf("records = %d, want 3", best.Evidence.Records)
	}
	if best.Evidence.EmbeddedNewlines != 1 {
		t.Fatalf("embedded newlines = %d, want 1", best.Evidence.EmbeddedNewlines)
	}
	if best.Evidence.NewlineCounts["\r\n"] != 3 {
		t.Fatalf("outside CRLF count = %d, want 3", best.Evidence.NewlineCounts["\r\n"])
	}
}

func TestInferCROnlyNewline(t *testing.T) {
	data := "a,b\r1,2\r2,3\r"
	result, err := Infer([]Sample{{Name: "cr.csv", Data: []byte(data)}})
	if err != nil {
		t.Fatalf("Infer: %v", err)
	}
	if result.Best.Dialect.Newline != "\r" {
		t.Fatalf("newline = %q, want CR", result.Best.Dialect.Newline)
	}
	if result.Best.Evidence.Records != 3 {
		t.Fatalf("records = %d, want 3", result.Best.Evidence.Records)
	}
}

func TestInferExcelStyleDoubledQuotes(t *testing.T) {
	data := "id,name,note\r\n1,\"Alice, A.\",\"He said \"\"hi\"\"\"\r\n2,Bob,ok\r\n"
	result, err := Infer([]Sample{{Name: "excel.csv", Data: []byte(data)}})
	if err != nil {
		t.Fatalf("Infer: %v", err)
	}
	best := result.Best
	if best.Dialect.Delimiter != ',' || best.Dialect.Quote != '"' {
		t.Fatalf("got delimiter=%q quote=%q", best.Dialect.Delimiter, best.Dialect.Quote)
	}
	if best.Dialect.EscapeMode() != EscapeDoubled || best.Dialect.Newline != "\r\n" {
		t.Fatalf("got escape=%s newline=%q", best.Dialect.EscapeMode(), best.Dialect.Newline)
	}
	if best.Evidence.DominantWidth != 3 {
		t.Fatalf("width = %d, want 3", best.Evidence.DominantWidth)
	}
	if best.Evidence.DoubledQuoteEscapes != 2 {
		t.Fatalf("doubled escapes = %d, want 2", best.Evidence.DoubledQuoteEscapes)
	}
}

func TestInferUTF16LEWithBOM(t *testing.T) {
	text := "name,note\n\"a\",1\n\"b\",2\n"
	units := utf16.Encode([]rune(text))
	data := append([]byte{0xFF, 0xFE}, make([]byte, len(units)*2)...)
	for i, unit := range units {
		data[2+i*2] = byte(unit)
		data[3+i*2] = byte(unit >> 8)
	}
	result, err := Infer([]Sample{{Name: "utf16.csv", Data: data}})
	if err != nil {
		t.Fatalf("Infer: %v", err)
	}
	best := result.Best
	if best.Dialect.Encoding != EncodingUTF16LE {
		t.Fatalf("encoding = %s, want utf-16le", best.Dialect.Encoding)
	}
	if !best.Dialect.BOM {
		t.Fatal("expected BOM=true")
	}
	if best.Dialect.Delimiter != ',' || best.Dialect.Quote != '"' {
		t.Fatalf("got delimiter=%q quote=%q", best.Dialect.Delimiter, best.Dialect.Quote)
	}
	if best.Evidence.DominantWidth != 2 {
		t.Fatalf("width = %d, want 2", best.Evidence.DominantWidth)
	}
}

func TestInferUTF16LEWithoutBOM(t *testing.T) {
	text := "name,note\nAlice,1\nBob,2\n"
	units := utf16.Encode([]rune(text))
	data := make([]byte, len(units)*2)
	for i, unit := range units {
		data[i*2] = byte(unit)
		data[i*2+1] = byte(unit >> 8)
	}
	result, err := Infer([]Sample{{Name: "utf16-no-bom.csv", Data: data}})
	if err != nil {
		t.Fatalf("Infer: %v", err)
	}
	if result.Best.Dialect.Encoding != EncodingUTF16LE {
		t.Fatalf("encoding = %s, want utf-16le", result.Best.Dialect.Encoding)
	}
	if result.Best.Dialect.BOM {
		t.Fatal("expected BOM=false")
	}
	if result.Ambiguous {
		t.Fatalf("BOM-less UTF-16 should not be ambiguous: %v", result.Reasons)
	}
	if result.Best.Dialect.Delimiter != ',' {
		t.Fatalf("delimiter = %q", result.Best.Dialect.Delimiter)
	}
}

func TestInferUTF16BEWithBOM(t *testing.T) {
	text := "a,b\n1,2\n2,3\n"
	units := utf16.Encode([]rune(text))
	data := append([]byte{0xFE, 0xFF}, make([]byte, len(units)*2)...)
	for i, unit := range units {
		data[2+i*2] = byte(unit >> 8)
		data[3+i*2] = byte(unit)
	}
	result, err := Infer([]Sample{{Name: "utf16be.csv", Data: data}})
	if err != nil {
		t.Fatalf("Infer: %v", err)
	}
	if result.Best.Dialect.Encoding != EncodingUTF16BE || !result.Best.Dialect.BOM {
		t.Fatalf("got encoding=%s bom=%t", result.Best.Dialect.Encoding, result.Best.Dialect.BOM)
	}
}

func TestInferUTF16LEChineseWithoutBOM(t *testing.T) {
	text := "姓名,城市\n张三,北京\n李四,上海\n"
	units := utf16.Encode([]rune(text))
	data := make([]byte, len(units)*2)
	for i, unit := range units {
		data[i*2] = byte(unit)
		data[i*2+1] = byte(unit >> 8)
	}
	result, err := Infer([]Sample{{Name: "chinese-utf16.csv", Data: data}})
	if err != nil {
		t.Fatalf("Infer: %v", err)
	}
	if result.Best.Dialect.Encoding != EncodingUTF16LE {
		t.Fatalf("encoding = %s, want utf-16le; reasons: %v", result.Best.Dialect.Encoding, result.Best.Reasons)
	}
	if result.Ambiguous {
		t.Fatalf("Chinese UTF-16 should not be ambiguous: %v", result.Reasons)
	}
	if result.Best.Dialect.Delimiter != ',' || result.Best.Evidence.DominantWidth != 2 {
		t.Fatalf("got delimiter=%q width=%d", result.Best.Dialect.Delimiter, result.Best.Evidence.DominantWidth)
	}
}

func TestInferUTF8BOM(t *testing.T) {
	data := append([]byte{0xEF, 0xBB, 0xBF}, []byte("a,b\n1,2\n")...)
	result, err := Infer([]Sample{{Name: "bom.csv", Data: data}})
	if err != nil {
		t.Fatalf("Infer: %v", err)
	}
	if result.Best.Dialect.Encoding != EncodingUTF8 || !result.Best.Dialect.BOM {
		t.Fatalf("got encoding=%s bom=%t", result.Best.Dialect.Encoding, result.Best.Dialect.BOM)
	}
}

func TestInferLatin1(t *testing.T) {
	text := "nombre,ciudad\nJosé,Córdoba\nAna,Sevilla\n"
	data := make([]byte, len(text))
	for i, r := range text {
		if r > 255 {
			t.Fatalf("test character %q is outside Latin-1", r)
		}
		data[i] = byte(r)
	}
	result, err := Infer([]Sample{{Name: "latin1.csv", Data: data}})
	if err != nil {
		t.Fatalf("Infer: %v", err)
	}
	if result.Best.Dialect.Encoding != EncodingLatin1 {
		t.Fatalf("encoding = %s, want iso-8859-1 (best reasons: %v)", result.Best.Dialect.Encoding, result.Best.Reasons)
	}
	if result.Ambiguous {
		t.Fatalf("Latin-1 inference should not be ambiguous: %v", result.Reasons)
	}
	if result.Best.Dialect.Delimiter != ',' || result.Best.Evidence.DominantWidth != 2 {
		t.Fatalf("got delimiter=%q width=%d", result.Best.Dialect.Delimiter, result.Best.Evidence.DominantWidth)
	}
}

func TestInferLatin1EvenLength(t *testing.T) {
	text := "café,bar\nbaz,qux!\n"
	data := make([]byte, len(text))
	for i, r := range text {
		data[i] = byte(r)
	}
	result, err := Infer([]Sample{{Name: "latin1-even.csv", Data: data}})
	if err != nil {
		t.Fatalf("Infer: %v", err)
	}
	if result.Best.Dialect.Encoding != EncodingLatin1 {
		t.Fatalf("encoding = %s, want iso-8859-1; reasons: %v", result.Best.Dialect.Encoding, result.Best.Reasons)
	}
	if result.Best.Dialect.Delimiter != ',' {
		t.Fatalf("delimiter = %q", result.Best.Dialect.Delimiter)
	}
}

func TestInferBackslashEscape(t *testing.T) {
	data := "a,b\n\"x\\\"y\",1\n\"z\\\"w\",2\n"
	result, err := Infer([]Sample{{Name: "escape.csv", Data: []byte(data)}})
	if err != nil {
		t.Fatalf("Infer: %v", err)
	}
	best := result.Best
	if best.Dialect.EscapeMode() != EscapeBackslash {
		t.Fatalf("escape mode = %s, want backslash; reasons: %v", best.Dialect.EscapeMode(), best.Reasons)
	}
	if best.Evidence.EscapeUses != 2 {
		t.Fatalf("escape uses = %d, want 2", best.Evidence.EscapeUses)
	}
	if best.Evidence.DominantWidth != 2 {
		t.Fatalf("width = %d, want 2", best.Evidence.DominantWidth)
	}
}

func TestInferBackslashWithoutQuotes(t *testing.T) {
	data := "a,b\nx\\,y,1\nz\\,w,2\n"
	result, err := Infer([]Sample{{Name: "unquoted-escape.csv", Data: []byte(data)}})
	if err != nil {
		t.Fatalf("Infer: %v", err)
	}
	best := result.Best
	if best.Dialect.Quote != '"' {
		t.Fatalf("quote = %q, want the conventional double quote prior", best.Dialect.Quote)
	}
	if best.Dialect.EscapeMode() != EscapeBackslash {
		t.Fatalf("escape mode = %s, want backslash; reasons: %v", best.Dialect.EscapeMode(), best.Reasons)
	}
	if best.Evidence.EscapeUses != 2 {
		t.Fatalf("escape uses = %d, want 2", best.Evidence.EscapeUses)
	}
	if best.Evidence.DominantWidth != 2 {
		t.Fatalf("width = %d, want 2", best.Evidence.DominantWidth)
	}
}

func TestInferDoubledQuoteEscape(t *testing.T) {
	data := "a,b\n\"x\"\"y\",1\n\"z\"\"w\",2\n"
	result, err := Infer([]Sample{{Name: "doubled.csv", Data: []byte(data)}})
	if err != nil {
		t.Fatalf("Infer: %v", err)
	}
	best := result.Best
	if best.Dialect.EscapeMode() != EscapeDoubled {
		t.Fatalf("escape mode = %s, want doubled; reasons: %v", best.Dialect.EscapeMode(), best.Reasons)
	}
	if best.Evidence.DoubledQuoteEscapes != 2 {
		t.Fatalf("doubled escapes = %d, want 2", best.Evidence.DoubledQuoteEscapes)
	}
}

func TestInferSingleColumnIsAmbiguous(t *testing.T) {
	result, err := Infer([]Sample{{Name: "one.txt", Data: []byte("hello\nworld\n")}})
	if err != nil {
		t.Fatalf("Infer: %v", err)
	}
	if !result.Ambiguous {
		t.Fatal("single-column data without a delimiter must be ambiguous")
	}
	if len(result.Ambiguities) < 2 {
		t.Fatalf("ambiguity set has %d candidates, want at least 2", len(result.Ambiguities))
	}
	if _, err := InferDialect([]Sample{{Name: "one.txt", Data: []byte("hello\nworld\n")}}); !errors.Is(err, ErrAmbiguous) {
		t.Fatalf("InferDialect error = %v, want ErrAmbiguous", err)
	}
}

func TestInferConflictingFilesAreAmbiguous(t *testing.T) {
	samples := []Sample{
		{Name: "a.csv", Data: []byte("a,b,c\n1,2,3\n")},
		{Name: "b.csv", Data: []byte("a;b;c\n1;2;3\n")},
	}
	result, err := Infer(samples)
	if err != nil {
		t.Fatalf("Infer: %v", err)
	}
	if !result.Ambiguous {
		t.Fatalf("conflicting dialects should be ambiguous; best=%+v", result.Best.Dialect)
	}
	delimiters := map[rune]bool{}
	for _, candidate := range result.Ambiguities {
		delimiters[candidate.Dialect.Delimiter] = true
	}
	if !delimiters[','] || !delimiters[';'] {
		t.Fatalf("ambiguity set should include comma and semicolon, got %v", delimiters)
	}
}

func TestInferMixedNewlinesAreAmbiguous(t *testing.T) {
	result, err := Infer([]Sample{
		{Name: "lf.csv", Data: []byte("a,b\n1,2\n")},
		{Name: "crlf.csv", Data: []byte("c,d\r\n3,4\r\n")},
	})
	if err != nil {
		t.Fatalf("Infer: %v", err)
	}
	if !result.Ambiguous {
		t.Fatalf("mixed newline styles should be ambiguous: %+v", result.Best.Dialect)
	}
}

func TestInferMixedEncodingsAreAmbiguous(t *testing.T) {
	result, err := Infer([]Sample{
		{Name: "utf8.csv", Data: []byte("a,b\n1,2\n")},
		{Name: "utf16.csv", Data: utf16LE("c,d\n3,4\n")},
	})
	if err != nil {
		t.Fatalf("Infer: %v", err)
	}
	if !result.Ambiguous {
		t.Fatalf("mixed encodings should be ambiguous: %+v", result.Best.Dialect)
	}
	encodings := map[Encoding]bool{}
	for _, candidate := range result.Ambiguities {
		encodings[candidate.Dialect.Encoding] = true
	}
	if !encodings[EncodingUTF8] || !encodings[EncodingUTF16LE] {
		t.Fatalf("ambiguity set should expose the encoding conflict, got %v", encodings)
	}
}

func TestInferNoSamples(t *testing.T) {
	if _, err := Infer(nil); !errors.Is(err, ErrNoSamples) {
		t.Fatalf("error = %v, want ErrNoSamples", err)
	}
}

func TestInferWithZeroOptionsUsesDefaults(t *testing.T) {
	result, err := InferWithOptions(
		[]Sample{{Name: "a.csv", Data: []byte("a,b\n1,2\n")}},
		Options{},
	)
	if err != nil {
		t.Fatalf("InferWithOptions: %v", err)
	}
	if result.Best.Dialect.Delimiter != ',' || result.Best.Dialect.Quote != '"' {
		t.Fatalf("got delimiter=%q quote=%q", result.Best.Dialect.Delimiter, result.Best.Dialect.Quote)
	}
}

func TestParseQuotedFields(t *testing.T) {
	dialect := Dialect{
		Delimiter:   ',',
		Quote:       '"',
		DoubleQuote: true,
		Newline:     "\n",
		Encoding:    EncodingUTF8,
	}
	records, err := Parse([]byte("a,\"b,c\"\n\"d\"\"e\",f\n"), dialect)
	if err != nil {
		t.Fatalf("Parse: %v", err)
	}
	if len(records) != 2 {
		t.Fatalf("records = %d, want 2", len(records))
	}
	if got := strings.Join(records[0].Fields, "|"); got != "a|b,c" {
		t.Fatalf("first record = %q", got)
	}
	if got := strings.Join(records[1].Fields, "|"); got != "d\"e|f" {
		t.Fatalf("second record = %q", got)
	}
}

func TestParseUnterminatedQuote(t *testing.T) {
	dialect := Dialect{Delimiter: ',', Quote: '"', Newline: "\n", Encoding: EncodingUTF8}
	_, err := Parse([]byte("a,\"b\n"), dialect)
	if err == nil {
		t.Fatal("expected a parse error")
	}
	var parseErr *ParseError
	if !errors.As(err, &parseErr) {
		t.Fatalf("error type = %T, want *ParseError", err)
	}
	if parseErr.Kind != parseErrorUnterminatedQuote {
		t.Fatalf("kind = %q", parseErr.Kind)
	}
}

func TestParseTrailingEscape(t *testing.T) {
	dialect := Dialect{
		Delimiter: ',',
		Quote:     0,
		Escape:    '\\',
		Newline:   "\n",
		Encoding:  EncodingUTF8,
	}
	_, err := Parse([]byte("a\\"), dialect)
	if err == nil {
		t.Fatal("expected a trailing escape error")
	}
	var parseErr *ParseError
	if !errors.As(err, &parseErr) || parseErr.Kind != ParseErrorTrailingEscape {
		t.Fatalf("error = %v", err)
	}
}

func TestParseLineNumbersAcrossQuotedNewline(t *testing.T) {
	dialect := Dialect{
		Delimiter:   ',',
		Quote:       '"',
		DoubleQuote: true,
		Newline:     "\n",
		Encoding:    EncodingUTF8,
	}
	records, err := Parse([]byte("a,b\n\"x\ny\",2\nc,3\n"), dialect)
	if err != nil {
		t.Fatalf("Parse: %v", err)
	}
	wantLines := []int{1, 2, 4}
	if len(records) != len(wantLines) {
		t.Fatalf("records = %d, want %d", len(records), len(wantLines))
	}
	for i, want := range wantLines {
		if records[i].Line != want {
			t.Fatalf("record %d line = %d, want %d", i, records[i].Line, want)
		}
	}
	if records[1].Fields[0] != "x\ny" {
		t.Fatalf("quoted field = %q", records[1].Fields[0])
	}
}

func TestInferReasonsAreExplainable(t *testing.T) {
	result, err := Infer([]Sample{{Name: "a.csv", Data: []byte("a,b\n1,2\n")}})
	if err != nil {
		t.Fatalf("Infer: %v", err)
	}
	reasons := strings.Join(result.Best.Reasons, "\n")
	for _, substring := range []string{"encoding", "delimiter", "width", "quote", "escape", "newline"} {
		if !strings.Contains(reasons, substring) {
			t.Fatalf("reasons do not mention %q:\n%s", substring, reasons)
		}
	}
}
