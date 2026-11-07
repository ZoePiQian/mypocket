"use strict";
const { Notice } = require("obsidian");
const core = require("./core");

function createRecoveryUI({ PocketModal, el, button, empty, noteButton }) {
  function detail(parent, item) {
    const r = item.record, box = el(parent, "div", "lfn-recovery-detail");
    el(box, "strong", "", `${r.date} · ${core.TYPES[r.kind]} · ${core.money(r.amountCents, r.currency)}`);
    el(box, "div", "lfn-help", `分类：${r.category} · 账户：${r.account || "未填写"}`);
    if (r.memo) el(box, "p", "lfn-help", r.memo);
    if (r.fx) el(box, "div", "lfn-help", `汇率：${r.fx.date} · 1 CNY = ${r.fx.rates.USD} USD / ${r.fx.rates.JPY} JPY`);
    el(box, "div", "lfn-help lfn-recovery-path", `位置：${item.path}`);
    if (item.projectName) el(box, "div", "lfn-help", `专项：${item.projectName}`);
    return box;
  }
  class RecoveryConfirmModal extends PocketModal {
    constructor(plugin, item, group, afterSave) { super(plugin.app); this.plugin = plugin; this.item = item; this.group = group; this.afterSave = afterSave; }
    onOpen() {
      const p = this.plugin, item = this.item;
      this.contentEl.classList.add("lfn-modal", "lfn-recovery");
      el(this.contentEl, "h2", "", this.group ? "确认保留这个版本" : "恢复这条记录");
      detail(this.contentEl, item);
      el(this.contentEl, "p", "lfn-callout", this.group ? `保留上方版本，其余 ${this.group.items.length - 1} 条副本移至回收站。日期、金额和 ID 不合并、不改写；请核对备注及所在账本。` : `恢复到：${item.destination || (item.projectId ? "原专项" : item.record.date.slice(0, 7) + " 日常流水")}。保留原 ID、实际金额、原币与备注；已有同 ID 的有效记录时会停止，避免重复记账。`);
      const error = el(this.contentEl, "p", "lfn-error"); error.setAttribute("role", "alert");
      const actions = el(this.contentEl, "div", "lfn-modal-actions"); button(actions, "取消", () => this.close());
      const confirm = button(actions, this.group ? "确认保留，其他移至回收站" : "确认恢复", async () => {
        error.textContent = "";
        this.assertDataRoot();
        let result;
        try { result = this.group ? await p.store.resolveDuplicate(this.group, item) : await p.store.restoreRecovery(item); }
        catch (e) { error.textContent = e.message; return; }
        confirm.hidden = true;
        const failed = [];
        for (const month of result.months || []) {
          try { if (p.store.periodFile("月报", month)) await p.report(month); }
          catch (e) { failed.push(`${month}：${e.message}`); }
        }
        p.invalidate();
        try { await this.afterSave?.(); } catch (_) { /* A refreshed list is optional after the successful write. */ }
        if (failed.length) { error.textContent = `记录已处理，已有月报待更新：${failed.join("；")}`; return; }
        this.close(); new Notice(this.group ? "已保留所选记录，其他副本已移至回收站" : "记录已恢复，统计已刷新");
      }, "lfn-primary", p);
    }
    onClose() { this.contentEl.replaceChildren(); }
  }
  class DataRecoveryModal extends PocketModal {
    constructor(plugin) { super(plugin.app); this.plugin = plugin; this.tab = "trash"; this.generation = 0; }
    onOpen() { this.closed = false; this.plugin.run(() => this.draw()); }
    onClose() { this.closed = true; this.generation++; this.contentEl.replaceChildren(); }
    async draw() {
      const token = ++this.generation, p = this.plugin;
      this.assertDataRoot();
      const result = this.tab === "trash" ? await p.store.listRecovery() : await p.store.listDuplicates();
      if (this.closed || token !== this.generation) return;
      this.contentEl.replaceChildren(); this.contentEl.classList.add("lfn-modal", "lfn-recovery");
      el(this.contentEl, "h2", "", "数据恢复");
      el(this.contentEl, "p", "lfn-help", "恢复日常或专项的已删除流水，或核对同步产生的重复记录。确认前显示实际金额与保存位置。");
      const tabs = el(this.contentEl, "div", "lfn-segments"); tabs.setAttribute("role", "group"); tabs.setAttribute("aria-label", "数据恢复方式");
      for (const [key, label] of [["trash", "回收站"], ["duplicates", "重复记录"]]) {
        const choice = button(tabs, label, () => { this.tab = key; return this.draw(); }, this.tab === key ? "lfn-primary" : "", p); choice.setAttribute("aria-pressed", String(this.tab === key));
      }
      if (result.warnings?.length) {
        const warnings = el(this.contentEl, "details", "lfn-warning"); el(warnings, "summary", "", `${result.warnings.length} 项需要检查`);
        for (const w of result.warnings) el(warnings, "p", "lfn-help", typeof w === "string" ? w : `${w.path || ""} ${w.message}`);
      }
      if (this.tab === "trash") {
        el(this.contentEl, "p", "lfn-help", "此处恢复流水行；整篇删除的理财笔记请在 Obsidian 的本地回收站恢复。");
        const list = el(this.contentEl, "div", "lfn-recovery-list"), items = result.items || [];
        if (!items.length) empty(list, "没有可恢复的流水", "删除的日常与专项记录会显示在这里。");
        for (const item of items) {
          const row = el(list, "section", "lfn-recovery-item"); detail(row, item);
          const actions = el(row, "div", "lfn-actions");
          noteButton(actions, item.path, p, "查看回收站笔记");
          button(actions, "预览恢复", () => new RecoveryConfirmModal(p, item, null, () => this.draw()).open());
        }
      } else {
        const groups = result.groups || [];
        if (!groups.length) empty(this.contentEl, "没有重复的流水 ID", "不会根据相同金额或备注自动删除记录。");
        for (const group of groups) {
          const section = el(this.contentEl, "section", "lfn-recovery-group");
          el(section, "h3", "", `同一记录的 ${group.items.length} 个版本`);
          el(section, "p", "lfn-help", "仅在确认这些版本属于同一笔交易时选择保留，其余版本移至回收站。如果其实是不同交易，请先在笔记中为它们设置不同 ID，不要使用此操作。");
          for (const item of group.items) {
            const row = el(section, "div", "lfn-recovery-item"); detail(row, item);
            const actions = el(row, "div", "lfn-actions"); noteButton(actions, item.path, p);
            button(actions, "保留此版本…", () => new RecoveryConfirmModal(p, item, group, () => this.draw()).open());
          }
        }
      }
      const footer = el(this.contentEl, "div", "lfn-modal-actions"); button(footer, "刷新", () => this.draw(), "", p); button(footer, "完成", () => this.close());
    }
  }
  return { DataRecoveryModal };
}
module.exports = { createRecoveryUI };
