"use strict";
const { normalizeFolder } = require("./core");

// Start at the configured folder, never at the vault root. TFolder.children
// includes files and folders, so a folder named *.md must still be traversed.
function markdownFilesIn(vault, path, { recursive = true, excludeFolders = [] } = {}) {
  const root = normalizeFolder(path), directory = vault.getAbstractFileByPath(root);
  if (!directory || !Array.isArray(directory.children)) return [];
  const excluded = new Set(excludeFolders), files = [], pending = [directory], seen = new Set();
  while (pending.length) {
    const folder = pending.pop();
    if (seen.has(folder.path) || excluded.has(folder.path)) continue;
    seen.add(folder.path);
    for (const child of folder.children) {
      if (!child.path.startsWith(folder.path + "/") || child.path.slice(folder.path.length + 1).includes("/")) continue;
      if (Array.isArray(child.children)) {
        if (recursive && !excluded.has(child.path)) pending.push(child);
      } else if (child.extension === "md") files.push(child);
    }
  }
  return files;
}

module.exports = { markdownFilesIn };
