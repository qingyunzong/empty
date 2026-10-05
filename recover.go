package ledger

import "fmt"

// Mismatch 描述一次越界证据核对失败。
type Mismatch struct {
	Axis  Axis
	Index int   // 前缀位置（0 起始的前缀下标）
	Want  int64 // 全账重算值
	Got   int64 // 已发布快照值
}

func (m Mismatch) String() string {
	return fmt.Sprintf("axis=%s prefix[%d]: want %d, got %d", m.Axis, m.Index, m.Want, m.Got)
}

// Recover 执行故障恢复：以只追加日志为唯一事实来源，
// 在业务时间与提交时间两条轴上全账重算，重建双索引并原子发布，
// 然后逐项核对新快照与重算证据。返回核对发现的全部不一致。
func (l *Ledger) Recover() []Mismatch {
	l.mu.Lock()
	defer l.mu.Unlock()
	l.gen++
	fresh := buildSnapshot(l.log, l.gen)
	l.snap.Store(fresh)
	return VerifySnapshot(fresh)
}

// VerifySnapshot 对快照做独立逐项扫描（不使用快照内前缀和），
// 在两条轴上重算全部前缀并比对越界证据。
func VerifySnapshot(s *Snapshot) []Mismatch {
	var out []Mismatch
	for _, axis := range []Axis{AxisBusiness, AxisSubmit} {
		entries, pre := s.axisData(axis)
		var running int64
		if pre[0] != 0 {
			out = append(out, Mismatch{Axis: axis, Index: 0, Want: 0, Got: pre[0]})
		}
		for i, e := range entries {
			running += e.Amount
			if pre[i+1] != running {
				out = append(out, Mismatch{Axis: axis, Index: i + 1, Want: running, Got: pre[i+1]})
			}
		}
	}
	return out
}

// FirstExceedEvidence 汇总两轴的首次越界位置，供恢复后核对留档。
// 位置为 1 起始的条目计数，-1 表示未越界。
func (s *Snapshot) FirstExceedEvidence(budget int64) map[Axis]int {
	return map[Axis]int{
		AxisBusiness: s.FirstExceed(AxisBusiness, budget),
		AxisSubmit:   s.FirstExceed(AxisSubmit, budget),
	}
}
