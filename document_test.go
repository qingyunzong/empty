package bracketdiag

import "testing"

// check 校验文档增量结果与全量扫描一致。
func check(t *testing.T, d *Document) {
	t.Helper()
	if err := d.Verify(); err != nil {
		t.Fatalf("%v\ntext: %q\ngot: %+v\nwant: %+v",
			err, d.Text(), d.Diagnostics(), Analyze(d.Text()))
	}
}

func mustEdit(t *testing.T, d *Document, start, end int, text string) {
	t.Helper()
	if err := d.Edit(start, end, text); err != nil {
		t.Fatalf("edit [%d,%d) %q: %v", start, end, text, err)
	}
}

// TestEditChangesLexicalState 覆盖编辑改变后续词法状态的场景：
// 插入引号使后续括号进入字符串，删除引号又使其恢复。
func TestEditChangesLexicalState(t *testing.T) {
	d := NewDocument("f(a, b)")
	check(t, d)
	if len(d.Diagnostics().Pairs) != 1 {
		t.Fatalf("initial: %+v", d.Diagnostics())
	}

	// 在 '(' 前插入 '"'，后续内容变为字符串，括号不再计入。
	mustEdit(t, d, 1, 1, `"`)
	check(t, d)
	if got := d.Diagnostics(); len(got.Pairs) != 0 || got.EarliestError != -1 {
		t.Fatalf("after quote insert: %+v", got)
	}

	// 删除该 '"'，括号恢复匹配。
	mustEdit(t, d, 1, 2, "")
	check(t, d)
	if got := d.Diagnostics(); len(got.Pairs) != 1 || got.EarliestError != -1 {
		t.Fatalf("after quote delete: %+v", got)
	}
}

// TestEditBlockCommentState 覆盖跨行块注释状态被编辑改变的情况。
func TestEditBlockCommentState(t *testing.T) {
	d := NewDocument("a() /* c */\nb( x )\nc( y )")
	check(t, d)
	if len(d.Diagnostics().Pairs) != 3 {
		t.Fatalf("initial: %+v", d.Diagnostics())
	}

	// 删除 "*/"：块注释延续到文末，后两行的括号被吞掉。
	idx := 9 // "*/" 的位置
	if d.Text()[idx:idx+2] != "*/" {
		t.Fatalf("bad fixture: %q", d.Text())
	}
	mustEdit(t, d, idx, idx+2, "")
	check(t, d)
	if got := d.Diagnostics(); len(got.Pairs) != 1 || len(got.UnmatchedOpens) != 0 {
		t.Fatalf("after removing */: %+v", got)
	}

	// 在原位置补回 "*/"：文本复原，括号重新生效。
	mustEdit(t, d, idx, idx, "*/")
	check(t, d)
	if len(d.Diagnostics().Pairs) != 3 {
		t.Fatalf("after restoring */: %+v", d.Diagnostics())
	}
}

func TestEditInsertDeleteBrackets(t *testing.T) {
	d := NewDocument("f()")
	check(t, d)
	// 插入一个开括号："f(()" 中位置 1 的 '(' 未闭合。
	mustEdit(t, d, 2, 2, "(")
	check(t, d)
	if got := d.Diagnostics(); got.EarliestError != 1 || len(got.UnmatchedOpens) != 1 {
		t.Fatalf("earliest: got %d (%+v)", got.EarliestError, got)
	}
	// 还原后再删除 '('，制造未配对闭括号。
	mustEdit(t, d, 2, 3, "")
	mustEdit(t, d, 1, 2, "")
	check(t, d)
	if got := d.Diagnostics(); len(got.UnmatchedCloses) != 1 || got.EarliestError != 1 {
		t.Fatalf("unmatched closes: %+v", got)
	}
}

func TestEditOutOfBounds(t *testing.T) {
	d := NewDocument("abc")
	if err := d.Edit(-1, 1, "x"); err == nil {
		t.Fatal("expected error for negative start")
	}
	if err := d.Edit(2, 1, "x"); err == nil {
		t.Fatal("expected error for end < start")
	}
	if err := d.Edit(0, 4, "x"); err == nil {
		t.Fatal("expected error for end > len")
	}
	if err := d.Edit(0, 3, ""); err != nil {
		t.Fatal(err)
	}
	if d.Text() != "" {
		t.Fatalf("text: %q", d.Text())
	}
	check(t, d)
}
