package dataeng

import (
	"reflect"
	"testing"
)

func TestExtractLinksDocumentOrder(t *testing.T) {
	document := []byte(`<!DOCTYPE html>
<!-- a comment with <a href="/commented"> -->
<html>
<head><script>var x = '<a href="/script">';</script>
<style>a[href] { color: red; }</style></head>
<body>
  <a href="/first">first</a>
  <A HREF='/second' class="x">second</A>
  <a href=/third>third</a>
  <a href="/fourth?a=1&amp;b=2" target="_blank">entities</a>
  <a name="no-href">skip</a>
  <a href="/fifth#frag">fifth</a>
  <a href="">empty</a>
</body>
</html>`)

	got := extractLinks(document)
	want := []string{
		"/first",
		"/second",
		"/third",
		"/fourth?a=1&b=2",
		"/fifth#frag",
		"",
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("links = %v, want %v", got, want)
	}
}

func TestExtractLinksToleratesMalformedMarkup(t *testing.T) {
	document := []byte(`<a href="/ok">ok<a href=/again>again</a><div><a href='/last'`)
	got := extractLinks(document)
	want := []string{"/ok", "/again", "/last"}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("links = %v, want %v", got, want)
	}
}

func TestExtractLinksIgnoresNonAnchorHrefs(t *testing.T) {
	document := []byte(`<link href="/style.css"><area href="/map"><a href="/anchor">`)
	got := extractLinks(document)
	want := []string{"/anchor"}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("links = %v, want %v", got, want)
	}
}
