"use strict";
const core = require("./core"), attachments = require("./attachments");
const { createId } = require("./identity");

function registrations(store) { return store.importedReceipts ||= new Map(); }
function fileStamp(file) { return JSON.stringify([file.stat?.mtime, file.stat?.size]); }
function registration(store, handle, expectedRoot) {
  const item = registrations(store).get(handle?.token);
  if (!item || item.path !== handle.path || item.root !== expectedRoot) throw new Error("只能清理本次尚未保存的新凭证");
  return item;
}
async function rollback(store, handle, expectedRoot) {
  const item = registration(store, handle, expectedRoot);
  // Other notes may reference this file. Keep it without scanning the vault,
  // and consume the temporary handle even if the configured folder changed.
  if (!item.path.startsWith(`${item.root}/凭证/`)) throw new Error("凭证不属于本次导入目录");
  registrations(store).delete(handle.token);
  const current = store.app.vault.getAbstractFileByPath(item.file.path);
  if (!current) return { removed: true, path: item.file.path, reason: "凭证文件已被移走或删除" };
  return { removed: false, path: item.file.path,
    reusable: current === item.file && item.file.path === item.path && fileStamp(item.file) === item.stamp,
    reason: "凭证文件已保留，请核对后整理" };
}
module.exports = {
  async importReceipt(value, date, expectedRoot) {
    const { extension, bytes } = attachments.validateUpload(value), copy = new Uint8Array(bytes);
    if (!core.validDate(date)) throw new Error("请先填写有效的记账日期");
    return this.queue(async () => {
      const root = this.assertScope(expectedRoot), folder = `${root}/凭证/${date.slice(0, 4)}/${date.slice(5, 7)}`;
      if (typeof this.app.vault.createBinary !== "function") throw new Error("当前 Obsidian 不支持本地凭证，请更新应用后重试");
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
      registrations(this).set(handle.token, { path, file, root, stamp: fileStamp(file) });
      try { this.assertScope(root, path); }
      catch (error) {
        error.importedReceipt = handle;
        let retained;
        try { retained = await rollback(this, handle, root); }
        catch (_) {
          registrations(this).delete(handle.token);
          retained = { removed: false, path: file.path, reusable: false };
        }
        error.retainedReceipt = retained;
        error.message += `；凭证${retained.removed ? "已被移走或删除" : "已保留"}：${retained.path}`;
        throw error;
      }
      return handle;
    });
  },
  removeImportedReceipt(handle, expectedRoot) {
    // Only settles an in-memory registration; do not bind this to the new
    // data directory or leave tokens behind when the user switches folders.
    return rollback(this, handle, core.normalizeFolder(expectedRoot));
  },
  releaseImportedReceipt(handle) {
    const item = registrations(this).get(handle?.token);
    if (item?.path === handle.path) registrations(this).delete(handle.token);
  }
};
