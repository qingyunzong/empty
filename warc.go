package dataeng

import (
	"bufio"
	"bytes"
	"compress/gzip"
	"fmt"
	"io"
	"strings"
)

// warcTargetURI 从一段 WARC 记录字节中提取 WARC-Target-URI。
// 支持裸 WARC 记录与单成员 gzip 压缩记录；用于确认返回的字节范围
// 确实是目标记录，而不是相邻的 WARC 记录。
func warcTargetURI(body []byte) (string, error) {
	raw := body
	if len(raw) >= 2 && raw[0] == 0x1f && raw[1] == 0x8b {
		zr, err := gzip.NewReader(bytes.NewReader(raw))
		if err != nil {
			return "", fmt.Errorf("dataeng: gzip 解压失败: %w", err)
		}
		defer zr.Close()
		// 只需 WARC 头部，限制读取量即可。
		raw, err = io.ReadAll(io.LimitReader(zr, 1<<20))
		if err != nil {
			return "", fmt.Errorf("dataeng: gzip 读取失败: %w", err)
		}
	}
	if !bytes.HasPrefix(raw, []byte("WARC/")) {
		return "", fmt.Errorf("dataeng: 字节范围不是 WARC 记录起始")
	}
	br := bufio.NewReader(bytes.NewReader(raw))
	for {
		line, err := br.ReadString('\n')
		if err != nil {
			return "", fmt.Errorf("dataeng: WARC 头部不完整: %w", err)
		}
		line = strings.TrimRight(line, "\r\n")
		if line == "" {
			break // 头部结束
		}
		if k, v, ok := strings.Cut(line, ":"); ok && strings.EqualFold(strings.TrimSpace(k), "WARC-Target-URI") {
			return strings.TrimSpace(v), nil
		}
	}
	return "", fmt.Errorf("dataeng: WARC 记录缺少 WARC-Target-URI")
}
