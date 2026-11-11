package q194

import (
	"context"
	"errors"
	"fmt"
	"io"
	"strings"
	"testing"
)

type byteChunkReader struct {
	data []byte
}

func (r *byteChunkReader) Read(p []byte) (int, error) {
	if len(r.data) == 0 {
		return 0, io.EOF
	}
	if len(p) == 0 {
		return 0, nil
	}
	p[0] = r.data[0]
	r.data = r.data[1:]
	return 1, nil
}

type errorAfterReader struct {
	data []byte
	err  error
}

func (r *errorAfterReader) Read(p []byte) (int, error) {
	if len(r.data) > 0 {
		if len(p) == 0 {
			return 0, nil
		}
		p[0] = r.data[0]
		r.data = r.data[1:]
		return 1, nil
	}
	return 0, r.err
}

func collectEvents(t *testing.T, r *Reader) ([]Event, error) {
	t.Helper()
	var events []Event
	for {
		event, err := r.Next()
		if event.Kind != 0 {
			events = append(events, event)
		}
		if err == io.EOF {
			return events, nil
		}
		if err != nil {
			return events, err
		}
	}
}

func fieldValue(t *testing.T, events []Event, name Name, source FieldSource) string {
	t.Helper()
	var value string
	found := false
	for _, event := range events {
		if event.Kind != EventField || event.Field != name || event.Source != source {
			continue
		}
		if found {
			t.Fatalf("field %s from %s occurred more than once", name, source)
		}
		value = event.Value
		found = true
	}
	if !found {
		t.Fatalf("field %s from %s not found", name, source)
	}
	return value
}

func countKind(events []Event, kind EventKind) int {
	var count int
	for _, event := range events {
		if event.Kind == kind {
			count++
		}
	}
	return count
}

func TestPrefixRebindingScopes(t *testing.T) {
	input := `<root xmlns:p="urn:records">
		<p:item p:id="1"><p:title>one</p:title></p:item>
		<scope xmlns:p="urn:other"><p:item p:id="no"><p:title>no</p:title></p:item></scope>
		<p:item p:id="2"><p:title>two</p:title></p:item>
	</root>`
	cfg := Config{
		Record:     Name{Space: "urn:records", Local: "item"},
		Attributes: []Name{{Space: "urn:records", Local: "id"}},
		ChildText:  []Name{{Space: "urn:records", Local: "title"}},
	}
	r, err := NewReader(&byteChunkReader{data: []byte(input)}, cfg)
	if err != nil {
		t.Fatal(err)
	}
	events, err := collectEvents(t, r)
	if err != nil {
		t.Fatalf("unexpected parse error: %v", err)
	}
	if got := countKind(events, EventStart); got != 2 {
		t.Fatalf("start events = %d, want 2: %v", got, events)
	}
	if got := countKind(events, EventCommit); got != 2 {
		t.Fatalf("commit events = %d, want 2: %v", got, events)
	}

	var starts []Event
	for _, event := range events {
		if event.Kind == EventStart {
			starts = append(starts, event)
		}
	}
	if starts[0].Attributes[Name{Space: "urn:records", Local: "id"}] != "1" {
		t.Fatalf("first id = %q", starts[0].Attributes)
	}
	if starts[1].Attributes[Name{Space: "urn:records", Local: "id"}] != "2" {
		t.Fatalf("second id = %q", starts[1].Attributes)
	}

	values := []string{}
	for _, event := range events {
		if event.Kind == EventField && event.Source == FieldText {
			values = append(values, event.Value)
		}
	}
	if got, want := strings.Join(values, ","), "one,two"; got != want {
		t.Fatalf("title values = %q, want %q", got, want)
	}
}

func TestSameURIThroughDifferentPrefixes(t *testing.T) {
	input := `<root xmlns:a="urn:records" xmlns:b="urn:records">
		<a:item a:id="1"><a:title>A</a:title></a:item>
		<b:item b:id="2"><b:title>B</b:title></b:item>
	</root>`
	cfg := Config{
		Record:     Name{Space: "urn:records", Local: "item"},
		Attributes: []Name{{Space: "urn:records", Local: "id"}},
		ChildText:  []Name{{Space: "urn:records", Local: "title"}},
	}
	r, err := NewReader(&byteChunkReader{data: []byte(input)}, cfg)
	if err != nil {
		t.Fatal(err)
	}
	events, err := collectEvents(t, r)
	if err != nil {
		t.Fatalf("unexpected parse error: %v", err)
	}
	if got := countKind(events, EventCommit); got != 2 {
		t.Fatalf("commit events = %d, want 2: %v", got, events)
	}
}

