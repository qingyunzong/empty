package formal

import (
	"fmt"
	"runtime"
	"sync"
	"testing"
)

func TestConcurrentRenameAndDelete(t *testing.T) {
	fs := New()
	const workers = 4

	must(t, fs.MkdirAll("/shared/dir/sub"))
	must(t, fs.CreateFile("/shared/base", 4096))
	must(t, fs.CreateFile("/shared/dir/sub/x", 50))
	must(t, fs.Link("/shared/dir/sub/x", "/shared/x-link"))

	for i := 0; i < workers; i++ {
		must(t, fs.MkdirAll(fmt.Sprintf("/w%d/a", i)))
		must(t, fs.MkdirAll(fmt.Sprintf("/w%d/b", i)))
		must(t, fs.MkdirAll(fmt.Sprintf("/w%d/tree/sub", i)))
		must(t, fs.CreateFile(fmt.Sprintf("/w%d/tree/sub/file", i), int64(100+i)))
		must(t, fs.Link("/shared/base", fmt.Sprintf("/w%d/a/base", i)))
	}
	checkEveryDirectory(t, fs)

	var workerWG sync.WaitGroup
	var monitorWG sync.WaitGroup
	stop := make(chan struct{})
	errs := make(chan error, workers+4)

	report := func(err error) {
		if err == nil {
			return
		}
		select {
		case errs <- err:
		default:
		}
	}

	monitorWG.Add(1)
	go func() {
		defer monitorWG.Done()
		for {
			select {
			case <-stop:
				return
			default:
			}
			if err := fs.Check(); err != nil {
				report(fmt.Errorf("concurrent Check: %w", err))
				return
			}
			runtime.Gosched()
		}
	}()

	for i := 0; i < workers; i++ {
		workerWG.Add(1)
		go func(i int) {
			defer workerWG.Done()
			dirA := fmt.Sprintf("/w%d/a", i)
			dirB := fmt.Sprintf("/w%d/b", i)
			treeA := fmt.Sprintf("/w%d/tree", i)
			treeB := fmt.Sprintf("/w%d/renamed", i)

			for n := 0; n < 300; n++ {
				name := fmt.Sprintf("link-%d-%d", i, n)
				src := dirA + "/" + name
				dst := dirB + "/" + name

				if err := fs.Link("/shared/base", src); err != nil {
					report(fmt.Errorf("worker %d Link: %w", i, err))
					return
				}
				if err := fs.Rename(src, dst); err != nil {
					report(fmt.Errorf("worker %d Rename link to b: %w", i, err))
					return
				}
				if err := fs.Rename(dst, src); err != nil {
					report(fmt.Errorf("worker %d Rename link back: %w", i, err))
					return
				}
				if err := fs.Remove(src); err != nil {
					report(fmt.Errorf("worker %d Remove link: %w", i, err))
					return
				}

				if n%2 == 0 {
					if err := fs.Rename(treeA, treeB); err != nil {
						report(fmt.Errorf("worker %d Rename tree out: %w", i, err))
						return
					}
				} else {
					if err := fs.Rename(treeB, treeA); err != nil {
						report(fmt.Errorf("worker %d Rename tree back: %w", i, err))
						return
					}
				}
				if n%37 == 0 {
					runtime.Gosched()
				}
			}
		}(i)
	}

	// Move a whole subtree back and forth while its file also has a hard link
	// outside the moved subtree.
	workerWG.Add(1)
	go func() {
		defer workerWG.Done()
		for n := 0; n < 400; n++ {
			if n%2 == 0 {
				if err := fs.Rename("/shared/dir", "/shared/dir2"); err != nil {
					report(fmt.Errorf("shared Rename out: %w", err))
					return
				}
			} else {
				if err := fs.Rename("/shared/dir2", "/shared/dir"); err != nil {
					report(fmt.Errorf("shared Rename back: %w", err))
					return
				}
			}
		}
	}()

	// Create, hard-link, and recursively delete scratch subtrees concurrently.
	workerWG.Add(1)
	go func() {
		defer workerWG.Done()
		for n := 0; n < 250; n++ {
			scratch := fmt.Sprintf("/shared/scratch-%d", n)
			if err := fs.Mkdir(scratch); err != nil {
				report(fmt.Errorf("scratch Mkdir: %w", err))
				return
			}
			if err := fs.CreateFile(scratch+"/f", int64(n+1)); err != nil {
				report(fmt.Errorf("scratch CreateFile: %w", err))
				return
			}
			if err := fs.Link(scratch+"/f", scratch+"/l"); err != nil {
				report(fmt.Errorf("scratch Link: %w", err))
				return
			}
			if err := fs.RemoveAll(scratch); err != nil {
				report(fmt.Errorf("scratch RemoveAll: %w", err))
				return
			}
		}
	}()

	workerWG.Wait()
	close(stop)
	monitorWG.Wait()

	close(errs)
	for err := range errs {
		t.Error(err)
	}
	if t.Failed() {
		return
	}

	checkEveryDirectory(t, fs)
	if got, want := fs.GlobalUsage().Inodes, fs.InodeCount(); got != want {
		t.Fatalf("GlobalUsage inodes = %d, InodeCount = %d", got, want)
	}
}
