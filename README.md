# SFTP 目录快照稳定性

文件采集服务要可直接接入的 Go SFTP 目录快照器，面对上传中的临时文件、rename、mtime 精度差异和目录分页。文件需在两次观察间满足可配置稳定条件才交付；同 inode 信息不可用时用路径、大小与摘要世代判断。扫描取消后恢复不得把半观察文件标成稳定。

## 包结构

实现位于 `snapshot/`，零第三方依赖，通过 `FileSystem` 接口接入任意远端：

- `FileSystem`：`List(ctx, dir, cursor)` 分页列举 + `Open(ctx, path)` 读取内容，可直接适配 `github.com/pkg/sftp`。
- `Snapshotter.Scan(ctx, root)`：递归遍历目录树，返回本次转为稳定的文件；每个内容世代只交付一次。

## 关键语义

- **稳定条件**：文件须在 `StableScans`（默认 2）次**完整**扫描中大小、mtime（按 `MtimePrecision` 归一化，默认 1s）、内容摘要保持一致；可选 `StableAge` 附加最小文件年龄。
- **身份判断**：优先使用 `FileID`（dev+inode）；服务器不提供时，用路径 + 大小 + SHA-256 摘要世代（`Gen`）识别 rename 与内容变更——同摘要跨路径迁移观察历史，内容变化则世代递增、稳定计数清零。
- **临时文件**：`Config.Ignore` 默认 `DefaultIgnore`，跳过 `.tmp/.part/.partial/.crdownload/.download/.filepart/.swp`、dotfile 与 `~` 结尾文件；可自定义或设 `IgnoreNone`。
- **分页**：`List` 以游标翻页，空页非终止游标亦被容忍；每页检查 `ctx`，取消即中断。
- **取消恢复**：观察状态两阶段提交——只有完整成功的扫描才提交；取消/失败的扫描整体丢弃，恢复后不会把半观察文件标为稳定。`Export`/`Import` 可跨进程重启恢复已提交状态。

## 接入示例（pkg/sftp）

```go
type sftpFS struct{ c *sftp.Client }

func (f sftpFS) List(ctx context.Context, dir, cursor string) ([]snapshot.DirEntry, string, error) {
	// pkg/sftp 的 ReadDir 内部已处理服务端分页；这里按固定页大小
	// 切片对外暴露游标，cursor 为起始下标。
	start, _ := strconv.Atoi(cursor) // "" -> 0
	infos, err := f.c.ReadDir(dir)
	if err != nil {
		return nil, "", err
	}
	const page = 256
	end := min(start+page, len(infos))
	out := make([]snapshot.DirEntry, 0, end-start)
	for _, fi := range infos[start:end] {
		out = append(out, snapshot.DirEntry{
			Path:    path.Join(dir, fi.Name()),
			Size:    fi.Size(),
			ModTime: fi.ModTime(),
			IsDir:   fi.IsDir(),
			// 若服务器支持 statvfs/扩展属性提供 inode，填充 ID 与 HasID。
		})
	}
	next := ""
	if end < len(infos) {
		next = strconv.Itoa(end)
	}
	return out, next, nil
}

func (f sftpFS) Open(ctx context.Context, p string) (io.ReadCloser, error) {
	return f.c.Open(p)
}

snap := snapshot.New(sftpFS{client}, snapshot.Config{StableScans: 2})
files, err := snap.Scan(ctx, "/inbox") // files 即为可安全采集的稳定文件
```

## 测试

```sh
go test ./snapshot/
```