func TestDefaultNamespaceDoesNotApplyToUnprefixedAttribute(t *testing.T) {
	input := `<item xmlns="urn:records" xmlns:p="urn:attr" id="plain" p:id="qualified"><title>value</title></item>`
	cfg := Config{
		Record: Name{Space: "urn:records", Local: "item"},
		Attributes: []Name{
			{Space: "urn:attr", Local: "id"},
			{Space: "", Local: "id"},
			{Space: "urn:records", Local: "id"},
		},
		ChildText: []Name{{Space: "urn:records", Local: "title"}},
	}
	r, err := NewReader(&byteChunkReader{data: []byte(input)}, cfg)
	if err != nil {
		t.Fatal(err)
	}
	events, err := collectEvents(t, r)
	if err != nil {
		t.Fatalf("unexpected parse error: %v", err)
	}

	var start Event
	for _, event := range events {
		if event.Kind == EventStart {
			start = event
		}
	}
	if len(start.Attributes) != 2 {
		t.Fatalf("start attributes = %v, want two", start.Attributes)
	}
	if got := start.Attributes[Name{Space: "urn:attr", Local: "id"}]; got != "qualified" {
		t.Fatalf("qualified id = %q", got)
	}
	if got := start.Attributes[Name{Space: "", Local: "id"}]; got != "plain" {
		t.Fatalf("plain id = %q", got)
	}
	if _, ok := start.Attributes[Name{Space: "urn:records", Local: "id"}]; ok {
		t.Fatalf("default namespace was incorrectly applied to an attribute: %v", start.Attributes)
	}

	var attributeFields int
	for _, event := range events {
		if event.Kind == EventField && event.Source == FieldAttribute {
			attributeFields++
		}
	}
	if attributeFields != 2 {
		t.Fatalf("attribute field events = %d, want 2: %v", attributeFields, events)
	}
}

func TestDefaultNamespaceScopeRestored(t *testing.T) {
	input := `<root xmlns="urn:records">
		<item id="one"><title>one</title></item>
		<scope xmlns="urn:other"><item id="skip"><title>skip</title></item></scope>
		<item id="two"><title>two</title></item>
	</root>`
	cfg := Config{
		Record:     Name{Space: "urn:records", Local: "item"},
		Attributes: []Name{{Space: "", Local: "id"}},
		ChildText:  []Name{{Space: "urn:records", Local: "title"}},
	}
	r, err := NewReader(&byteChunkReader{data: []byte(input)}, cfg)
	if err != nil {
		t.Fatal(err)
	}
	events, err := collectEvents(t, r)
	if err != nil {
		t.Fatalf("unexpected parse error: %v", err)
	}
	if got := countKind(events, EventCommit); got != 2 {
		t.Fatalf("commit events = %d, want 2: %v", got, events)
	}
}

func TestDefaultNamespaceUndeclared(t *testing.T) {
	input := `<root xmlns="urn:records">
		<item id="one"/>
		<item xmlns="" id="skip"/>
		<item id="two"/>
	</root>`
	cfg := Config{
		Record:     Name{Space: "urn:records", Local: "item"},
		Attributes: []Name{{Local: "id"}},
	}
	r, err := NewReader(&byteChunkReader{data: []byte(input)}, cfg)
	if err != nil {
		t.Fatal(err)
	}
	events, err := collectEvents(t, r)
	if err != nil {
		t.Fatalf("unexpected parse error: %v", err)
	}
	if got := countKind(events, EventCommit); got != 2 {
		t.Fatalf("commit events = %d, want 2: %v", got, events)
	}
}

