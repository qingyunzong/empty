package brackdiag

import (
	"math/rand"
	"testing"
)

// fragments that stress the lexer: brackets, quotes, escapes,
// comment openers/closers and plain text.
var fragments = []string{
	"a", "bb", " ", "\n", "\n\n",
	"(", ")", "[", "]", "{", "}",
	"()", "[]", "{}", "(]", "{)",
	`"`, `'`, "`", `\`, `\\`, `\"`, `\'`,
	`"str"`, `'c'`, "'\\n'", "`raw`",
	"/", "//", "/*", "*/", "/**/", "// c\n", "/* c */",
	"x", "0", ";", "=",
}

func randText(r *rand.Rand, n int) string {
	s := ""
	for i := 0; i < n; i++ {
		s += fragments[r.Intn(len(fragments))]
	}
	return s
}

func diagEqual(a, b Diag) bool {
	return pairsEqual(a.Pairs, b.Pairs) &&
		unmatchedEqual(a.Unmatched, b.Unmatched) &&
		a.ErrOff == b.ErrOff
}

func checkConsistent(t *testing.T, d *Document, ctx string) {
	t.Helper()
	want := Scan(d.Text())
	got := d.Diagnostics()
	if !diagEqual(got, want) {
		t.Fatalf("%s: incremental != full scan\ntext=%q\ngot  %+v\nwant %+v",
			ctx, d.Text(), got, want)
	}
}

// TestRandomEdits applies random inserts/deletes/replacements and, after
// every single edit, requires the incremental diagnostics to equal a
// full re-scan of the current text.
func TestRandomEdits(t *testing.T) {
	for seed := int64(0); seed < 30; seed++ {
		r := rand.New(rand.NewSource(seed))
		doc := NewDocument(randText(r, 40))
		checkConsistent(t, doc, "initial")
		for i := 0; i < 300; i++ {
			text := doc.Text()
			off := 0
			if len(text) > 0 {
				off = r.Intn(len(text) + 1)
			}
			del := 0
			if len(text) > off {
				del = r.Intn(len(text) - off + 1)
			}
			insert := randText(r, r.Intn(6))
			doc.Edit(off, del, insert)
			checkConsistent(t, doc, "after random edit")
		}
	}
}

// TestChunkAppend builds documents by appending chunks of every size and
// checks consistency after each chunk, including chunks that split
// strings, escapes and comment markers across boundaries.
func TestChunkAppend(t *testing.T) {
	texts := []string{
		`fn main() { println("("); /* ] */ }`,
		"a/*\n(b\n*/c)",
		"`raw\n(string`\n(ok)",
		`quote: "\"" + '(' + '\\'`,
		"// ( [\n{[(])]",
		"/** unterminated\n(comment (",
		"unterminated \"string (",
		"}{)(][",
		`a/`, `/b`, `c//`, `d/*`, `e"`, `f'` + "'", "`g",
	}
	for _, text := range texts {
		for size := 1; size <= len(text) && size <= 9; size++ {
			doc := NewDocument("")
			for off := 0; off < len(text); off += size {
				end := off + size
				if end > len(text) {
					end = len(text)
				}
				doc.Edit(len(doc.Text()), 0, text[off:end])
				checkConsistent(t, doc, "chunk append")
			}
			if doc.Text() != text {
				t.Fatalf("chunk append size=%d: text mismatch\ngot  %q\nwant %q", size, doc.Text(), text)
			}
		}
	}
}

// TestChunkPrepend inserts chunks in reverse order at offset 0, so every
// insert may change the lexical state of all following content.
func TestChunkPrepend(t *testing.T) {
	texts := []string{
		"/* comment ( */ code ()",
		"\"(string)\" (code)",
		"a // )\nb ()",
		"`(\n)` ()",
		"*/ () /*",
	}
	for _, text := range texts {
		for size := 1; size <= len(text) && size <= 7; size++ {
			doc := NewDocument("")
			for end := len(text); end > 0; {
				start := end - size
				if start < 0 {
					start = 0
				}
				doc.Edit(0, 0, text[start:end])
				checkConsistent(t, doc, "chunk prepend")
				end = start
			}
			if doc.Text() != text {
				t.Fatalf("chunk prepend size=%d: text mismatch\ngot  %q\nwant %q", size, doc.Text(), text)
			}
		}
	}
}

// TestChunkRecombine splits a text into chunks and re-inserts them at
// random positions in random order, checking consistency at each step.
func TestChunkRecombine(t *testing.T) {
	r := rand.New(rand.NewSource(99))
	for iter := 0; iter < 200; iter++ {
		text := randText(r, 25)
		// split into random chunks
		var chunks []string
		for len(text) > 0 {
			n := 1 + r.Intn(len(text))
			chunks = append(chunks, text[:n])
			text = text[n:]
		}
		doc := NewDocument("")
		// insert chunks in random order at random valid positions
		for len(chunks) > 0 {
			i := r.Intn(len(chunks))
			pos := r.Intn(len(doc.Text()) + 1)
			doc.Edit(pos, 0, chunks[i])
			checkConsistent(t, doc, "chunk recombine")
			chunks = append(chunks[:i], chunks[i+1:]...)
		}
		// random deletions until empty
		for len(doc.Text()) > 0 {
			cur := doc.Text()
			off := r.Intn(len(cur))
			del := 1 + r.Intn(len(cur)-off)
			doc.Edit(off, del, "")
			checkConsistent(t, doc, "chunk recombine delete")
		}
	}
}

// TestEditShiftsLexState targets edits that toggle comment/string state
// for the rest of the file.
func TestEditShiftsLexState(t *testing.T) {
	doc := NewDocument("/* ) */ ()")
	checkConsistent(t, doc, "initial")
	doc.Edit(0, 2, "") // remove "/*": ") */ ()" now lexes as code
	checkConsistent(t, doc, "after removing comment opener")
	got := doc.Diagnostics()
	if got.ErrOff != 1 {
		t.Fatalf("expected earliest error at 1, got %d (%+v)", got.ErrOff, got)
	}
	doc.Edit(0, 0, `"`) // open a string: everything after is a literal
	checkConsistent(t, doc, "after inserting quote")
	if len(doc.Diagnostics().Pairs) != 0 || len(doc.Diagnostics().Unmatched) != 0 {
		t.Fatalf("expected no brackets, got %+v", doc.Diagnostics())
	}
}
