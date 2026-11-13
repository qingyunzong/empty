package dataeng

// Correct 在迟到维度版本 late 到达后，基于已发布事实和已发布版本计算改正，
// 不重读事实源。
//
// 仅当 late 与某个同键已发布版本的闭开区间重叠时才需要改正，此时返回
// ok=true：该键已发出且事件时间落在 late 区间内的命中事实全部列入
// Correction.Retract 予以撤回；Correction.Interval 原样携带 late 的区间，
// 交给调用方修正，包不自行切开重叠部分。区间外及其他键的事实不受影响。
// 无重叠时返回 ok=false，表示无需任何改正。
func Correct(publishedFacts []Fact, publishedVersions []Version, late Version) (c Correction, ok bool) {
	overlaps := false
	for _, pv := range publishedVersions {
		if late.Overlaps(pv) {
			overlaps = true
			break
		}
	}
	if !overlaps {
		return Correction{}, false
	}

	c = Correction{Late: late, Interval: late}
	for _, f := range publishedFacts {
		if f.Key == late.Key && late.Contains(f.EventTime) {
			c.Retract = append(c.Retract, f)
		}
	}
	return c, true
}