func TestReservedXMLPrefix(t *testing.T) {
	input := `<item xml:lang="zh" id="7"><title>text</title></item>`
	cfg := Config{
		Record:     Name{Local: "item"},
		Attributes: []Name{{Space: "http://www.w3.org/XML/1998/namespace", Local: "lang"}, {Local: "id"}},
		ChildText:  []Name{{Local: "title"}},
	}
	r, err := NewReader(&byteChunkReader{data: []byte(input)}, cfg)
	if err != nil {
		t.Fatal(err)
	}
	events, err := collectEvents(t, r)
	if err != nil {
		t.Fatalf("unexpected parse error: %v", err)
	}
	if got := fieldValue(t, events, Name{Space: "http://www.w3.org/XML/1998/namespace", Local: "lang"}, FieldAttribute); got != "zh" {
		t.Fatalf("xml:lang = %q", got)
	}
}

func TestDirectTextOnlySkipsGrandchildren(t *testing.T) {
	input := `<item>
		<title>A<em>B</em>C<![CDATA[D]]>&amp;E</title>
		<title>A<title>inner</title>Z</title>
	</item>`
	cfg := Config{
		Record:    Name{Local: "item"},
		ChildText: []Name{{Local: "title"}},
	}
	r, err := NewReader(&byteChunkReader{data: []byte(input)}, cfg)
	if err != nil {
		t.Fatal(err)
	}
	events, err := collectEvents(t, r)
	if err != nil {
		t.Fatalf("unexpected parse error: %v", err)
	}

	var titles []string
	for _, event := range events {
		if event.Kind == EventField && event.Source == FieldText {
			titles = append(titles, event.Value)
		}
	}
	if got, want := strings.Join(titles, "|"), "ACD&E|AZ"; got != want {
		t.Fatalf("title values = %q, want %q; events=%v", got, want, events)
	}
}

func TestSameNameNestedRecordDoesNotRestart(t *testing.T) {
	input := `<item id="outer">
		<item id="inner"><title>nested</title></item>
		<title>outer</title>
	</item>`
	cfg := Config{
		Record:     Name{Local: "item"},
		Attributes: []Name{{Local: "id"}},
		ChildText:  []Name{{Local: "title"}},
	}
	r, err := NewReader(&byteChunkReader{data: []byte(input)}, cfg)
	if err != nil {
		t.Fatal(err)
	}
	events, err := collectEvents(t, r)
	if err != nil {
		t.Fatalf("unexpected parse error: %v", err)
	}
	if got := countKind(events, EventStart); got != 1 {
		t.Fatalf("start events = %d, want 1: %v", got, events)
	}
	if got := countKind(events, EventCommit); got != 1 {
		t.Fatalf("commit events = %d, want 1: %v", got, events)
	}
	if got := fieldValue(t, events, Name{Local: "id"}, FieldAttribute); got != "outer" {
		t.Fatalf("id = %q, want outer", got)
	}
	if got := fieldValue(t, events, Name{Local: "title"}, FieldText); got != "outer" {
		t.Fatalf("title = %q, want outer", got)
	}
}

func TestEntitiesAcrossOneByteReads(t *testing.T) {
	input := `<item id="A&amp;B"><title>&lt;&gt;&amp;&apos;&quot;&#65;&#x1F600;</title></item>`
	cfg := Config{
		Record:     Name{Local: "item"},
		Attributes: []Name{{Local: "id"}},
		ChildText:  []Name{{Local: "title"}},
	}
	r, err := NewReader(&byteChunkReader{data: []byte(input)}, cfg)
	if err != nil {
		t.Fatal(err)
	}
	events, err := collectEvents(t, r)
	if err != nil {
		t.Fatalf("unexpected parse error: %v", err)
	}
	if got := fieldValue(t, events, Name{Local: "id"}, FieldAttribute); got != "A&B" {
		t.Fatalf("id = %q", got)
	}
	if got := fieldValue(t, events, Name{Local: "title"}, FieldText); got != "<>&'\"A😀" {
		t.Fatalf("title = %q", got)
	}
}

func TestUnknownEntityAbortsRecord(t *testing.T) {
	input := `<item><title>&nb` + `sp;</title></item>`
	cfg := Config{Record: Name{Local: "item"}, ChildText: []Name{{Local: "title"}}}
	r, err := NewReader(&byteChunkReader{data: []byte(input)}, cfg)
	if err != nil {
		t.Fatal(err)
	}
	events, err := collectEvents(t, r)
	if err == nil {
		t.Fatal("expected unknown entity error")
	}
	if got := countKind(events, EventStart); got != 1 {
		t.Fatalf("start events = %d, want 1: %v", got, events)
	}
	if got := countKind(events, EventAbort); got != 1 {
		t.Fatalf("abort events = %d, want 1: %v", got, events)
	}
	if got := countKind(events, EventCommit); got != 0 {
		t.Fatalf("commit events = %d, want 0: %v", got, events)
	}
	last := events[len(events)-1]
	if last.Kind != EventAbort || !errors.Is(last.Err, err) {
		t.Fatalf("last event = %#v, err = %v", last, err)
	}
}

