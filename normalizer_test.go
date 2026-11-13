package dataeng

import (
	"errors"
	"io"
	"reflect"
	"strings"
	"testing"
	"time"
)

func q0043EventsOfType(events []Event, typ EventType) []Event {
	var out []Event
	for _, ev := range events {
		if ev.Type == typ {
			out = append(out, ev)
		}
	}
	return out
}

func TestQ0043NamespaceScopeAndAttributePrefixes(t *testing.T) {
	doc := `<root xmlns="urn:root" xmlns:p="urn:one" p:a="1" a="2">` +
		`<p:item xmlns:p="urn:two" p:a="3"/>` +
		`<p:after/>` +
		`</root>`
	events, err := Normalize(doc)
	if err != nil {
		t.Fatal(err)
	}
	starts := q0043EventsOfType(events, StartElement)
	if len(starts) != 3 {
		t.Fatalf("got %d start events", len(starts))
	}

	if got := starts[0].Name; got != (Name{Space: "urn:root", Local: "root"}) {
		t.Fatalf("root name = %#v", got)
	}
	if starts[0].Prefix != "" {
		t.Fatalf("root prefix = %q", starts[0].Prefix)
	}
	if got, ok := starts[0].Attribute("urn:one", "a"); !ok || got != "1" {
		t.Fatalf("p:a = %q, %v", got, ok)
	}
	if got, ok := starts[0].Attribute("", "a"); !ok || got != "2" {
		t.Fatalf("a = %q, %v", got, ok)
	}

	if got := starts[1].Name; got != (Name{Space: "urn:two", Local: "item"}) {
		t.Fatalf("item name = %#v", got)
	}
	if got, ok := starts[1].Attribute("urn:two", "a"); !ok || got != "3" {
		t.Fatalf("rebound p:a = %q, %v", got, ok)
	}

	// The inner rebinding must not leak to the following sibling.
	if got := starts[2].Name; got != (Name{Space: "urn:one", Local: "after"}) {
		t.Fatalf("after name = %#v", got)
	}

	if got, ok := starts[0].LookupNamespace("p"); !ok || got != "urn:one" {
		t.Fatalf("root scope p = %q, %v", got, ok)
	}
	if got, ok := starts[1].LookupNamespace("p"); !ok || got != "urn:two" {
		t.Fatalf("item scope p = %q, %v", got, ok)
	}
}

func TestQ0043DefaultNamespaceUndeclaredAndXMLPrefix(t *testing.T) {
	doc := `<r xmlns="urn:outer"><c xmlns=""><d/><x:leaf xmlns:x="urn:x"/></c><e xml:lang="en"/></r>`
	events, err := Normalize(doc)
	if err != nil {
		t.Fatal(err)
	}
	starts := q0043EventsOfType(events, StartElement)
	if starts[2].Name != (Name{Space: "", Local: "d"}) {
		t.Fatalf("d name = %#v", starts[2].Name)
	}
	if starts[3].Name != (Name{Space: "urn:x", Local: "leaf"}) {
		t.Fatalf("leaf name = %#v", starts[3].Name)
	}
	if got, ok := starts[4].Attribute(xmlNamespaceURI, "lang"); !ok || got != "en" {
		t.Fatalf("xml:lang = %q, %v", got, ok)
	}
}

func TestQ0043XMLBaseInheritanceAndResolution(t *testing.T) {
	doc := `<root xml:base="http://example.com/a/"><child xml:base="b/"><leaf/></child><other/></root>`
	events, err := Normalize(doc)
	if err != nil {
		t.Fatal(err)
	}
	starts := q0043EventsOfType(events, StartElement)
	const rootBase = "http://example.com/a/"
	if starts[0].BaseURI != rootBase {
		t.Fatalf("root base = %q", starts[0].BaseURI)
	}
	if starts[1].BaseURI != rootBase+"b/" {
		t.Fatalf("child base = %q", starts[1].BaseURI)
	}
	if starts[2].BaseURI != rootBase+"b/" {
		t.Fatalf("leaf base = %q", starts[2].BaseURI)
	}
	if starts[3].BaseURI != rootBase {
		t.Fatalf("sibling base = %q", starts[3].BaseURI)
	}
}

