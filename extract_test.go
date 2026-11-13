package dataeng_test

import (
	"fmt"
	"reflect"
	"testing"

	dataeng "example.org/dataeng13/q0057"
)

func feedAll(t *testing.T, ex *dataeng.Extractor, events []dataeng.Event) {
	t.Helper()
	for i, ev := range events {
		if st := ex.Feed(ev); st != dataeng.StatusOK {
			t.Fatalf("event %d: got status %v, want StatusOK", i, st)
		}
	}
}

// Raw text state: '<' no longer opens a tag, text is hidden but its source
// ranges are preserved, and only the matching end tag exits the state.
func TestRawTextAngleBrackets(t *testing.T) {
	ex := dataeng.NewExtractor()
	feedAll(t, ex, []dataeng.Event{
		{Kind: dataeng.KindStartTag, Name: "script", Span: dataeng.Range{Start: 0, End: 8}},
		{Kind: dataeng.KindText, Data: "if (a < b) { ", Span: dataeng.Range{Start: 8, End: 21}},
		// A naive upstream may emit this as a tag; raw text state must
		// swallow it instead of opening an element.
		{Kind: dataeng.KindStartTag, Name: "b", Span: dataeng.Range{Start: 21, End: 24}},
		{Kind: dataeng.KindText, Data: "}", Span: dataeng.Range{Start: 24, End: 25}},
		// A non-matching end tag is raw text too, not the end of the script.
		{Kind: dataeng.KindEndTag, Name: "div", Span: dataeng.Range{Start: 25, End: 31}},
		{Kind: dataeng.KindEndTag, Name: "script", Span: dataeng.Range{Start: 31, End: 40}},
		{Kind: dataeng.KindText, Data: "ok", Span: dataeng.Range{Start: 40, End: 42}},
	})

	if got, want := ex.Text(), "ok"; got != want {
		t.Errorf("Text() = %q, want %q", got, want)
	}
	wantHidden := []dataeng.Range{
		{Start: 8, End: 21},
		{Start: 21, End: 24},
		{Start: 24, End: 25},
		{Start: 25, End: 31},
	}
	if got := ex.Hidden(); !reflect.DeepEqual(got, wantHidden) {
		t.Errorf("Hidden() = %v, want %v", got, wantHidden)
	}
}

// style and textarea behave like script: content hidden, ranges kept.
func TestRawTextStyleAndTextarea(t *testing.T) {
	ex := dataeng.NewExtractor()
	feedAll(t, ex, []dataeng.Event{
		{Kind: dataeng.KindStartTag, Name: "STYLE", Span: dataeng.Range{Start: 0, End: 7}},
		{Kind: dataeng.KindText, Data: "a < b", Span: dataeng.Range{Start: 7, End: 12}},
		{Kind: dataeng.KindEndTag, Name: "style", Span: dataeng.Range{Start: 12, End: 20}},
		{Kind: dataeng.KindStartTag, Name: "textarea", Span: dataeng.Range{Start: 20, End: 30}},
		{Kind: dataeng.KindText, Data: "<div>not markup</div>", Span: dataeng.Range{Start: 30, End: 51}},
		{Kind: dataeng.KindEndTag, Name: "textarea", Span: dataeng.Range{Start: 51, End: 62}},
		{Kind: dataeng.KindText, Data: "shown", Span: dataeng.Range{Start: 62, End: 67}},
	})

	if got, want := ex.Text(), "shown"; got != want {
		t.Errorf("Text() = %q, want %q", got, want)
	}
	wantHidden := []dataeng.Range{
		{Start: 7, End: 12},
		{Start: 30, End: 51},
	}
	if got := ex.Hidden(); !reflect.DeepEqual(got, wantHidden) {
		t.Errorf("Hidden() = %v, want %v", got, wantHidden)
	}
}

// Comments are never visible; inside raw text a comment is just raw text.
func TestCommentsNotVisible(t *testing.T) {
	ex := dataeng.NewExtractor()
	feedAll(t, ex, []dataeng.Event{
		{Kind: dataeng.KindText, Data: "a", Span: dataeng.Range{Start: 0, End: 1}},
		{Kind: dataeng.KindComment, Data: " <p>hidden</p> ", Span: dataeng.Range{Start: 1, End: 21}},
		{Kind: dataeng.KindText, Data: "b", Span: dataeng.Range{Start: 21, End: 22}},
		{Kind: dataeng.KindStartTag, Name: "script", Span: dataeng.Range{Start: 22, End: 30}},
		{Kind: dataeng.KindComment, Data: "still raw", Span: dataeng.Range{Start: 30, End: 45}},
		{Kind: dataeng.KindEndTag, Name: "script", Span: dataeng.Range{Start: 45, End: 54}},
	})

	if got, want := ex.Text(), "ab"; got != want {
		t.Errorf("Text() = %q, want %q", got, want)
	}
	wantHidden := []dataeng.Range{{Start: 30, End: 45}}
	if got := ex.Hidden(); !reflect.DeepEqual(got, wantHidden) {
		t.Errorf("Hidden() = %v, want %v", got, wantHidden)
	}
}

