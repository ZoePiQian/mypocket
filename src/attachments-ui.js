"use strict";
const { Modal, Notice } = require("obsidian");
const core = require("./core");
const { normalizePaths, MAX_ATTACHMENTS, MAX_BYTES } = require("./attachments");
const { adaptModal } = require("./mobile");
const { decorate } = require("./icons");

function el(parent, tag, cls = "", text = "") {
  const node = parent.ownerDocument.createElement(tag); node.className = cls; node.textContent = text; parent.appendChild(node); return node;
}
function button(parent, text, action, cls = "") {
  const node = el(parent, "button", `lfn-button ${cls}`, text); node.type = "button";
  node.addEventListener("click", async () => { node.disabled = true; try { await action(); } catch (error) { new Notice(error.message); } finally { node.disabled = false; } });
  return node;
}
function fileName(path) { return (path.split("/").at(-1) || "凭证").replace(/-[a-f0-9]{32}(?=\.[^.]+$)/i, ""); }
function imageFile(name) { return /\.(png|jpe?g|webp|gif)$/i.test(name); }
function existingFile(plugin, path) {
  const file = plugin.app.vault.getAbstractFileByPath(path);
  return file && typeof file.extension === "string" ? file : null;
}
class ReceiptViewer extends Modal {
  constructor(plugin, items, record = null) { super(plugin.app); this.plugin = plugin; this.items = items; this.record = record; }
  onOpen() {
    this.modalEl.classList.add("lfn-receipt-modal"); this.contentEl.classList.add("lfn-modal");
    el(this.contentEl, "h2", "", "账目凭证");
    if (this.record) el(this.contentEl, "p", "lfn-help", `${this.record.date} · ${this.record.category}${this.record.memo ? ` · ${this.record.memo}` : ""}`);
    const list = el(this.contentEl, "div", "lfn-receipt-gallery");
    for (const item of this.items) {
      const card = el(list, "section", "lfn-receipt-card"), name = item.file?.name || fileName(item.path || "");
      const file = item.path ? existingFile(this.plugin, item.path) : null;
      const url = item.url || (file ? this.plugin.app.vault.getResourcePath(file) : "");
      const heading = el(card, "div", "lfn-receipt-card-heading"); el(heading, "strong", "", name);
      if (file) button(heading, "打开原文件", async () => { await this.plugin.app.workspace.getLeaf("tab").openFile(file); this.close(); }, "lfn-link-button");
      if (url && imageFile(name)) { const img = el(card, "img", "lfn-receipt-image"); img.alt = name; img.src = url; img.loading = "lazy"; }
      else el(card, "p", "lfn-help", item.file ? "PDF 凭证将在记账保存后提供打开入口。" : file ? "PDF 凭证，点「打开原文件」阅读。" : "凭证文件尚未同步或已被移动，请先检查文件同步。账目本身仍然保留。");
      if (item.path) el(card, "p", "lfn-help lfn-receipt-path", item.path);
    }
    const footer = el(this.contentEl, "div", "lfn-modal-actions"); button(footer, "完成", () => this.close());
    this.cleanup = adaptModal(this);
  }
  onClose() { this.cleanup?.(); this.contentEl.replaceChildren(); }
}
function receiptButton(parent, record, plugin) {
  const paths = normalizePaths(record.attachments || []); if (!paths.length) return null;
  return decorate(button(parent, `凭证 ${paths.length}`, () => new ReceiptViewer(plugin, paths.map(path => ({ path })), record).open(), "lfn-link-button lfn-receipt-link"), "attachment");
}