func TestEntitiesAreNotRecognizedInsideCommentsCDATAOrPI(t *testing.T) {
	input := `<item>
		<title><![CDATA[&nbsp; &#xD800;]]></title>
		<blurb>&amp;<!-- &nbsp; --><?pipeline &nbsp;?></blurb>
	</item>`
	cfg := Config{
		Record:    Name{Local: "item"},
		ChildText: []Name{{Local: "title"}, {Local: "blurb"}},
	}
	r, err := NewReader(&byteChunkReader{data: []byte(input)}, cfg)
	if err != nil {
		t.Fatal(err)
	}
	events, err := collectEvents(t, r)
	if err != nil {
		t.Fatalf("entities in non-reference contexts must be literal: %v", err)
	}
	if got := fieldValue(t, events, Name{Local: "title"}, FieldText); got != "&nbsp; &#xD800;" {
		t.Fatalf("title = %q", got)
	}
	if got := fieldValue(t, events, Name{Local: "blurb"}, FieldText); got != "&" {
		t.Fatalf("blurb = %q", got)
	}
}

func TestDTDRejected(t *testing.T) {
	input := `<!DOCTYPE item [<!ENTITY boom "expanded">]><item><title>&boom;</title></item>`
	cfg := Config{Record: Name{Local: "item"}, ChildText: []Name{{Local: "title"}}}
	r, err := NewReader(&byteChunkReader{data: []byte(input)}, cfg)
	if err != nil {
		t.Fatal(err)
	}
	events, err := collectEvents(t, r)
	if err == nil {
		t.Fatal("expected DTD rejection")
	}
	if !errors.Is(err, ErrDTD) {
		t.Fatalf("error = %v, want ErrDTD", err)
	}
	if got := countKind(events, EventStart); got != 0 {
		t.Fatalf("start events = %d, want 0: %v", got, events)
	}
}

func TestIllegalCodePointsAbortRecord(t *testing.T) {
	cases := []struct {
		name string
		text string
	}{
		{name: "NUL reference", text: "&#0;"},
		{name: "surrogate reference", text: "&#xD800;"},
		{name: "noncharacter reference", text: "&#xFFFE;"},
		{name: "out of range reference", text: "&#x110000;"},
		{name: "raw noncharacter", text: "\uFFFE"},
		{name: "raw NUL", text: "\x00"},
		{name: "invalid UTF-8", text: string([]byte{0xff})},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			input := `<item><title>` + tc.text + `</title></item>`
			cfg := Config{Record: Name{Local: "item"}, ChildText: []Name{{Local: "title"}}}
			r, err := NewReader(&byteChunkReader{data: []byte(input)}, cfg)
			if err != nil {
				t.Fatal(err)
			}
			events, err := collectEvents(t, r)
			if err == nil {
				t.Fatalf("expected invalid character error, events=%v", events)
			}
			if got := countKind(events, EventStart); got != 1 {
				t.Fatalf("start events = %d, want 1: %v", got, events)
			}
			if got := countKind(events, EventAbort); got != 1 {
				t.Fatalf("abort events = %d, want 1: %v", got, events)
			}
			if got := countKind(events, EventCommit); got != 0 {
				t.Fatalf("commit events = %d, want 0: %v", got, events)
			}
		})
	}
}

func TestLateClosingErrorAbortsRecord(t *testing.T) {
	input := `<item><title>ok</title></item>
		<item><title>bad</wrong></item>`
	cfg := Config{Record: Name{Local: "item"}, ChildText: []Name{{Local: "title"}}}
	r, err := NewReader(&byteChunkReader{data: []byte(input)}, cfg)
	if err != nil {
		t.Fatal(err)
	}
	events, err := collectEvents(t, r)
	if err == nil {
		t.Fatal("expected mismatched closing tag error")
	}
	if got := countKind(events, EventCommit); got != 1 {
		t.Fatalf("commit events = %d, want 1: %v", got, events)
	}
	if got := countKind(events, EventAbort); got != 1 {
		t.Fatalf("abort events = %d, want 1: %v", got, events)
	}

	var startedRecord Name
	for _, event := range events {
		if event.Kind == EventStart {
			startedRecord = event.Record
		}
	}
	abort := events[len(events)-1]
	if abort.Kind != EventAbort || abort.Record != startedRecord {
		t.Fatalf("abort = %#v, started record = %s", abort, startedRecord)
	}
}