func TestQ0043UndeclaredPrefixRejectsDocument(t *testing.T) {
	tests := []string{
		`<p:root/>`,
		`<root p:a="x"/>`,
		`<root xmlns:p=""><p:child/></root>`,
		`<root xmlns:p="urn:p"><p:child></q:child></root>`,
	}
	for _, doc := range tests {
		events, err := Normalize(doc)
		if err == nil {
			t.Fatalf("%s: expected error", doc)
		}
		if !errors.Is(err, ErrUnboundPrefix) {
			t.Fatalf("%s: error = %v, want ErrUnboundPrefix", doc, err)
		}
		if events != nil {
			t.Fatalf("%s: returned partial events", doc)
		}
	}
}

func TestQ0043PredefinedEntitiesOnly(t *testing.T) {
	events, err := Normalize(`<r>&amp;&lt;&gt;&quot;&apos;&#65;&#x42;</r>`)
	if err != nil {
		t.Fatal(err)
	}
	text := q0043EventsOfType(events, CharData)
	if len(text) != 1 || text[0].Text != `&<>"'AB` {
		t.Fatalf("text = %#v", text)
	}

	unknown := []string{
		`<r>&custom;</r>`,
		`<!DOCTYPE r [<!ENTITY custom "expanded">]><r>&custom;</r>`,
		`<r a="&custom;"/>`,
	}
	for _, doc := range unknown {
		_, err := Normalize(doc)
		if err == nil || !errors.Is(err, ErrUnknownEntity) {
			t.Fatalf("%s: error = %v, want ErrUnknownEntity", doc, err)
		}
	}

	attrEvents, err := Normalize(`<r a="&lt;&amp;&#65;"/>`)
	if err != nil {
		t.Fatal(err)
	}
	if got, ok := attrEvents[0].Attribute("", "a"); !ok || got != "<&A" {
		t.Fatalf("attribute entity value = %q, %v", got, ok)
	}
}

func TestQ0043PositionsAreOriginal(t *testing.T) {
	doc := "<r>\n  <a x=\"1\">v</a>\n</r>"
	events, err := Normalize(doc)
	if err != nil {
		t.Fatal(err)
	}
	starts := q0043EventsOfType(events, StartElement)
	if starts[1].Pos.Offset != int64(strings.Index(doc, "<a")) {
		t.Fatalf("a offset = %d", starts[1].Pos.Offset)
	}
	if starts[1].Pos.Line != 2 || starts[1].Pos.Column != 3 {
		t.Fatalf("a position = %s", starts[1].Pos)
	}
	if got := starts[1].Attrs[0].Pos.Offset; got != int64(strings.Index(doc, `x="1"`)) {
		t.Fatalf("attr offset = %d", got)
	}
	if got := starts[1].Attrs[0].Pos.Line; got != 2 {
		t.Fatalf("attr line = %d", got)
	}
}

func TestQ0043SelfClosingSynthesizesEndEvent(t *testing.T) {
	events, err := Normalize(`<a/>`)
	if err != nil {
		t.Fatal(err)
	}
	if len(events) != 2 {
		t.Fatalf("got %d events: %#v", len(events), events)
	}
	if !events[0].SelfClosing || events[0].Pos.Offset != 0 || events[0].Pos.EndOffset != 4 {
		t.Fatalf("start = %#v", events[0])
	}
	if events[1].Type != EndElement || !events[1].Synthetic {
		t.Fatalf("end = %#v", events[1])
	}
}

func TestQ0043CDATACommentAndProcInst(t *testing.T) {
	doc := `<?xml version="1.0"?><!--c--><r><![CDATA[a<b]]></r>`
	events, err := Normalize(doc)
	if err != nil {
		t.Fatal(err)
	}
	var sawPI, sawComment, sawCDATA bool
	for _, ev := range events {
		switch ev.Type {
		case ProcInst:
			sawPI = ev.Target == "xml"
		case Comment:
			sawComment = ev.Text == "c"
		case CharData:
			if ev.CDATA {
				sawCDATA = ev.Text == "a<b"
			}
		}
	}
	if !sawPI || !sawComment || !sawCDATA {
		t.Fatalf("pi=%v comment=%v cdata=%v events=%#v", sawPI, sawComment, sawCDATA, events)
	}
}

