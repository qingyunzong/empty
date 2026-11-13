package dataeng

import (
	"bufio"
	"fmt"
	"io"
	"strconv"
	"strings"
)

// CDXRecord 描述一条 CDX 索引记录，包含定位 WARC 字节范围所需的
// filename、offset、length，以及用于校验的 digest 与 status。
type CDXRecord struct {
	URLKey    string
	Timestamp string // 14 位 crawl 时间戳，代表 crawl/time 世代
	URL       string
	Mime      string
	Status    string
	Digest    string // base32(无填充) 编码的 SHA-1，对应返回字节范围
	Offset    int64
	Length    int64
	Filename  string
}

// ParseCDXLine 解析单行 CDX（Common Crawl 11 字段格式）：
// urlkey timestamp url mime status digest redirect robotflags length offset filename
func ParseCDXLine(line string) (CDXRecord, error) {
	var rec CDXRecord
	line = strings.TrimSpace(line)
	if line == "" || strings.HasPrefix(line, "CDX ") || strings.HasPrefix(line, " CDX") {
		return rec, fmt.Errorf("dataeng: 非数据行: %q", line)
	}
	fields := strings.Fields(line)
	if len(fields) < 11 {
		return rec, fmt.Errorf("dataeng: CDX 字段不足(%d<11): %q", len(fields), line)
	}
	length, err := strconv.ParseInt(fields[8], 10, 64)
	if err != nil {
		return rec, fmt.Errorf("dataeng: 非法 length %q: %w", fields[8], err)
	}
	offset, err := strconv.ParseInt(fields[9], 10, 64)
	if err != nil {
		return rec, fmt.Errorf("dataeng: 非法 offset %q: %w", fields[9], err)
	}
	if length <= 0 {
		return rec, fmt.Errorf("dataeng: length 必须为正: %d", length)
	}
	if offset < 0 {
		return rec, fmt.Errorf("dataeng: offset 不能为负: %d", offset)
	}
	rec = CDXRecord{
		URLKey:    fields[0],
		Timestamp: fields[1],
		URL:       fields[2],
		Mime:      fields[3],
		Status:    fields[4],
		Digest:    fields[5],
		Length:    length,
		Offset:    offset,
		Filename:  fields[10],
	}
	return rec, nil
}

// ParseCDX 从 r 中解析全部 CDX 数据行，跳过空行与表头。
func ParseCDX(r io.Reader) ([]CDXRecord, error) {
	var out []CDXRecord
	sc := bufio.NewScanner(r)
	sc.Buffer(make([]byte, 0, 64*1024), 1024*1024)
	lineNo := 0
	for sc.Scan() {
		lineNo++
		line := strings.TrimSpace(sc.Text())
		if line == "" || strings.HasPrefix(line, "CDX ") || strings.HasPrefix(line, " CDX") {
			continue
		}
		rec, err := ParseCDXLine(line)
		if err != nil {
			return nil, fmt.Errorf("dataeng: 第 %d 行: %w", lineNo, err)
		}
		out = append(out, rec)
	}
	if err := sc.Err(); err != nil {
		return nil, err
	}
	return out, nil
}

// Fetchable 报告该记录是否值得发起范围请求：仅接受 2xx 状态。
// revisit（status 为 "-"）等记录不直接抓取。
func (r CDXRecord) Fetchable() bool {
	if len(r.Status) != 3 {
		return false
	}
	return r.Status[0] == '2'
}

// RangeHeader 返回该记录对应的 HTTP Range 头值（闭区间）。
func (r CDXRecord) RangeHeader() string {
	return fmt.Sprintf("bytes=%d-%d", r.Offset, r.Offset+r.Length-1)
}

// Deduplicate 按 digest 去除 CDX 重复项：同一 digest 的多条记录中，
// 保留 crawl/time 世代最新（timestamp 最大）的一条；时间戳相同时按
// filename、offset 确定性决胜。输入顺序不影响结果。
func Deduplicate(recs []CDXRecord) []CDXRecord {
	best := make(map[string]CDXRecord, len(recs))
	for _, rec := range recs {
		cur, ok := best[rec.Digest]
		if !ok || newerGeneration(rec, cur) {
			best[rec.Digest] = rec
		}
	}
	out := make([]CDXRecord, 0, len(best))
	for _, rec := range recs {
		if kept, ok := best[rec.Digest]; ok && sameRecord(kept, rec) {
			out = append(out, rec)
			delete(best, rec.Digest)
		}
	}
	return out
}

// newerGeneration 报告 a 是否属于比 b 更新的 crawl/time 世代。
func newerGeneration(a, b CDXRecord) bool {
	if a.Timestamp != b.Timestamp {
		return a.Timestamp > b.Timestamp
	}
	if a.Filename != b.Filename {
		return a.Filename > b.Filename
	}
	return a.Offset > b.Offset
}

func sameRecord(a, b CDXRecord) bool {
	return a.Digest == b.Digest && a.Timestamp == b.Timestamp &&
		a.Filename == b.Filename && a.Offset == b.Offset
}