func TestRecordClosingElementMismatchAborts(t *testing.T) {
	input := `<item><title>value</title></wrong>`
	cfg := Config{Record: Name{Local: "item"}, ChildText: []Name{{Local: "title"}}}
	r, err := NewReader(&byteChunkReader{data: []byte(input)}, cfg)
	if err != nil {
		t.Fatal(err)
	}
	events, err := collectEvents(t, r)
	if err == nil {
		t.Fatal("expected mismatched record close error")
	}
	if got := countKind(events, EventCommit); got != 0 {
		t.Fatalf("commit events = %d, want 0: %v", got, events)
	}
	if got := countKind(events, EventAbort); got != 1 {
		t.Fatalf("abort events = %d, want 1: %v", got, events)
	}
	if got := fieldValue(t, events, Name{Local: "title"}, FieldText); got != "value" {
		t.Fatalf("title = %q", got)
	}
}

func TestHalfRecordEOFAborts(t *testing.T) {
	input := `<item><title>half`
	cfg := Config{Record: Name{Local: "item"}, ChildText: []Name{{Local: "title"}}}
	r, err := NewReader(&byteChunkReader{data: []byte(input)}, cfg)
	if err != nil {
		t.Fatal(err)
	}
	events, err := collectEvents(t, r)
	if err == nil {
		t.Fatal("expected unexpected EOF error")
	}
	if got := countKind(events, EventStart); got != 1 {
		t.Fatalf("start events = %d, want 1: %v", got, events)
	}
	if got := countKind(events, EventAbort); got != 1 {
		t.Fatalf("abort events = %d, want 1: %v", got, events)
	}
	if got := countKind(events, EventCommit); got != 0 {
		t.Fatalf("commit events = %d, want 0: %v", got, events)
	}
	if got := countKind(events, EventField); got != 0 {
		t.Fatalf("partial field should not be delivered: %v", events)
	}
	sticky, stickyErr := r.Next()
	if sticky.Kind != 0 || !errors.Is(stickyErr, err) {
		t.Fatalf("next after abort = %#v, %v; want zero event and sticky error %v", sticky, stickyErr, err)
	}
}

func TestRepeatedDirectChildEmitsRepeatedFields(t *testing.T) {
	input := `<item><tag>one</tag><tag>two</tag><tag></tag></item>`
	cfg := Config{Record: Name{Local: "item"}, ChildText: []Name{{Local: "tag"}}}
	r, err := NewReader(&byteChunkReader{data: []byte(input)}, cfg)
	if err != nil {
		t.Fatal(err)
	}
	events, err := collectEvents(t, r)
	if err != nil {
		t.Fatal(err)
	}
	var values []string
	for _, event := range events {
		if event.Kind == EventField && event.Source == FieldText {
			values = append(values, event.Value)
		}
	}
	if got, want := strings.Join(values, "|"), "one|two|"; got != want {
		t.Fatalf("values = %q, want %q", got, want)
	}
}

func TestInvalidReferenceInAttributePreventsRecordStart(t *testing.T) {
	input := `<item id="&#xD800;"><title>value</title></item>`
	cfg := Config{Record: Name{Local: "item"}, Attributes: []Name{{Local: "id"}}}
	r, err := NewReader(&byteChunkReader{data: []byte(input)}, cfg)
	if err != nil {
		t.Fatal(err)
	}
	events, err := collectEvents(t, r)
	if err == nil {
		t.Fatal("expected invalid character reference error")
	}
	if !errors.Is(err, ErrInvalidCharacterReference) {
		t.Fatalf("error = %v, want ErrInvalidCharacterReference", err)
	}
	if got := countKind(events, EventStart); got != 0 {
		t.Fatalf("start events = %d, want 0: %v", got, events)
	}
}

