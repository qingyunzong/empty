package dataeng

import (
	"errors"
	"strings"
	"testing"
)

func TestOpHelpers(t *testing.T) {
	if !OpHardClip.Valid() {
		t.Fatalf("OpHardClip 应是合法枚举")
	}
	var bogus Op = 99
	if bogus.Valid() || bogus.Byte() != '?' || bogus.String() != "?" {
		t.Fatalf("未知 Op 处理错误")
	}
	for _, op := range []Op{OpM, OpEqual, OpDiff, OpInsertion, OpDeletion, OpRefSkip, OpSoftClip, OpHardClip} {
		if op.Byte() == '?' || len(op.String()) != 1 {
			t.Fatalf("Op %d 字符映射错误", op)
		}
	}
	if OpM.ConsumesRef() != true || OpInsertion.ConsumesRef() != false ||
		OpDeletion.ConsumesRead() != false || OpSoftClip.ConsumesRead() != true {
		t.Fatalf("消费标志错误")
	}
}

func TestOpErrorMessage(t *testing.T) {
	e := &OpError{OpIndex: 7, Err: ErrZeroLength}
	if !strings.Contains(e.Error(), "7") || !errors.Is(e, ErrZeroLength) {
		t.Fatalf("OpError 消息缺少下标: %q", e.Error())
	}
	noIdx := &OpError{OpIndex: -1, Err: ErrWindowReversed}
	if strings.Contains(noIdx.Error(), "下标") {
		t.Fatalf("无下标错误不应包含下标文本: %q", noIdx.Error())
	}
}

func TestParseCIGARErrors(t *testing.T) {
	for _, s := range []string{"", "10", "M", "5Q", "5M3", "999999999999999999999999M"} {
		if _, err := ParseCIGAR(s); err == nil {
			t.Fatalf("ParseCIGAR(%q) 应报错", s)
		}
	}
	ops, err := ParseCIGAR("12M3I")
	if err != nil || len(ops) != 2 || ops[0].Length != 12 || ops[1].Kind != OpInsertion {
		t.Fatalf("正常解析失败: %+v err=%v", ops, err)
	}
}

func TestNilClippedAndNoRead(t *testing.T) {
	var nilC *Clipped
	if nilC.ReadLength() != 0 || nilC.RefLength() != 0 || nilC.CIGARString() != "" {
		t.Fatalf("nil Clipped 访问器应返回零值")
	}

	// 记录只在窗口外有 M：窗口完全落在 D 缺口内，empty。
	r := makeRecord(t, 10, "2D4M")
	c, err := Clip(r, 10, 12)
	if err != nil || !c.Empty {
		t.Fatalf("纯 D 窗口应 empty: c=%+v err=%v", c, err)
	}
	if c.ReadLength() != 0 || c.RefLength() != 0 {
		t.Fatalf("empty 记录长度应为 0")
	}

	// 窗口保留 M 但不保留任何读段碱基的情况不存在（M 必消费读段），
	// 这里核对有 M 时 ReadRetained 恒为 true。
	c2, err := Clip(r, 12, 14)
	if err != nil || c2.Empty || !c2.ReadRetained {
		t.Fatalf("M 窗口应保留读段: %+v err=%v", c2, err)
	}
}

func TestUitoa(t *testing.T) {
	cases := map[uint64]string{0: "0", 9: "9", 10: "10", 123456: "123456"}
	for in, want := range cases {
		if got := uitoa(in); got != want {
			t.Fatalf("uitoa(%d)=%q 期望 %q", in, got, want)
		}
	}
}
