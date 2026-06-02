package documents

import (
	"os"
	"path/filepath"
	"sort"
	"strings"
)

func readDirectoryTree(path string) (*DirectoryTree, error) {
	resolvedPath, err := resolveFilePath(path)
	if err != nil {
		return nil, err
	}

	info, err := os.Stat(resolvedPath)
	if err != nil {
		return nil, err
	}

	if !info.IsDir() {
		return nil, &os.PathError{Op: "read directory", Path: resolvedPath, Err: os.ErrInvalid}
	}

	children, err := readDirectoryChildren(resolvedPath, 0)
	if err != nil {
		return nil, err
	}

	return &DirectoryTree{
		Path:     resolvedPath,
		Name:     filepath.Base(resolvedPath),
		Children: children,
	}, nil
}

func readDirectoryChildren(path string, depth int) ([]*DirectoryTreeItem, error) {
	if depth >= 8 {
		return nil, nil
	}

	entries, err := os.ReadDir(path)
	if err != nil {
		return nil, err
	}

	items := make([]*DirectoryTreeItem, 0, len(entries))
	for _, entry := range entries {
		name := entry.Name()
		if shouldHideDirectoryEntry(name, entry.IsDir()) {
			continue
		}

		childPath := filepath.Join(path, name)
		item := &DirectoryTreeItem{
			Path:  childPath,
			Name:  name,
			IsDir: entry.IsDir(),
		}

		if entry.IsDir() {
			children, err := readDirectoryChildren(childPath, depth+1)
			if err != nil {
				continue
			}
			item.Children = children
		}

		items = append(items, item)
	}

	sort.SliceStable(items, func(i, j int) bool {
		if items[i].IsDir != items[j].IsDir {
			return items[i].IsDir
		}

		return strings.ToLower(items[i].Name) < strings.ToLower(items[j].Name)
	})

	return items, nil
}

func shouldHideDirectoryEntry(name string, isDir bool) bool {
	if strings.HasPrefix(name, ".") {
		return true
	}

	if !isDir {
		return false
	}

	switch strings.ToLower(name) {
	case "node_modules", "dist", "build", "bin":
		return true
	default:
		return false
	}
}
