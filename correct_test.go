package dataeng_test

import (
	"testing"
	"time"

	dataeng "example.org/dataeng13/q0074"
)

func ts(minute int) time.Time {
	return time.Date(2026, 11, 13, 10, minute, 0, 0, time.UTC)
}

// 已发布版本：键 a 有两个相邻版本，键 b 有一个版本。
var publishedVersions = []dataeng.Version{
	{Key: "a", Start: ts(0), End: ts(10)},
	{Key: "a", Start: ts(10), End: ts(20)},
	{Key: "b", Start: ts(0), End: ts(30)},
}

// 已发布事实。
var publishedFacts = []dataeng.Fact{
	{Key: "a", EventTime: ts(3), Value: "a@03"},
	{Key: "a", EventTime: ts(7), Value: "a@07"},
	{Key: "a", EventTime: ts(12), Value: "a@12"},
	{Key: "a", EventTime: ts(18), Value: "a@18"},
	{Key: "b", EventTime: ts(5), Value: "b@05"},
}

func TestCorrectOverlapRetractsHitsInInterval(t *testing.T) {
	late := dataeng.Version{Key: "a", Start: ts(5), End: ts(15)}

	c, ok := dataeng.Correct(publishedFacts, publishedVersions, late)
	if !ok {
		t.Fatal("expected correction for overlapping late version")
	}

	// 期望为手工书写的字面量：只有键 a 且事件时间落在 [10:05, 10:15) 的事实被撤回。
	wantRetract := []dataeng.Fact{
		{Key: "a", EventTime: ts(7), Value: "a@07"},
		{Key: "a", EventTime: ts(12), Value: "a@12"},
	}
	if !factsEqual(c.Retract, wantRetract) {
		t.Errorf("retract = %+v, want %+v", c.Retract, wantRetract)
	}

	// 区间原样交给调用方，包不自行切开与已发布版本的重叠。
	if c.Interval != late {
		t.Errorf("interval = %+v, want the late interval %+v unchanged", c.Interval, late)
	}

	// 用已发布事实对照：撤回的每条都必须来自已发布事实。
	for _, r := range c.Retract {
		if !containsFact(publishedFacts, r) {
			t.Errorf("retracted fact %+v is not a published fact", r)
		}
	}

	// 区间外及其余键的已发布事实保持不变：不得出现在撤回集中。
	untouched := []dataeng.Fact{
		{Key: "a", EventTime: ts(3), Value: "a@03"},
		{Key: "a", EventTime: ts(18), Value: "a@18"},
		{Key: "b", EventTime: ts(5), Value: "b@05"},
	}
	for _, u := range untouched {
		if containsFact(c.Retract, u) {
			t.Errorf("fact %+v outside the late interval must stay untouched", u)
		}
	}
}

func TestCorrectClosedOpenBoundaries(t *testing.T) {
	facts := []dataeng.Fact{
		{Key: "a", EventTime: ts(5), Value: "at-start"},
		{Key: "a", EventTime: ts(15), Value: "at-end"},
	}
	late := dataeng.Version{Key: "a", Start: ts(5), End: ts(15)}

	c, ok := dataeng.Correct(facts, publishedVersions, late)
	if !ok {
		t.Fatal("expected correction for overlapping late version")
	}

	// 闭开区间：起点处的事实命中被撤回，终点处的事实不受影响。
	wantRetract := []dataeng.Fact{
		{Key: "a", EventTime: ts(5), Value: "at-start"},
	}
	if !factsEqual(c.Retract, wantRetract) {
		t.Errorf("retract = %+v, want %+v", c.Retract, wantRetract)
	}
}

func TestCorrectNoOverlapNoOp(t *testing.T) {
	late := dataeng.Version{Key: "a", Start: ts(20), End: ts(25)}
	if _, ok := dataeng.Correct(publishedFacts, publishedVersions, late); ok {
		t.Error("disjoint late version must not trigger a correction")
	}

	otherKey := dataeng.Version{Key: "c", Start: ts(5), End: ts(15)}
	if _, ok := dataeng.Correct(publishedFacts, publishedVersions, otherKey); ok {
		t.Error("late version of an unknown key must not trigger a correction")
	}
}

func TestCorrectAdjacentVersionsDoNotOverlap(t *testing.T) {
	// 闭开区间下，与已发布版本首尾相接的迟到版本不重叠。
	late := dataeng.Version{Key: "a", Start: ts(20), End: ts(30)}
	if _, ok := dataeng.Correct(publishedFacts, publishedVersions, late); ok {
		t.Error("adjacent [20,30) after [10,20) must not be treated as overlap")
	}
}

func factsEqual(got, want []dataeng.Fact) bool {
	if len(got) != len(want) {
		return false
	}
	for _, f := range want {
		if !containsFact(got, f) {
			return false
		}
	}
	return true
}

func containsFact(list []dataeng.Fact, f dataeng.Fact) bool {
	for _, x := range list {
		if x == f {
			return true
		}
	}
	return false
}