// Files stay in browser memory until the form explicitly saves a financial record.
function createReceiptEditor(parent, plugin, { record = null, dateInput, root = plugin.store.folder() } = {}) {
  const section = el(parent, "section", "lfn-receipt-editor"), heading = el(section, "div", "lfn-receipt-heading");
  const label = el(heading, "span", "lfn-field-label", "凭证");
  const picker = el(section, "input", "lfn-receipt-picker"); picker.type = "file"; picker.multiple = true;
  picker.accept = ".png,.jpg,.jpeg,.webp,.gif,.pdf"; picker.hidden = true; picker.setAttribute("aria-label", "选择凭证图片或 PDF");
  let items = normalizePaths(record?.attachments || []).map(path => ({ path })), busy = false, destroyed = false;
  const add = decorate(button(heading, "添加凭证", () => picker.click(), "lfn-link-button"), "attachment");
  add.title = `图片或 PDF · 每份最多 ${MAX_BYTES / 1024 / 1024} MB · 最多 ${MAX_ATTACHMENTS} 份`;
  const list = el(section, "div", "lfn-receipt-items"), message = el(section, "p", "lfn-help lfn-receipt-hint", `图片或 PDF · 每份最多 ${MAX_BYTES / 1024 / 1024} MB · 最多 ${MAX_ATTACHMENTS} 份`);
  const error = el(section, "p", "lfn-error"); error.setAttribute("role", "alert");
  const win = parent.ownerDocument.defaultView;
  const revoke = item => { if (item.url) { win.URL.revokeObjectURL(item.url); item.url = ""; } };
  function draw() {
    if (destroyed) return;
    label.textContent = `凭证${items.length ? ` · ${items.length} 份` : ""}`;
    section.classList.toggle("is-empty", items.length === 0);
    list.hidden = items.length === 0; message.hidden = items.length === 0;
    add.disabled = busy || items.length >= MAX_ATTACHMENTS; list.replaceChildren();
    for (const item of items) {
      const row = el(list, "div", "lfn-receipt-item"), name = item.file?.name || fileName(item.path);
      const preview = button(row, name, () => new ReceiptViewer(plugin, [item], record).open(), "lfn-link-button lfn-receipt-name"); preview.title = name;
      el(row, "span", "lfn-help", item.retained ? "已保留，待关联" : item.file ? "待保存" : existingFile(plugin, item.path) ? "已关联" : "待同步");
      const remove = button(row, "移除", () => { revoke(item); items = items.filter(other => other !== item); draw(); }, "lfn-link-button"); remove.disabled = busy;
      remove.setAttribute("aria-label", `移除凭证关联：${name}`);
    }
    message.textContent = items.some(item => item.retained) ? "未保存成功的凭证已保留；再次保存会复用原文件。移除只解除关联，原文件会保留。"
      : items.some(item => item.path) ? "移除只解除这笔账的关联，原文件会保留，方便历史记录恢复。" : `图片或 PDF · 每份最多 ${MAX_BYTES / 1024 / 1024} MB · 最多 ${MAX_ATTACHMENTS} 份`;
  }
  picker.addEventListener("change", () => {
    const files = [...picker.files]; picker.value = ""; error.textContent = ""; if (busy || destroyed) return;
    try {
      if (items.length + files.length > MAX_ATTACHMENTS) throw new Error(`每笔账最多添加 ${MAX_ATTACHMENTS} 份凭证`);
      for (const file of files) {
        if (!/\.(png|jpe?g|webp|gif|pdf)$/i.test(file.name)) throw new Error("请选择 PNG、JPG、WebP、GIF 图片或 PDF 文件");
        if (!file.size || file.size > MAX_BYTES) throw new Error(`${file.name} 须为非空文件，且不能超过 ${MAX_BYTES / 1024 / 1024} MB`);
      }
      for (const file of files) items.push({ file, url: imageFile(file.name) ? win.URL.createObjectURL(file) : "" });
      draw();
    } catch (e) { error.textContent = e.message; }
  });
  draw();
  return {
    async commit() {
      if (busy || destroyed) throw new Error("凭证正在保存或窗口已关闭，请稍后重试");
      if (plugin.store.folder() !== root) throw new Error("数据目录已改变，请重新打开记账窗口");
      const date = dateInput?.value || record?.date || core.today(); if (!core.validDate(date)) throw new Error("请先填写有效的记账日期");
      busy = true; draw(); const imported = [], selected = [...items]; let settled = false;
      const rollback = async () => {
        if (settled) return; settled = true;
        const retained = new Set(selected.filter(item => item.retained).map(item => item.path));
        for (const entry of imported.slice().reverse()) {
          let result = entry.retained;
          try { result ||= await plugin.store.removeImportedReceipt(entry.handle, root); }
          catch (_) { result = { removed: false, path: entry.handle.path, reusable: false }; }
          finally { plugin.store.releaseImportedReceipt?.(entry.handle); }
          if (!result.removed) {
            retained.add(result.path || entry.handle.path);
            if (result.reusable) {
              entry.item.path = result.path; entry.item.retained = true;
              revoke(entry.item); delete entry.item.file;
            }
          }
        }
        busy = false; draw();
        if (retained.size) new Notice(`账目未保存成功，以下凭证文件已保留，请核对后整理：\n${[...retained].join("\n")}`, 12000);
      };
      try {
        const attachments = [];
        for (const item of selected) {
          if (destroyed || plugin.store.folder() !== root) throw new Error("窗口或数据目录已改变，本次未保存账目");
          if (item.path) attachments.push(item.path);
          else {
            const data = await item.file.arrayBuffer();
            if (destroyed || plugin.store.folder() !== root) throw new Error("窗口或数据目录已改变，本次未保存账目");
            let handle;
            try { handle = await plugin.store.importReceipt({ name: item.file.name, data }, date, root); }
            catch (e) { if (e.importedReceipt) imported.push({ handle: e.importedReceipt, item, retained: e.retainedReceipt }); throw e; }
            imported.push({ handle, item }); attachments.push(handle.path);
          }
        }
        if (destroyed || plugin.store.folder() !== root) throw new Error("窗口或数据目录已改变，本次未保存账目");
        return { attachments,
          rollback,
          finish() { if (settled) return; settled = true; for (const entry of imported) { plugin.store.releaseImportedReceipt?.(entry.handle); entry.item.path = entry.handle.path; revoke(entry.item); delete entry.item.file; } for (const item of selected) delete item.retained; busy = false; draw(); }
        };
      } catch (e) { await rollback(); throw e; }
    },
    destroy() { destroyed = true; for (const item of items) revoke(item); section.remove(); }
  };
}
module.exports = { createReceiptEditor, receiptButton, ReceiptViewer };
