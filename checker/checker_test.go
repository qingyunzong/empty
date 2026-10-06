package checker

import (
	"strings"
	"testing"
)

func mustParse(t *testing.T, log string) []Event {
	t.Helper()
	events, err := Parse(strings.NewReader(log))
	if err != nil {
		t.Fatalf("解析失败: %v", err)
	}
	return events
}

func checkLog(t *testing.T, log string) *Violation {
	t.Helper()
	return CheckEvents(mustParse(t, log))
}

func TestValidLogWithGenerations(t *testing.T) {
	log := `
# 库读日志：含取消未授予、票据代际复用、上限调整
CAP 10
REQ A 4
REQ B 6
GRT A
CXL B
REQ B 6
GRT B
REL A
REL B
CAP 0
REQ A 1
CXL A
`
	if v := checkLog(t, log); v != nil {
		t.Fatalf("合法日志被误判: %v", v)
	}
}

func TestCancelUngrantedDoesNotRelease(t *testing.T) {
	log := `
CAP 10
REQ A 4
REQ B 6
GRT B
CXL A
CAP 6
`
	if v := checkLog(t, log); v != nil {
		t.Fatalf("取消未授予不应释放额度，合法日志被误判: %v", v)
	}
}

func TestDuplicateRelease(t *testing.T) {
	log := `
CAP 10
REQ A 4
GRT A
REL A
REL A
`
	v := checkLog(t, log)
	if v == nil {
		t.Fatal("重复释放未报错")
	}
	if v.Line != 6 {
		t.Fatalf("首错行号 = %d, 期望 6", v.Line)
	}
	if !strings.Contains(v.Msg, "重复释放") {
		t.Fatalf("错误信息不含「重复释放」: %s", v.Msg)
	}
	chain := strings.Join(v.Chain, "\n")
	for _, want := range []string{"L4 GRT A", "L5 REL A", "L6 REL A"} {
		if !strings.Contains(chain, want) {
			t.Fatalf("因果链缺少 %q:\n%s", want, chain)
		}
	}
}

func TestReleaseBeforeGrant(t *testing.T) {
	log := `
CAP 5
REQ A 1
REL A
`
	v := checkLog(t, log)
	if v == nil || !strings.Contains(v.Msg, "尚未授予") {
		t.Fatalf("释放未授予票据未正确报错: %v", v)
	}
}

func TestReleaseCanceledTicket(t *testing.T) {
	log := `
CAP 5
REQ A 2
CXL A
REL A
`
	v := checkLog(t, log)
	if v == nil || !strings.Contains(v.Msg, "已取消") {
		t.Fatalf("释放已取消票据未正确报错: %v", v)
	}
}

func TestCancelGrantedTicket(t *testing.T) {
	log := `
CAP 5
REQ A 1
GRT A
CXL A
`
	v := checkLog(t, log)
	if v == nil || !strings.Contains(v.Msg, "取消不释放") {
		t.Fatalf("取消已授予票据未正确报错: %v", v)
	}
}

func TestGrantExceedsCap(t *testing.T) {
	log := `
CAP 5
REQ A 3
REQ B 3
GRT A
GRT B
`
	v := checkLog(t, log)
	if v == nil {
		t.Fatal("授予超上限未报错")
	}
	if v.Line != 6 {
		t.Fatalf("首错行号 = %d, 期望 6", v.Line)
	}
	if !strings.Contains(v.Msg, "超出当刻上限") {
		t.Fatalf("错误信息不含「超出当刻上限」: %s", v.Msg)
	}
	chain := strings.Join(v.Chain, "\n")
	for _, want := range []string{"L2 CAP 5", "L5 GRT A", "L6 GRT B"} {
		if !strings.Contains(chain, want) {
			t.Fatalf("因果链缺少 %q:\n%s", want, chain)
		}
	}
}

func TestCapLoweredBelowInUse(t *testing.T) {
	log := `
CAP 5
REQ A 4
GRT A
CAP 3
`
	v := checkLog(t, log)
	if v == nil || !strings.Contains(v.Msg, "低于当刻在途授予总额") {
		t.Fatalf("上限低于在途总额未正确报错: %v", v)
	}
}

func TestDuplicateRequestSameGeneration(t *testing.T) {
	log := `
CAP 5
REQ A 1
REQ A 1
`
	v := checkLog(t, log)
	if v == nil || !strings.Contains(v.Msg, "重复申请") {
		t.Fatalf("同代际重复申请未正确报错: %v", v)
	}
}

func TestStaleReleaseAfterNewGeneration(t *testing.T) {
	log := `
CAP 5
REQ A 2
GRT A
REL A
REQ A 3
REL A
`
	v := checkLog(t, log)
	if v == nil || !strings.Contains(v.Msg, "尚未授予") {
		t.Fatalf("新代际未授予时的旧释放未正确报错: %v", v)
	}
}

func TestFirstErrorStops(t *testing.T) {
	log := `
CAP 5
REQ A 1
GRT A
REL A
REL A
REL B
`
	v := checkLog(t, log)
	if v == nil || v.Line != 6 {
		t.Fatalf("应报告首个错误 L6, 实际: %v", v)
	}
}

func TestParseErrors(t *testing.T) {
	for _, log := range []string{
		"CAP\n",
		"CAP -1\n",
		"REQ A\n",
		"REQ A 0\n",
		"GRT\n",
		"FLY A 1\n",
	} {
		if _, err := Parse(strings.NewReader(log)); err == nil {
			t.Fatalf("非法日志 %q 未报解析错误", log)
		}
	}
}
