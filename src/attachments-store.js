"use strict";
const core = require("./core"), attachments = require("./attachments"), table = require("./monthly");
const { createId } = require("./identity");

function registrations(store) { return store.importedReceipts ||= new Map(); }
function fileStamp(file) { return JSON.stringify([file.stat?.mtime, file.stat?.size]); }
function registration(store, handle, expectedRoot) {
  const item = registrations(store).get(handle?.token);
  if (!item || item.path !== handle.path || item.root !== expectedRoot) throw new Error("只能清理本次尚未保存的新凭证");
  return item;
}
async function rollback(store, handle, expectedRoot) {
  const item = registration(store, handle, expectedRoot), vault = store.app.vault;
  const retain = reason => { registrations(store).delete(handle.token); return { removed: false, reason }; };
  // Rollback is tied to the imported object, not the currently selected data
  // directory. A folder change must still allow removal of our own new upload.
  if (!item.path.startsWith(`${item.root}/凭证/`)) throw new Error("凭证不属于本次导入目录");
  const file = vault.getAbstractFileByPath(item.path);
  if (!file) { registrations(store).delete(handle.token); return { removed: true }; }
  if (file !== item.file || file.path !== item.path || fileStamp(file) !== item.stamp) return retain("凭证文件已改变，已保留");
  for (const note of vault.getMarkdownFiles()) {
    const text = await vault.read(note);
    if (text.includes(item.path) || table.decode(text).includes(item.path)) {
      return retain("凭证已被笔记引用，已保留");
    }
  }
  const bytes = attachments.bytesOf(await vault.readBinary(file));
  if (bytes.length !== item.bytes.length || bytes.some((value, index) => value !== item.bytes[index])) return retain("凭证内容已改变，已保留");
  if (vault.getAbstractFileByPath(item.path) !== file || file.path !== item.path || fileStamp(file) !== item.stamp) return retain("凭证文件已改变，已保留");
  await vault.delete(file);
  registrations(store).delete(handle.token);
  return { removed: true };
}
module.exports = {
  async importReceipt(value, date, expectedRoot) {
    const { extension, bytes } = attachments.validateUpload(value), copy = new Uint8Array(bytes);
    if (!core.validDate(date)) throw new Error("请先填写有效的记账日期");
    return this.queue(async () => {
      const root = this.assertScope(expectedRoot), folder = `${root}/凭证/${date.slice(0, 4)}/${date.slice(5, 7)}`;
      if (typeof this.app.vault.createBinary !== "function" || typeof this.app.vault.readBinary !== "function") throw new Error("当前 Obsidian 不支持本地凭证，请更新应用后重试");
      await this.ensureFolder(folder);
      const original = value.name.split(/[\\/]/).at(-1).replace(/\.[^.]*$/, "");
      const basename = core.safeName(original).replace(/[%]/g, "-").replace(/^\.+/, "").trim() || "凭证";
      let path;
      for (let attempt = 0; attempt < 5; attempt++) {
        path = `${folder}/${basename}-${createId().replace(/-/g, "")}.${extension}`;
        attachments.normalizePath(path);
        if (!this.app.vault.getAbstractFileByPath(path)) break;
        path = null;
      }
      if (!path) throw new Error("凭证文件名生成失败，请重试");
      this.assertScope(root, path);
      const file = await this.app.vault.createBinary(path, copy.buffer);
      const handle = { path, token: createId() };
      registrations(this).set(handle.token, { path, file, root, bytes: copy, stamp: fileStamp(file) });
      try { this.assertScope(root, path); }
      catch (error) {
        try { await rollback(this, handle, root); } catch (_) { /* Never remove an altered or linked upload. */ }
        // A caller can retry cleanup only when our attempt failed before it
        // consumed the registration. Successful/retained outcomes are final.
        if (registrations(this).has(handle.token)) error.importedReceipt = handle;
        throw error;
      }
      return handle;
    });
  },
  removeImportedReceipt(handle, expectedRoot) {
    return this.queue(() => rollback(this, handle, core.normalizeFolder(expectedRoot)));
  },
  releaseImportedReceipt(handle) {
    const item = registrations(this).get(handle?.token);
    if (item?.path === handle.path) registrations(this).delete(handle.token);
  }
};