func TestInputErrorAbortsOpenRecord(t *testing.T) {
	boom := errors.New("feed connection lost")
	input := `<item><title>half`
	cfg := Config{Record: Name{Local: "item"}, ChildText: []Name{{Local: "title"}}}
	r, err := NewReader(&errorAfterReader{data: []byte(input), err: boom}, cfg)
	if err != nil {
		t.Fatal(err)
	}
	events, err := collectEvents(t, r)
	if !errors.Is(err, boom) {
		t.Fatalf("error = %v, want %v", err, boom)
	}
	abort := events[len(events)-1]
	if abort.Kind != EventAbort || !errors.Is(abort.Err, boom) {
		t.Fatalf("abort = %#v", abort)
	}
}

func TestUndeclaredPrefixAbortsOpenRecord(t *testing.T) {
	input := `<item xmlns="urn:records"><p:title>text</p:title></item>`
	cfg := Config{
		Record:    Name{Space: "urn:records", Local: "item"},
		ChildText: []Name{{Space: "urn:whatever", Local: "title"}},
	}
	r, err := NewReader(&byteChunkReader{data: []byte(input)}, cfg)
	if err != nil {
		t.Fatal(err)
	}
	events, err := collectEvents(t, r)
	if err == nil {
		t.Fatal("expected undeclared prefix error")
	}
	if got := countKind(events, EventAbort); got != 1 {
		t.Fatalf("abort events = %d, want 1: %v", got, events)
	}
}

func TestNamespaceDeclarationErrors(t *testing.T) {
	cases := []string{
		`<item xmlns:p="" p:id="x"/>`,
		`<item xmlns:xml="urn:not-xml"/>`,
		`<item xmlns:xmlns="urn:bad"/>`,
		`<item xmlns="http://www.w3.org/XML/1998/namespace"/>`,
		`<item xmlns:p="http://www.w3.org/XML/1998/namespace"/>`,
		`<item xmlns:p="http://www.w3.org/2000/xmlns/"/>`,
		`<item xmlns:p="urn:one" xmlns:p="urn:two"/>`,
		`<item xmlns="urn:records" id="one" id="two"/>`,
		`<item xmlns:p="urn:attr" xmlns:q="urn:attr" p:id="one" q:id="two"/>`,
	}
	for _, input := range cases {
		t.Run(input, func(t *testing.T) {
			cfg := Config{Record: Name{Local: "item"}}
			r, err := NewReader(&byteChunkReader{data: []byte(input)}, cfg)
			if err != nil {
				t.Fatal(err)
			}
			events, err := collectEvents(t, r)
			if err == nil {
				t.Fatalf("expected namespace error, events=%v", events)
			}
		})
	}
}

func TestFieldsAreDeliveredBeforeCommit(t *testing.T) {
	input := `<item id="7"><title>text</title><blurb>note</blurb></item>`
	cfg := Config{
		Record:     Name{Local: "item"},
		Attributes: []Name{{Local: "id"}},
		ChildText:  []Name{{Local: "title"}, {Local: "blurb"}},
	}
	r, err := NewReader(&byteChunkReader{data: []byte(input)}, cfg)
	if err != nil {
		t.Fatal(err)
	}
	events, err := collectEvents(t, r)
	if err != nil {
		t.Fatal(err)
	}
	if got, want := len(events), 5; got != want {
		t.Fatalf("event count = %d, want %d: %v", got, want, events)
	}
	if events[0].Kind != EventStart || events[1].Kind != EventField ||
		events[2].Kind != EventField || events[3].Kind != EventField ||
		events[4].Kind != EventCommit {
		t.Fatalf("unexpected event order: %v", events)
	}
	if events[1].Source != FieldAttribute || events[1].Value != "7" {
		t.Fatalf("attribute event = %#v", events[1])
	}
	if events[2].Field != (Name{Local: "title"}) || events[2].Value != "text" {
		t.Fatalf("title event = %#v", events[2])
	}
	if events[3].Field != (Name{Local: "blurb"}) || events[3].Value != "note" {
		t.Fatalf("blurb event = %#v", events[3])
	}
}

