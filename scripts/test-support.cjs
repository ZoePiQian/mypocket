"use strict";
// Release checks use this virtual vault exclusively. No financial files are
// read or written on disk. JSON is a valid YAML subset for fixtures.
const codec = { stringifyYaml: value => JSON.stringify(value, null, 2), parseYaml: JSON.parse };
function virtualVault() {
  const files = new Map(), contents = new Map(), listeners = new Map();
  let clock = 1, reads = 0;
  const emit = (event, ...args) => { for (const fn of listeners.get(event) || []) fn(...args); };
  const attach = file => {
    const slash = file.path.lastIndexOf("/"), parentPath = slash < 0 ? "" : file.path.slice(0, slash);
    if (parentPath && parentPath !== file.path) {
      const parent = folder(parentPath); file.parent = parent;
      if (!parent.children.includes(file)) parent.children.push(file);
    }
  };
  const folder = path => {
    if (files.has(path)) return files.get(path);
    const file = { path, name: path.split("/").at(-1), children: [] };
    files.set(path, file); attach(file); return file;
  };
  const add = (path, text) => {
    if (files.has(path)) throw new Error("Path already exists: " + path);
    const file = { path, name: path.split("/").at(-1), extension: path.split(".").at(-1), stat: { mtime: ++clock, size: text.length } };
    files.set(path, file); contents.set(file, text); attach(file); emit("create", file); return file;
  };
  const set = (path, text) => {
    const file = files.get(path); if (!file || !contents.has(file)) throw new Error("File missing: " + path);
    contents.set(file, text); file.stat = { ...file.stat, mtime: ++clock, size: text.length }; emit("modify", file); return file;
  };
  const read = async file => { reads++; if (!contents.has(file)) throw new Error("File missing"); return contents.get(file); };
  const remove = async file => {
    if (files.get(file.path) !== file) throw new Error("File replaced");
    files.delete(file.path); contents.delete(file);
    if (file.parent) file.parent.children = file.parent.children.filter(child => child !== file);
    emit("delete", file);
  };
  const rename = async (file, target) => {
    if (files.has(target)) throw new Error("Target exists");
    const old = file.path; files.delete(old);
    if (file.parent) file.parent.children = file.parent.children.filter(child => child !== file);
    file.path = target; file.name = target.split("/").at(-1); file.extension = target.split(".").at(-1);
    files.set(target, file); attach(file); emit("rename", file, old);
  };
  const vault = {
    getAbstractFileByPath: path => files.get(path) || null,
    getMarkdownFiles: () => [...files.values()].filter(file => file.extension === "md"),
    read, cachedRead: read,
    create: async (path, text) => add(path, text), createFolder: async path => folder(path),
    modify: async (file, text) => set(file.path, text),
    process: async (file, transform) => { const next = transform(await read(file)); set(file.path, next); return next; },
    delete: remove, trash: remove, rename,
    on: (name, fn) => { const handlers = listeners.get(name) || []; handlers.push(fn); listeners.set(name, handlers); return { name, fn }; }
  };
  const fileManager = { renameFile: rename, processFrontMatter: async (file, update) => {
    const text = await read(file), match = /^---\n([\s\S]*?)\n---(?:\n|$)/.exec(text);
    if (!match) throw new Error("Missing frontmatter");
    const fm = codec.parseYaml(match[1]); update(fm);
    set(file.path, `---\n${codec.stringifyYaml(fm)}\n---\n` + text.slice(match[0].length));
  } };
  return { app: { vault, fileManager }, codec, files, add, set, folder,
    text: path => contents.get(files.get(path)),
    snapshot: () => [...contents].map(([file, text]) => [file.path, text]).sort(([a], [b]) => a.localeCompare(b)),
    get reads() { return reads; }, resetReads() { reads = 0; } };
}
module.exports = { codec, virtualVault };