type q0043ChunkReader struct {
	data   []byte
	chunks []int
	pos    int
	n      int
}

func (r *q0043ChunkReader) Read(p []byte) (int, error) {
	if r.pos >= len(r.data) {
		return 0, io.EOF
	}
	size := r.chunks[r.n%len(r.chunks)]
	r.n++
	if size > len(p) {
		size = len(p)
	}
	if size > len(r.data)-r.pos {
		size = len(r.data) - r.pos
	}
	copy(p, r.data[r.pos:r.pos+size])
	r.pos += size
	return size, nil
}

func TestQ0043RandomChunkingProducesSameEvents(t *testing.T) {
	doc := `<root xmlns="urn:r" xmlns:p="urn:p" xml:base="http://example.com/a/">` +
		`text &amp; <p:c p:x="v"><![CDATA[x<y]]></p:c><!--c-->` +
		`<p:d xmlns:p="urn:q"><p:e/></p:d></root>`
	want, err := Normalize(doc)
	if err != nil {
		t.Fatal(err)
	}
	for _, chunks := range [][]int{{1}, {2, 3}, {5, 1, 7, 2}, {3, 11, 4}} {
		got, err := Normalize(&q0043ChunkReader{data: []byte(doc), chunks: chunks})
		if err != nil {
			t.Fatalf("chunks %v: %v", chunks, err)
		}
		if !reflect.DeepEqual(got, want) {
			t.Fatalf("chunks %v differ\n got: %#v\nwant: %#v", chunks, got, want)
		}
	}
}

func TestQ0043LargeInputPositionsAcrossBuffers(t *testing.T) {
	doc := "<root>" + strings.Repeat(`<item n="1">abcdef</item>`, 700) + "<tail/></root>"
	want, err := Normalize(doc)
	if err != nil {
		t.Fatal(err)
	}
	got, err := Normalize(&q0043ChunkReader{data: []byte(doc), chunks: []int{1, 4093, 2, 17}})
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatal("large chunked input differs")
	}
	tail := got[len(got)-3]
	if tail.Name.Local != "tail" || tail.Pos.Offset != int64(strings.Index(doc, "<tail/>")) {
		t.Fatalf("tail = %#v", tail)
	}
	if tail.Pos.Line != 1 || tail.Pos.Column != strings.Index(doc, "<tail/>")+1 {
		t.Fatalf("tail position = %s", tail.Pos)
	}
}

func TestQ0043StreamingAPI(t *testing.T) {
	doc := `<a><b/></a>`
	dec := NewDecoder(strings.NewReader(doc))
	count := 0
	for {
		_, err := dec.Next()
		if errors.Is(err, io.EOF) {
			break
		}
		if err != nil {
			t.Fatal(err)
		}
		count++
	}
	if count != 4 {
		t.Fatalf("got %d events", count)
	}
}

func TestQ0043StreamingBeforeEOF(t *testing.T) {
	pr, pw := io.Pipe()
	dec := NewNormalizer(pr)

	release := make(chan struct{})
	go func() {
		_, _ = pw.Write([]byte("<a>"))
		<-release
		_, _ = pw.Write([]byte("</a>"))
		_ = pw.Close()
	}()

	type result struct {
		event Event
		err   error
	}
	next := make(chan result, 1)
	go func() {
		event, err := dec.Next()
		next <- result{event: event, err: err}
	}()

	select {
	case got := <-next:
		if got.err != nil || got.event.Type != StartElement {
			t.Fatalf("first event = %#v, %v", got.event, got.err)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("Next blocked until EOF")
	}

	close(release)
	end, err := dec.Next()
	if err != nil || end.Type != EndElement {
		t.Fatalf("end event = %#v, %v", end, err)
	}
	if _, err := dec.Next(); !errors.Is(err, io.EOF) {
		t.Fatalf("final error = %v", err)
	}
}
