package main

import "testing"

func TestParseValid(t *testing.T) {
	h, err := ParseHistory("W1(x) R2(x1) W2(y), R1(y2)")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(h.Ops) != 4 {
		t.Fatalf("got %d ops, want 4", len(h.Ops))
	}
	if len(h.Txns) != 2 || h.Txns[0] != 1 || h.Txns[1] != 2 {
		t.Fatalf("bad txns: %v", h.Txns)
	}
	if h.Ops[0].Kind != 'W' || h.Ops[0].Version != 1 {
		t.Fatalf("bad op0: %+v", h.Ops[0])
	}
	if h.Ops[1].Kind != 'R' || h.Ops[1].Version != 1 || h.Ops[1].Item != "x" {
		t.Fatalf("bad op1: %+v", h.Ops[1])
	}
}

func TestParseErrors(t *testing.T) {
	cases := []string{
		"",             // 空
		"W1(x) R2(x)",  // 读缺版本
		"W1(x1)",       // 写带版本
		"R2(x1)",       // 读未写入的版本
		"W1(x) W1(x)",  // 重复写同一数据项
		"C1(x)",        // 非法操作
		"W1(x) R2(y1)", // 读错数据项的版本
	}
	for _, c := range cases {
		if _, err := ParseHistory(c); err == nil {
			t.Errorf("ParseHistory(%q) expected error, got nil", c)
		}
	}
}

func TestParseTooManyTxns(t *testing.T) {
	input := "W1(a) W2(b) W3(c) W4(d) W5(e) W6(f) W7(g) W8(h) W9(i) W10(j) W11(k) W12(l) W13(m)"
	if _, err := ParseHistory(input); err == nil {
		t.Fatal("expected too-many-transactions error")
	}
}

func TestParseTwelveTxnsOK(t *testing.T) {
	input := "W1(a) W2(b) W3(c) W4(d) W5(e) W6(f) W7(g) W8(h) W9(i) W10(j) W11(k) W12(l)"
	if _, err := ParseHistory(input); err != nil {
		t.Fatalf("12 transactions should be allowed: %v", err)
	}
}
