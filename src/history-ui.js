"use strict";
const { ItemView } = require("obsidian");
const core = require("./core"), currency = require("./currency"), history = require("./history");
const { brand, decorate } = require("./icons");
const { isTouchDevice } = require("./mobile");
const { captureViewState, restoreViewState } = require("./view-state");
const HISTORY_VIEW_TYPE = "local-finance-notes-history";
function el(parent, tag, cls = "", text = "") {
  const node = parent.ownerDocument.createElement(tag); node.className = cls; node.textContent = text; parent.appendChild(node); return node;
}
function button(parent, text, action, plugin, cls = "") {
  const node = el(parent, "button", `lfn-button ${cls}`, text); node.type = "button";
  node.addEventListener("click", () => plugin.run(action)); return node;
}
function field(parent, label, name, tag, value, choices = []) {
  const wrap = el(parent, "label", "lfn-field"); el(wrap, "span", "lfn-field-label", label);
  const control = el(wrap, tag); control.name = name;
  if (tag === "select") for (const [key, title] of choices) { const option = el(control, "option", "", title); option.value = key; }
  control.value = value; return control;
}
class HistoryView extends ItemView {
  constructor(leaf, plugin) {
    super(leaf); this.plugin = plugin; this.filters = history.normalizeFilters(); this.generation = 0; this.limit = 10; this.closed = false;
  }
  getViewType() { return HISTORY_VIEW_TYPE; }
  getDisplayText() { return "跨月查账"; }
  getIcon() { return "search"; }
  getState() { return { ...this.filters }; }
  async setState(state, result) {
    this.filters = history.normalizeFilters(state); this.limit = 10;
    await super.setState?.(this.getState(), result);
    if (!this.closed && this.contentEl) await this.render();
  }
  async onOpen() { this.closed = false; await this.render(); }
  async onClose() { this.closed = true; this.generation++; globalThis.clearTimeout(this.searchTimer); this.contentEl.replaceChildren(); }
  changed(patch, debounce = false) {
    this.filters = history.normalizeFilters({ ...this.filters, ...patch }); this.limit = 10; this.generation++;
    this.plugin.app.workspace.requestSaveLayout?.(); globalThis.clearTimeout(this.searchTimer);
    if (debounce) this.searchTimer = globalThis.setTimeout(() => this.plugin.run(() => this.render()), 160);
    else return this.render();
  }
  async render() {
    const generation = ++this.generation, p = this.plugin, folder = p.settings.folder, asOf = core.today(), code = p.reportCurrency();
    if (this.snapshotFolder !== folder) { this.snapshot = null; this.snapshotFolder = folder; }
    const incomeEnabled = core.featureEnabled(p.settings, "income"), projectsEnabled = core.featureEnabled(p.settings, "project");
    if (!projectsEnabled && this.filters.scope !== "daily") this.filters = history.normalizeFilters({ ...this.filters, scope: "daily", projectId: "", category: "" });
    if ((this.filters.scope !== "daily" || !incomeEnabled) && this.filters.type === "income") this.filters.type = "all";
    const filters = { ...this.filters };
    let snapshot = this.snapshot || { projects: [], records: [], projectRecords: [], warnings: [] }, selected = null, error = "";
    try {
      history.resolveRange(filters, asOf);
      snapshot = await p.store.scan();
      if (generation !== this.generation || this.closed || p.settings.folder !== folder) return;
      this.snapshot = snapshot;
      const rawRecords = [...snapshot.records, ...(snapshot.projectRecords || [])];
      const matching = history.selection(rawRecords, filters, { asOf, code, incomeEnabled });
      const prepared = await p.prepare({ ...snapshot, records: matching.list, fixedEntries: [], projects: [] }, asOf.slice(0, 7), code, { allSpending: true });
      selected = history.selection(prepared.records, filters, { asOf, code, incomeEnabled });
      snapshot = { ...snapshot, warnings: prepared.warnings };
    } catch (e) { error = e.message; }
    if (generation !== this.generation || this.closed || p.settings.folder !== folder) return;
    const transient = this.renderedFolder === folder ? captureViewState(this.contentEl) : null;
    this.renderedFolder = folder; this.contentEl.replaceChildren();
    this.contentEl.classList.add("lfn-dashboard", "lfn-history-view"); this.contentEl.classList.toggle("lfn-touch", isTouchDevice(this.contentEl));
    const root = el(this.contentEl, "div", "lfn-shell"), header = el(root, "header", "lfn-header lfn-app-header");
    const identity = el(header, "div", "lfn-brand-identity"); brand(identity);
    const title = el(identity, "div"); el(title, "h1", "", "跨月查账"); el(title, "p", "lfn-subtitle", "选一段时间，看看这一类花了多少。");
    const actions = el(header, "div", "lfn-actions");
    decorate(button(actions, "日常面板", () => p.activateView(), p), "back");
    decorate(button(actions, "刷新", () => { p.store.invalidate(); return this.render(); }, p), "refresh", { iconOnly: true });

    const controls = el(root, "section", "lfn-panel lfn-history-controls"); controls.setAttribute("aria-label", "跨月查询条件");
    const presets = el(controls, "div", "lfn-history-presets lfn-segments"); presets.setAttribute("role", "group"); presets.setAttribute("aria-label", "查询时间范围");
    for (const [key, label] of history.PRESETS) {
      const choice = button(presets, label, () => {
        let range; try { range = history.resolveRange(this.filters, asOf); } catch (_) { range = history.resolveRange({ preset: "6months" }, asOf); }
        return this.changed({ preset: key, ...(key === "custom" ? { start: range.start, end: range.end } : {}) });
      }, p, filters.preset === key ? "lfn-primary" : "");
      choice.name = `history_preset_${key}`;
      choice.setAttribute("aria-pressed", String(filters.preset === key));
    }
    const dates = el(controls, "div", "lfn-history-dates");
    if (filters.preset === "custom") {
      for (const [key, label] of [["start", "开始日期"], ["end", "结束日期"]]) {
        const input = field(dates, label, `history_${key}`, "input", filters[key]); input.type = "date"; input.value = filters[key]; input.min = "1900-01-01"; input.max = "9999-12-31";
        input.addEventListener("change", () => p.run(() => this.changed({ [key]: input.value })));
      }
    }
    if (selected) el(dates, "p", "lfn-help lfn-history-period", `${selected.range.start} — ${selected.range.end}${selected.range.end > asOf ? ` · 实际统计截至 ${asOf}` : ""}`);
    const filtersRow = el(controls, "div", "lfn-filters lfn-history-filters");
    const search = field(filtersRow, "搜索", "history_search", "input", filters.search); search.type = "search"; search.placeholder = "日期、类别、金额或备注";
    search.addEventListener("input", () => this.changed({ search: search.value }, true));
    const scopeChoices = [["daily", "日常流水"]];
    const allProjects = [...(snapshot.projects || [])].sort((a, b) => a.name.localeCompare(b.name, "zh-CN"));
    if (projectsEnabled) {
      scopeChoices.push(["projects", "全部专项"]);
      for (const project of allProjects) scopeChoices.push([`project:${project.id}`, `${project.name}${project.status === "archived" ? "（已归档）" : ""}`]);
      if (filters.scope === "project" && !allProjects.some(project => project.id === filters.projectId)) scopeChoices.push([`project:${filters.projectId}`, "专项已不可用，请重新选择"]);
    }
    const scope = field(filtersRow, "账本范围", "history_scope", "select", filters.scope === "project" ? `project:${filters.projectId}` : filters.scope, scopeChoices);
    scope.addEventListener("change", () => p.run(() => this.changed({ scope: scope.value.startsWith("project:") ? "project" : scope.value, projectId: scope.value.startsWith("project:") ? scope.value.slice(8) : "", category: "", type: this.filters.type === "income" && scope.value !== "daily" ? "all" : this.filters.type })));
    const kinds = [["all", "全部类型"], ["expense", "支出"], ["refund", "退款"]]; if (incomeEnabled && filters.scope === "daily") kinds.push(["income", "收入"]);
    const type = field(filtersRow, "类型", "history_type", "select", filters.type, kinds);
    type.addEventListener("change", () => p.run(() => this.changed({ type: type.value, category: "" })));
    const categories = history.categoryOptions([...snapshot.records, ...(snapshot.projectRecords || [])], filters, { incomeEnabled });
    if (filters.category && !categories.includes(filters.category)) categories.unshift(filters.category);
    const category = field(filtersRow, "消费类型 / 分类", "history_category", "select", filters.category, [["", "全部分类"], ...categories.map(name => [name, name])]);
    category.addEventListener("change", () => p.run(() => this.changed({ category: category.value })));
    el(controls, "p", "lfn-help", filters.scope === "daily" ? "只查询日常流水，不包含专项；最近 6 个月指本月及前 5 个月，截至今天。" : "只查询专项支出与退款，包含已归档专项的历史记录，不计入日常月账单。");
    if (error) { const warning = el(root, "p", "lfn-error", error); warning.setAttribute("role", "alert"); restoreViewState(this.contentEl, transient); return; }
    if (snapshot.warnings?.length) {
      const warning = el(root, "details", "lfn-warning"); el(warning, "summary", "", `${snapshot.warnings.length} 项数据提示`);
      for (const item of snapshot.warnings) el(warning, "p", "lfn-help", `${item.path || ""} ${item.message || item}`);
    }
    const resultPanel = el(root, "section", "lfn-panel lfn-history-results"), resultHead = el(resultPanel, "div", "lfn-section-heading");
    el(resultHead, "h3", "", filters.category ? `「${filters.category}」查询结果` : "查询结果");
    el(resultHead, "span", "lfn-help", `匹配 ${selected.list.length} 笔 · 合计使用全部匹配记录`);
    const summary = el(resultPanel, "div", "lfn-history-summary"); summary.setAttribute("aria-live", "polite"); summary.setAttribute("aria-label", "查询金额汇总");
    const metric = (label, key, hint) => {
      const block = el(summary, "div", "lfn-history-metric"), t = selected.totals;
      el(block, "span", "lfn-help", label);
      const number = el(block, "strong", "lfn-record-summary-value", t.incomplete[key] ? "待补全" : core.displayMoney(t[key], code));
      if (!t.incomplete[key]) number.title = `实际金额 ${currency.money(t[key], code)}`;
      el(block, "span", "lfn-help", hint);
    };
    if (["all", "expense"].includes(filters.type)) metric("支出合计", "grossExpense", "退款前");
    if (["all", "refund"].includes(filters.type)) metric("退款合计", "refund", "单独列出");
    if (filters.type === "all") metric("净支出", "netExpense", "支出 − 退款");
    if (incomeEnabled && filters.scope === "daily" && ["all", "income"].includes(filters.type)) metric("收入合计", "income", "单独统计，不抵扣支出");
    if (filters.type === "expense") el(resultPanel, "p", "lfn-help", "当前只查支出；切换到「全部类型」可查看扣除退款后的净支出。");
    if (selected.totals.missingFx.length) el(resultPanel, "p", "lfn-warning", `${selected.totals.missingFx.length} 笔缺少汇率，相关合计待补全。请在个性化设置中开启多币种，并联网刷新或补充记录汇率。`);
    const list = el(resultPanel, "div", "lfn-record-list");
    const drawList = () => {
      list.replaceChildren();
      if (!selected.list.length) { const empty = el(list, "div", "lfn-empty"); el(empty, "strong", "", "没有符合条件的记录"); el(empty, "p", "lfn-help", "试试其他日期、分类或清空搜索；未来记录尚不计入实际花费。"); return; }
      const visible = selected.list.slice(0, this.limit);
      for (const r of visible) {
        const row = el(list, "div", "lfn-record"), description = el(row, "div", "lfn-record-description");
        el(description, "strong", "lfn-line-title", `${r.date} · ${r.category}`);
        if (r.projectId) el(description, "span", "lfn-help lfn-history-project", allProjects.find(project => project.id === r.projectId)?.name || "专项");
        if (r.memo) el(description, "div", "lfn-help", r.memo);
        const amount = el(row, "strong", `lfn-record-amount ${r.kind === "expense" ? "" : "lfn-positive"}`, `${r.kind === "expense" ? "−" : "+"}${core.displayMoney(r.amountCents, r.currency)}`);
        amount.title = `${core.TYPES[r.kind]} · 实际金额 ${currency.money(r.amountCents, r.currency)}${r.fx ? ` · 汇率日期 ${r.fx.date}` : ""}`;
        const buttons = el(row, "div", "lfn-record-controls");
        button(buttons, "打开笔记", () => p.openPath(r.path), p, "lfn-link-button");
        const original = r.original || r, project = r.projectId ? allProjects.find(item => item.id === r.projectId) : null;
        if (!r.projectId || project?.status === "active") {
          button(buttons, "编辑", () => {
            const ui = require("./ui");
            if (r.projectId) new ui.ProjectRecordModal(p, project.original || project, original, () => this.render()).open();
            else new ui.RecordModal(p, r.kind, original).open();
          }, p);
          button(buttons, "回收站", () => {
            const ui = require("./ui");
            if (r.projectId) new ui.ProjectActionModal(p, original, "trash", () => this.render()).open();
            else new ui.TrashModal(p, original).open();
          }, p, "lfn-subtle-danger");
        }
        require("./attachments-ui").receiptButton(buttons, original, p);
      }
      const footer = el(list, "div", "lfn-record-list-footer"); el(footer, "span", "lfn-help", `已显示 ${visible.length} / ${selected.list.length} 条`);
      if (visible.length < selected.list.length) {
        button(footer, "再显示 10 条", () => { this.limit += 10; drawList(); }, p, "lfn-record-list-toggle");
        button(footer, "显示全部", () => { this.limit = selected.list.length; drawList(); }, p, "lfn-record-list-toggle");
      }
      if (this.limit > 10) button(footer, "收起", () => { this.limit = 10; drawList(); }, p, "lfn-record-list-toggle");
    };
    drawList();
    const footer = el(root, "div", "lfn-help lfn-footer", "汇总保留实际精度，显示时向上取整；查询不会生成新账本或改动记录归属。");
    button(footer, "使用指南", () => p.openGuide(), p, "lfn-link-button");
    restoreViewState(this.contentEl, transient);
  }
}
module.exports = { HISTORY_VIEW_TYPE, HistoryView };