// Block-level ends append one newline; consecutive newlines merge into one.
func TestBlockNewlineMerging(t *testing.T) {
	ex := dataeng.NewExtractor()
	feedAll(t, ex, []dataeng.Event{
		// No leading newline is emitted for a leading block end.
		{Kind: dataeng.KindEndTag, Name: "div"},
		{Kind: dataeng.KindText, Data: "a"},
		{Kind: dataeng.KindEndTag, Name: "div"},
		{Kind: dataeng.KindEndTag, Name: "p"},
		{Kind: dataeng.KindEndTag, Name: "section"},
		{Kind: dataeng.KindText, Data: "b"},
		// Void and self-closing block tags end immediately.
		{Kind: dataeng.KindStartTag, Name: "br"},
		{Kind: dataeng.KindStartTag, Name: "hr"},
		{Kind: dataeng.KindStartTag, Name: "div", SelfClosing: true},
		{Kind: dataeng.KindText, Data: "c"},
		{Kind: dataeng.KindEndTag, Name: "p"},
	})

	if got, want := ex.Text(), "a\nb\nc\n"; got != want {
		t.Errorf("Text() = %q, want %q", got, want)
	}
}

// An event cut off in the middle of a tag yields StatusPending and changes
// no state; the completed event can be fed afterwards.
func TestPartialTagReturnsPending(t *testing.T) {
	ex := dataeng.NewExtractor()

	partial := dataeng.Event{Kind: dataeng.KindStartTag, Name: "scr", Partial: true, Span: dataeng.Range{Start: 0, End: 4}}
	if st := ex.Feed(partial); st != dataeng.StatusPending {
		t.Fatalf("Feed(partial) = %v, want StatusPending", st)
	}

	// State is untouched: the partial <scr... did not open raw text state.
	feedAll(t, ex, []dataeng.Event{
		{Kind: dataeng.KindText, Data: "x", Span: dataeng.Range{Start: 4, End: 5}},
	})
	if got, want := ex.Text(), "x"; got != want {
		t.Fatalf("Text() = %q, want %q", got, want)
	}

	// The completed event opens raw text state as usual.
	feedAll(t, ex, []dataeng.Event{
		{Kind: dataeng.KindStartTag, Name: "script", Span: dataeng.Range{Start: 0, End: 8}},
		{Kind: dataeng.KindText, Data: "hidden", Span: dataeng.Range{Start: 8, End: 14}},
		{Kind: dataeng.KindEndTag, Name: "script", Span: dataeng.Range{Start: 14, End: 23}},
	})
	if got, want := ex.Text(), "x"; got != want {
		t.Errorf("Text() = %q, want %q", got, want)
	}
	wantHidden := []dataeng.Range{{Start: 8, End: 14}}
	if got := ex.Hidden(); !reflect.DeepEqual(got, wantHidden) {
		t.Errorf("Hidden() = %v, want %v", got, wantHidden)
	}
}

// ExampleExtractor shows a page scraper feeding a tokenized event stream.
func ExampleExtractor() {
	ex := dataeng.NewExtractor()
	events := []dataeng.Event{
		{Kind: dataeng.KindStartTag, Name: "p"},
		{Kind: dataeng.KindText, Data: "Hello"},
		{Kind: dataeng.KindEndTag, Name: "p"},
		{Kind: dataeng.KindStartTag, Name: "script"},
		{Kind: dataeng.KindText, Data: "a < b"},
		{Kind: dataeng.KindEndTag, Name: "script"},
		{Kind: dataeng.KindComment, Data: "note"},
		{Kind: dataeng.KindStartTag, Name: "p"},
		{Kind: dataeng.KindText, Data: "world"},
		{Kind: dataeng.KindEndTag, Name: "p"},
	}
	for _, ev := range events {
		ex.Feed(ev)
	}
	fmt.Print(ex.Text())
	// Output:
	// Hello
	// world
}