func TestConsumeAdapter(t *testing.T) {
	input := `<!-- before --><?pipeline record?>
		<item id="1"><title>first</title></item>
		<!-- between -->
		<item id="2"><title>second</title></item>
		<?pipeline end?>`
	cfg := Config{
		Record:     Name{Local: "item"},
		Attributes: []Name{{Local: "id"}},
		ChildText:  []Name{{Local: "title"}},
	}

	var got []Event
	err := Consume(&byteChunkReader{data: []byte(input)}, cfg, func(event Event) error {
		got = append(got, event)
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	if countKind(got, EventStart) != 2 || countKind(got, EventCommit) != 2 {
		t.Fatalf("events = %v", got)
	}
}

func TestConsumeHandlerErrorStops(t *testing.T) {
	input := `<item><title>first</title></item><item><title>second</title></item>`
	cfg := Config{Record: Name{Local: "item"}, ChildText: []Name{{Local: "title"}}}
	stop := errors.New("stop")
	var events []Event
	err := Consume(&byteChunkReader{data: []byte(input)}, cfg, func(event Event) error {
		events = append(events, event)
		return stop
	})
	if !errors.Is(err, stop) {
		t.Fatalf("error = %v, want %v", err, stop)
	}
	if got, want := len(events), 2; got != want {
		t.Fatalf("handler calls = %d, want %d: %v", got, want, events)
	}
	if events[0].Kind != EventStart || events[1].Kind != EventAbort {
		t.Fatalf("events = %v, want start then abort", events)
	}
	if !errors.Is(events[1].Err, stop) {
		t.Fatalf("abort error = %v, want %v", events[1].Err, stop)
	}
}

func TestConsumeDeliversAbortBeforeError(t *testing.T) {
	input := `<item><title>value</wrong>`
	cfg := Config{Record: Name{Local: "item"}, ChildText: []Name{{Local: "title"}}}
	var events []Event
	err := Consume(&byteChunkReader{data: []byte(input)}, cfg, func(event Event) error {
		events = append(events, event)
		return nil
	})
	if err == nil {
		t.Fatal("expected closing tag error")
	}
	if got := countKind(events, EventAbort); got != 1 {
		t.Fatalf("abort events = %d, want 1: %v", got, events)
	}
	if got := countKind(events, EventCommit); got != 0 {
		t.Fatalf("commit events = %d, want 0: %v", got, events)
	}
	if events[len(events)-1].Kind != EventAbort {
		t.Fatalf("last event = %#v", events[len(events)-1])
	}
}

func TestConsumeNilHandler(t *testing.T) {
	input := `<item/>`
	err := Consume(strings.NewReader(input), Config{Record: Name{Local: "item"}}, nil)
	if !errors.Is(err, ErrNilHandler) {
		t.Fatalf("error = %v, want ErrNilHandler", err)
	}
}

func TestConsumeContextCancellationAbortsHalfRecord(t *testing.T) {
	input := `<item><title>half`
	cfg := Config{Record: Name{Local: "item"}, ChildText: []Name{{Local: "title"}}}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	var got []Event
	err := ConsumeContext(ctx, &byteChunkReader{data: []byte(input)}, cfg, func(event Event) error {
		got = append(got, event)
		if event.Kind == EventStart {
			cancel()
		}
		return nil
	})
	if !errors.Is(err, context.Canceled) {
		t.Fatalf("error = %v, want context.Canceled", err)
	}
	if got := countKind(got, EventStart); got != 1 {
		t.Fatalf("start events = %d, want 1: %v", got, got)
	}
	if got := countKind(got, EventAbort); got != 1 {
		t.Fatalf("abort events = %d, want 1: %v", got, got)
	}
	if got := countKind(got, EventCommit); got != 0 {
		t.Fatalf("commit events = %d, want 0: %v", got, got)
	}
}

func TestInvalidConfig(t *testing.T) {
	cases := []Config{
		{},
		{Record: Name{Local: "item"}, Attributes: []Name{{Local: "id"}, {Local: "id"}}},
		{Record: Name{Local: "item"}, ChildText: []Name{{Local: "title"}, {Local: "title"}}},
		{Record: Name{Local: "bad name"}},
	}
	for _, cfg := range cases {
		t.Run(fmt.Sprintf("%+v", cfg), func(t *testing.T) {
			_, err := NewReader(strings.NewReader(`<item/>`), cfg)
			if !errors.Is(err, ErrInvalidConfig) {
				t.Fatalf("error = %v, want ErrInvalidConfig", err)
			}
		})
	}
}
