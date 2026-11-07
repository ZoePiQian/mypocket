"use strict";
const { ItemView, Notice } = require("obsidian");
const core = require("./core"), currency = require("./currency"), projects = require("./projects"), { createId } = require("./identity");
const { createCategoryFilter, renderCategoryChart, renderTrendChart } = require("./chart-ui");
const { mark, applyTheme, renderCover, createCoverEditor } = require("./project-cover");
const { decorate } = require("./icons");
const { captureViewState, restoreViewState } = require("./view-state");
const { createReceiptEditor, receiptButton } = require("./attachments-ui");
const PROJECT_VIEW_TYPE = "local-finance-notes-projects";

function createProjectUI(h) {
  const { PocketModal, el, button, inputField, selectField, suggestField, refreshSuggestions, accountField, currencyControl, heading, stat, empty, noteButton, isTouchDevice, PersonalizationSettingsModal, CalculatorModal, FixedExpensesModal, createTemplatePicker } = h;
  const amount = (s, code) => s.missingFx.length ? "待补全" : core.displayMoney(s.net, code);
  const categoriesInput = input => [...new Set(input.split(/[\r\n,，]+/).map(v => v.trim()).filter(Boolean))];
  async function updateReports(p, months) {
    const failed = [];
    for (const month of months) {
      try { if (p.store.periodFile("月报", month)) await p.report(month); }
      catch (e) { failed.push(`${month}：${e.message}`); }
    }
    return failed;
  }

  class ProjectMetadataModal extends PocketModal {
    constructor(plugin, previous = null, afterSave = null) { super(plugin.app); this.plugin = plugin; this.previous = previous?.original || previous; this.afterSave = afterSave; }
    onOpen() {
      const p = this.plugin, old = this.previous;
      this.contentEl.classList.add("lfn-modal");
      el(this.contentEl, "h2", "", old ? "编辑专项" : "新建专项账本");
      el(this.contentEl, "p", "lfn-help", "一个专项一篇笔记，跨月、跨年持续记录，不计入日常月账单。");
      const form = el(this.contentEl, "form"), grid = el(form, "div", "lfn-form-grid");
      const name = inputField(grid, "专项名称 *", "project_name", old?.name || ""); name.required = true; name.maxLength = 120; name.placeholder = "例如：装修、旅行、健身";
      const cover = createCoverEditor(form, old || {}); form.insertBefore(cover.element, grid);
      name.addEventListener("input", () => cover.setName(name.value));
      const start = inputField(grid, "开始日期（可留空）", "project_start", old?.startDate || "", "date");
      const code = p.settings.multiCurrencyEnabled ? selectField(grid, "预算币种", "project_currency", Object.entries(currency.CURRENCIES), old?.currency || p.reportCurrency()) : { value: old?.currency || "CNY" };
      const budget = inputField(grid, `预算（${currency.CURRENCIES[code.value]}，可留空）`, "project_budget", old?.budgetCents == null ? "" : core.decimal(old.budgetCents)); budget.inputMode = "decimal";
      code.addEventListener?.("change", () => { budget.parentElement.querySelector(".lfn-field-label").textContent = `预算（${currency.CURRENCIES[code.value]}，可留空）`; });
      const status = selectField(grid, "状态", "project_status", [["active", "进行中"], ["archived", "已归档"]], old?.status || "active");
      status.addEventListener("change", () => cover.setStatus(status.value));
      const catWrap = el(form, "label", "lfn-field"); el(catWrap, "span", "lfn-field-label", "专项分类（每行一个，可随记账新增）");
      const cats = el(catWrap, "textarea"); cats.name = "project_categories"; cats.rows = 3; cats.value = (old?.categories || []).join("\n"); cats.placeholder = "材料\n人工\n家具";
      const descWrap = el(form, "label", "lfn-field"); el(descWrap, "span", "lfn-field-label", "说明（可留空）");
      const desc = el(descWrap, "textarea"); desc.name = "project_description"; desc.rows = 2; desc.maxLength = 2000; desc.value = old?.description || "";
      el(form, "p", "lfn-help", "专项名称不能重复，已归档专项也保留名称。笔记以专项名称命名，修改名称时同步重命名文件，并按 Obsidian 的链接设置处理引用。归档后可重新启用。");
      const error = el(form, "div", "lfn-error"); error.setAttribute("role", "alert");
      const actions = el(form, "div", "lfn-modal-actions"); button(actions, "取消", () => this.close());
      const save = el(actions, "button", "lfn-button lfn-primary", old ? "保存设置" : "创建专项"); save.type = "submit";
      form.addEventListener("submit", async event => {
        event.preventDefault(); if (save.disabled) return; save.disabled = true; error.textContent = "";
        try {
          const changed = !old || (old.budgetCents == null ? "" : core.decimal(old.budgetCents)) !== budget.value.trim() || old.currency !== code.value;
          const budgetDate = changed ? core.today() : old.budgetDate;
          let budgetFx = old?.budgetFx || null;
          if (budget.value.trim() && changed) {
            if (p.settings.multiCurrencyEnabled && (code.value !== "CNY" || p.reportCurrency() !== "CNY")) budgetFx = await p.exchange.get(budgetDate);
            else if (code.value !== "CNY" && !budgetFx) throw new Error("请先开启多币种记账以保存外币预算");
            else if (code.value === "CNY") budgetFx = null;
          }
          const id = old?.id || createId();
          this.assertDataRoot();
          await p.store.saveProject({ id, name: name.value, startDate: start.value, status: status.value, budget: budget.value.trim(), currency: code.value, budgetDate, budgetFx, categories: categoriesInput(cats.value), description: desc.value, ...cover.getValue() }, old);
          const saved = (await p.store.loadProject(id)).project;
          this.close(); p.invalidate(); await this.afterSave?.(saved); new Notice("专项已保存到本地笔记");
        } catch (e) { error.textContent = e.message; } finally { save.disabled = false; }
      });
    }
    onClose() { this.contentEl.replaceChildren(); }
  }

  class ProjectCoverModal extends PocketModal {
    constructor(plugin, project, afterSave) { super(plugin.app); this.plugin = plugin; this.project = project.original || project; this.afterSave = afterSave; }
    onOpen() {
      const p = this.plugin, old = this.project;
      this.contentEl.classList.add("lfn-modal");
      el(this.contentEl, "h2", "", "编辑封面");
      el(this.contentEl, "p", "lfn-help", "给这个专项选一个专属标识，让它在卡片和页面里都一眼可认。");
      const form = el(this.contentEl, "form"), cover = createCoverEditor(form, old, { open: true });
      const error = el(form, "div", "lfn-error"); error.setAttribute("role", "alert");
      const actions = el(form, "div", "lfn-modal-actions"); button(actions, "取消", () => this.close());
      const save = el(actions, "button", "lfn-button lfn-primary", "保存封面"); save.type = "submit";
      form.addEventListener("submit", async event => {
        event.preventDefault(); if (save.disabled) return; save.disabled = true; error.textContent = "";
        try {
          this.assertDataRoot();
          await p.store.saveProject({ ...old, budget: old.budgetCents == null ? "" : core.decimal(old.budgetCents), ...cover.getValue() }, old);
          this.close(); p.invalidate(); await this.afterSave?.(); new Notice("专项封面已保存");
        } catch (e) { error.textContent = e.message; } finally { save.disabled = false; }
      });
    }
    onClose() { this.contentEl.replaceChildren(); }
  }

  class ProjectRecordModal extends PocketModal {
    constructor(plugin, project, previous = null, afterSave = null, kind = "expense") { super(plugin.app); this.plugin = plugin; this.project = project; this.previous = previous; this.afterSave = afterSave; this.kind = previous?.kind || kind; }
    open() { if (!core.featureEnabled(this.plugin.settings, "project")) { new Notice("请先开启专项账本"); return; } super.open(); }
    onOpen() {
      const p = this.plugin, old = this.previous;
      this.contentEl.classList.add("lfn-modal");
      applyTheme(this.contentEl, this.project, true);
      el(this.contentEl, "h2", "", `${old ? "编辑" : "记一笔"} · ${this.project.name}`);
      el(this.contentEl, "p", "lfn-callout", "仅保存到本专项，不进入日常月流水。充值按实际付款记录一次，后续使用不重复记费。");
      const form = el(this.contentEl, "form"), templateSlot = !old ? el(form, "div") : null, grid = el(form, "div", "lfn-form-grid");
      const kind = selectField(grid, "类型", "project_record_kind", [["expense", "专项支出"], ["refund", "专项退款"]], this.kind);
      const money = inputField(grid, p.settings.multiCurrencyEnabled ? "金额 *" : `金额（${old?.currency && old.currency !== "CNY" ? currency.CURRENCIES[old.currency] : "元"}）*`, "amount", old ? core.decimal(old.amountCents) : ""); money.required = true;
      const date = inputField(grid, "日期 *", "project_record_date", old?.date || core.today(), "date"); date.required = true;
      const category = suggestField(grid, "专项分类 *", "project_record_category", this.project.categories, old?.category || "", p.app, this.scope); category.input.required = true; category.input.placeholder = "请选择或输入分类";
      button(category.fieldEl, "编辑专项分类", () => new ProjectMetadataModal(p, this.project, saved => { this.project = saved; refreshSuggestions(category.list, saved.categories); }).open(), "lfn-link-button");
      const account = accountField(grid, "付款方式", "project_record_account", p, old?.account ?? p.settings.accounts[0] ?? "", null, this.scope);
      this.suggestions = [category.list, account.list];
      this.currency = currencyControl(grid, form, p, date, money, old?.currency || p.defaultCurrency(), old);
      const wrap = el(form, "label", "lfn-field"); el(wrap, "span", "lfn-field-label", "备注（可留空）");
      const memo = el(wrap, "textarea"); memo.name = "project_record_memo"; memo.maxLength = 2000; memo.rows = 2; memo.value = old?.memo || "";
      if (templateSlot) this.templatePicker = createTemplatePicker(templateSlot, p, this, { fields: { kind, amount: money, category: category.input, account: account.input, currency: this.currency.input, memo }, context: "project", projectId: this.project.id });
      this.receiptEditor = createReceiptEditor(form, p, { record: old, dateInput: date, root: this.dataRoot });
      el(form, "p", "lfn-help", "退款在本专项内抵扣支出；未来日期的金额到当天才计入。合同、图片和课程次数可以补充到专项笔记。");
      const error = el(form, "div", "lfn-error"); error.setAttribute("role", "alert");
      const actions = el(form, "div", "lfn-modal-actions"); button(actions, "取消", () => this.close());
      const save = el(actions, "button", "lfn-button lfn-primary", "保存到专项"); save.type = "submit";
      form.addEventListener("keydown", e => { if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) { e.preventDefault(); form.requestSubmit(); } });
      form.addEventListener("submit", async e => {
        e.preventDefault(); if (save.disabled) return; save.disabled = true; error.textContent = "";
        let receiptCommit = null;
        try {
          if (!core.featureEnabled(p.settings, "project")) throw new Error("专项账本已关闭，请先重新开启");
          const code = this.currency.input.value, fx = await this.currency.resolve(code, date.value);
          this.assertDataRoot();
          const fm = { finance_schema: 1, finance_kind: kind.value, id: old?.id || createId(), date: date.value, currency: code, fx, category: category.input.value.trim(), amount: money.value, account: account.input.value.trim(), memo: memo.value };
          core.validateRecord(fm);
          receiptCommit = await this.receiptEditor.commit(); fm.attachments = receiptCommit.attachments;
          this.assertDataRoot();
          const file = await p.store.saveProjectRecord(this.project.id, fm, old);
          receiptCommit.finish(); receiptCommit = null;
          this.close(); p.invalidate(); await this.afterSave?.(); new Notice("已保存到专项，日常账单不受影响"); if (p.settings.openNoteAfterSave) await p.openPath(file.path);
        } catch (err) { try { await receiptCommit?.rollback(); } catch (cleanup) { err.message += `；凭证清理未完成：${cleanup.message}`; } error.textContent = err.message; } finally { save.disabled = false; }
      });
    }
    onClose() { this.templatePicker?.destroy(); this.receiptEditor?.destroy(); this.currency?.destroy(); this.suggestions?.forEach(s => s.destroy()); this.contentEl.replaceChildren(); }
  }

  class ProjectActionModal extends PocketModal {
    constructor(plugin, record, action, afterSave) { super(plugin.app); this.plugin = plugin; this.record = record; this.action = action; this.afterSave = afterSave; }
    onOpen() {
      const p = this.plugin, r = this.record, moving = this.action === "daily";
      this.contentEl.classList.add("lfn-modal"); el(this.contentEl, "h2", "", moving ? "移到日常流水？" : "移至专项回收站？");
      el(this.contentEl, "p", "", `${r.date} · ${r.category} · ${core.displayMoney(r.amountCents, r.currency)}`);
      el(this.contentEl, "p", "lfn-help", moving ? `这笔记录会从本专项移除，移入 ${r.date.slice(0, 7)} 的日常月流水，计入该月的日常支出或退款，不会重复记账。插件会尝试更新已有月报，并保留手写复盘。` : "仅移出这一行，专项笔记正文保留。删除行存放在「回收站/专项」中，可从笔记恢复。");
      const error = el(this.contentEl, "div", "lfn-error"); error.setAttribute("role", "alert");
      const actions = el(this.contentEl, "div", "lfn-modal-actions"); button(actions, "取消", () => this.close());
      const confirm = button(actions, moving ? "确认移到日常" : "移至回收站", async () => {
        error.textContent = "";
        try {
          this.assertDataRoot();
          const result = moving ? await p.store.moveProjectRecordToDaily(r) : await p.store.trashProjectRecord(r);
          confirm.hidden = true;
          const failed = moving ? await updateReports(p, result.months) : [];
          p.invalidate(); await this.afterSave?.();
          if (failed.length) { error.textContent = `记录已移到日常，以下月报待更新：${failed.join("；")}`; return; }
          this.close(); new Notice(moving ? "记录已移到日常" : "记录已移至专项回收站");
        } catch (e) { error.textContent = e.message; }
      }, moving ? "lfn-primary" : "lfn-danger");
    }
    onClose() { this.contentEl.replaceChildren(); }
  }

  class ProjectMigrationModal extends PocketModal {
    constructor(plugin, project, afterSave = null) { super(plugin.app); this.plugin = plugin; this.project = project; this.afterSave = afterSave; this.selected = new Set(); this.generation = 0; }
    onOpen() { this.closed = false; this.plugin.run(() => this.draw()); }
    onClose() { this.closed = true; this.generation++; this.contentEl.replaceChildren(); }
    async draw() {
      const generation = ++this.generation, p = this.plugin, code = p.reportCurrency();
      const data = await p.prepare(await p.store.scan(), core.today().slice(0, 7), code, { allSpending: true });
      if (this.closed || generation !== this.generation) return;
      this.contentEl.replaceChildren(); this.contentEl.classList.add("lfn-modal", "lfn-project-migration");
      el(this.contentEl, "h2", "", `从日常移入专项 · ${this.project.name}`);
      el(this.contentEl, "p", "lfn-help", "只移动你明确选中的支出或退款，保留日期、金额、备注和 ID。原月笔记的自由正文保留，并在专项中留下来源链接。后续固定付款的归属需在固定支出中另行设置。");
      const records = data.records.filter(r => r.storage === "monthly" && ["expense", "refund"].includes(r.kind));
      const filters = el(this.contentEl, "div", "lfn-filters");
      const months = [...new Set(records.map(r => r.date.slice(0, 7)))].sort().reverse();
      const month = selectField(filters, "月份", "migration_month", [["", "全部月份"], ...months.map(m => [m, m])], "");
      const categories = [...new Set(records.map(r => r.category))].sort((a, b) => a.localeCompare(b, "zh-CN"));
      const category = selectField(filters, "分类", "migration_category", [["", "全部分类"], ...categories.map(c => [c, c])], "");
      const search = inputField(filters, "搜索", "migration_search", "", "search"); search.placeholder = "日期、分类或备注";
      const tools = el(this.contentEl, "div", "lfn-actions"), list = el(this.contentEl, "div", "lfn-migration-list"), status = el(this.contentEl, "p", "lfn-help");
      status.setAttribute("aria-live", "polite"); let filtered = [], showAll = false;
      const refreshStatus = () => {
        const chosen = records.filter(r => this.selected.has(r.id)), s = projects.total(chosen, code);
        status.textContent = `已选 ${chosen.length} 笔 · 支出 ${s.missingFx.length ? "待补全" : core.displayMoney(s.grossExpense, code)} · 退款 ${s.missingFx.length ? "待补全" : core.displayMoney(s.refund, code)} · 净额 ${amount(s, code)}`;
        preview.disabled = !chosen.length;
      };
      const drawList = () => {
        previewArea.hidden = true;
        const needle = search.value.trim().toLocaleLowerCase();
        filtered = records.filter(r => (!month.value || r.date.startsWith(month.value)) && (!category.value || r.category === category.value) && `${r.date} ${r.category} ${r.memo} ${core.decimal(r.amountCents)}`.toLocaleLowerCase().includes(needle));
        list.replaceChildren();
        for (const r of showAll ? filtered : filtered.slice(0, 50)) {
          const choice = button(list, "", () => { if (this.selected.has(r.id)) this.selected.delete(r.id); else this.selected.add(r.id); choice.setAttribute("aria-pressed", String(this.selected.has(r.id))); previewArea.hidden = true; refreshStatus(); }, "lfn-migration-option");
          choice.setAttribute("aria-pressed", String(this.selected.has(r.id))); choice.setAttribute("aria-label", `${r.date} ${r.category} ${core.displayMoney(r.amountCents, r.currency)}`);
          const text = el(choice, "span"); el(text, "strong", "", `${r.date} · ${r.category}`); el(text, "span", "lfn-help", r.memo || core.TYPES[r.kind]);
          el(choice, "strong", "", `${r.kind === "refund" ? "+" : "−"}${core.displayMoney(r.amountCents, r.currency)}`);
        }
        if (!filtered.length) empty(list, "没有符合条件的日常记录", "可切换月份、分类或清空搜索。");
        if (!showAll && filtered.length > 50) button(list, `显示全部 ${filtered.length} 笔`, () => { showAll = true; drawList(); });
        refreshStatus();
      };
      button(tools, "全选当前筛选", () => { for (const r of filtered) this.selected.add(r.id); drawList(); });
      button(tools, "清空选择", () => { this.selected.clear(); drawList(); });
      const error = el(this.contentEl, "div", "lfn-error"); error.setAttribute("role", "alert");
      const previewArea = el(this.contentEl, "div", "lfn-migration-preview"); previewArea.hidden = true;
      const actions = el(this.contentEl, "div", "lfn-modal-actions"); button(actions, "关闭", () => this.close());
      const preview = button(actions, "预览迁移", () => {
        const chosen = records.filter(r => this.selected.has(r.id)); previewArea.hidden = false; previewArea.replaceChildren();
        el(previewArea, "p", "lfn-callout", `即将把 ${chosen.length} 笔记录移入「${this.project.name}」。日常统计将扣除这些记录，原文件的说明文字与手写复盘继续保留。`);
        let updateExistingReports = true;
        const updateWrap = el(previewArea, "div", "lfn-feature-row");
        el(updateWrap, "span", "lfn-help", "同时更新受影响月份的已有月报，保留手写复盘");
        const update = button(updateWrap, "", () => { updateExistingReports = !updateExistingReports; update.setAttribute("aria-checked", String(updateExistingReports)); }, "lfn-feature-switch");
        update.setAttribute("role", "switch"); update.setAttribute("aria-label", "更新已有月报"); update.setAttribute("aria-checked", "true");
        const confirm = button(previewArea, "确认移动所选记录", async () => {
          error.textContent = "";
          try {
            this.assertDataRoot();
            const result = await p.store.moveToProject(this.project.id, chosen.map(r => r.original || r));
            preview.hidden = true; filters.hidden = true; tools.hidden = true; list.hidden = true; status.hidden = true;
            previewArea.replaceChildren(); el(previewArea, "p", "lfn-callout", `已移动 ${result.count} 笔记录，日常与专项统计已更新。`);
            const failed = updateExistingReports ? await updateReports(p, result.months) : [];
            if (failed.length) el(previewArea, "p", "lfn-error", `记录已移动，月报尚待更新：${failed.join("；")}`);
            for (const m of result.months) button(previewArea, `生成 / 更新 ${m} 月报`, async () => { await p.report(m); new Notice(`${m} 月报已更新，手写复盘保留`); }, "lfn-link-button", p);
            p.invalidate(); await this.afterSave?.();
          } catch (e) { error.textContent = e.message; }
        }, "lfn-primary");
        confirm.setAttribute("aria-label", "确认移动所选记录");
      }, "lfn-primary");
      for (const control of [month, category, search]) control.addEventListener(control === search ? "input" : "change", () => { this.selected.clear(); showAll = false; previewArea.hidden = true; drawList(); });
      drawList();
    }
  }

  class ProjectView extends ItemView {
    constructor(leaf, plugin) { super(leaf); this.plugin = plugin; this.projectId = ""; this.month = core.today().slice(0, 7); this.showArchived = false; this.range = "all"; this.chartCategories = null; this.expenseCategory = ""; this.generation = 0; }
    getViewType() { return PROJECT_VIEW_TYPE; }
    getDisplayText() { return "专项账本"; }
    getIcon() { return "folders"; }
    getState() { return { projectId: this.projectId, month: this.month, range: this.range }; }
    async setState(state) { this.projectId = typeof state?.projectId === "string" ? state.projectId : ""; if (core.validMonth(state?.month)) this.month = state.month; this.range = state?.range || "all"; await this.render(); }
    async onOpen() { this.closed = false; await this.render(); }
    async onClose() { this.closed = true; this.generation++; this.chartFilter?.destroy(); }
    async render() {
      const token = ++this.generation, p = this.plugin, code = p.reportCurrency();
      let data;
      try {
        const scan = await p.store.scan();
        data = await p.prepare({ ...scan, records: [...scan.records.filter(r => ["expense", "refund"].includes(r.kind)), ...(scan.projectRecords || [])] }, this.month, code, { allSpending: true });
      } catch (e) {
        if (token !== this.generation || this.closed) return; this.chartFilter?.destroy(); this.contentEl.replaceChildren(); empty(this.contentEl, "专项暂时无法读取", e.message); button(this.contentEl, "重新读取", () => this.render(), "", p); return;
      }
      if (token !== this.generation || this.closed) return;
      const renderKey = p.settings.folder + ":" + this.projectId + ":" + this.month + ":" + this.range;
      const transient = this.renderedKey === renderKey ? captureViewState(this.contentEl) : null;
      if (this.renderedKey !== renderKey) { this.showAll = false; this.trendMonth = core.today().slice(0, 7); }
      this.renderedKey = renderKey;
      this.chartFilter?.destroy(); this.contentEl.replaceChildren(); this.contentEl.classList.add("lfn-dashboard", "lfn-project-dashboard"); this.contentEl.classList.toggle("lfn-touch", isTouchDevice(this.contentEl));
      const root = el(this.contentEl, "div", "lfn-shell");
      if (!core.featureEnabled(p.settings, "project")) { empty(root, "专项账本已隐藏", "笔记与统计数据保留，可在个性化设置中重新开启。"); button(root, "个性化设置", () => new PersonalizationSettingsModal(p).open()); return; }
      const daily = data.records.filter(r => !r.projectId), special = data.records.filter(r => r.projectId);
      const current = data.projects.find(project => project.id === this.projectId);
      const header = el(root, "div", current ? "lfn-project-nav lfn-app-nav" : "lfn-header lfn-app-header");
      if (current) {
        applyTheme(root, current, true);
        decorate(button(header, "全部专项", () => { this.projectId = ""; return this.render(); }, "lfn-link-button lfn-project-back", p), "back");
      } else {
        const title = el(header, "div", "lfn-title"), label = el(title, "div", "lfn-project-library-heading"); mark(label, "folder");
        el(label, "h1", "", "专项账本"); el(title, "p", "lfn-help lfn-tagline", "为一件事，留一本清楚的记录。");
      }
      const dock = el(header, "div", "lfn-action-dock"), actions = el(dock, "div", "lfn-actions lfn-main-actions");
      actions.setAttribute("role", "group"); actions.setAttribute("aria-label", "账本导航");
      decorate(button(actions, "日常面板", () => p.activateView(), "", p), "note");
      const utilities = el(dock, "div", "lfn-actions lfn-utility-actions");
      utilities.setAttribute("role", "group"); utilities.setAttribute("aria-label", "随手工具");
      decorate(button(utilities, "计算器", () => new CalculatorModal(p).open()), "calculator", { iconOnly: true });
      decorate(button(utilities, "备忘录", () => p.openMemo(), "", p), "memo", { iconOnly: true });
      if (current) renderCover(root, current, { onEdit: () => new ProjectCoverModal(p, current, () => this.render()).open() });
      if (data.warnings.length) {
        const warning = el(root, "details", "lfn-warning"); el(warning, "summary", "", `${data.warnings.length} 处数据提示，合计可能不完整`);
        for (const item of data.warnings) { const row = el(warning, "p"); noteButton(row, item.path, p); el(row, "span", "", ` ${item.message}`); }
      }
      if (!current) {
        if (this.projectId) { el(root, "p", "lfn-warning", "该专项已移动、删除或 ID 重复，请检查笔记与数据提示。"); this.projectId = ""; }
        const create = decorate(button(actions, "新建专项", () => new ProjectMetadataModal(p, null, project => { this.projectId = project.id; this.range = "all"; this.chartCategories = null; return this.render(); }).open(), "lfn-primary"), "plus");
        actions.prepend(create);
        const nav = el(root, "div", "lfn-monthbar lfn-dashboard-monthbar");
        const month = inputField(nav, "查看实际花费月份", "project_overview_month", this.month, "month"); month.min = "1900-01"; month.max = "9999-12";
        month.addEventListener("change", () => { if (core.validMonth(month.value)) { this.month = month.value; p.run(() => this.render()); } });
        button(nav, "回到本月", () => { this.month = core.today().slice(0, 7); return this.render(); }, "lfn-month-today", p);
        const stats = el(root, "div", "lfn-stats"); stats.style.setProperty("--lfn-stat-columns", "3");
        const d = projects.total(daily.filter(r => r.date.startsWith(this.month)), code);
        const s = projects.total(special.filter(r => r.date.startsWith(this.month)), code);
        const a = projects.total([...daily, ...special].filter(r => r.date.startsWith(this.month)), code);
        const periodLabel = this.month === core.today().slice(0, 7) ? "本月" : "该月";
        stat(stats, `${periodLabel}日常净支出`, amount(d, code), this.month); stat(stats, `${periodLabel}专项净支出`, amount(s, code), "包含已归档专项在该月的记录"); stat(stats, `${periodLabel}全部实际支出`, amount(a, code), "日常 + 专项，均已扣除退款");
        const bar = el(root, "div", "lfn-section-heading"); el(bar, "h3", "", "我的专项");
        decorate(button(bar, this.showArchived ? "隐藏已归档" : "查看已归档", () => { this.showArchived = !this.showArchived; return this.render(); }, "", p), "archive");
        const cards = el(root, "div", "lfn-project-cards"), visible = data.projects.filter(project => this.showArchived || project.status === "active").sort((a, b) => a.name.localeCompare(b.name, "zh-CN"));
        if (!visible.length) empty(cards, "创建你的第一个专项", "例如装修、旅行或健身。每个专项共用一篇 Markdown 笔记。");
        for (const project of visible) {
          const card = el(cards, "section", "lfn-panel lfn-project-card"), s = projects.total(special.filter(r => r.projectId === project.id), code); applyTheme(card, project);
          const cover = renderCover(card, project, { compact: true }); cover.querySelector("h3").title = project.name;
          const body = el(card, "div", "lfn-project-card-body");
          el(body, "strong", "lfn-project-total", amount(s, code)); el(body, "p", "lfn-help", `${s.count} 笔已计入${s.futureCount ? ` · ${s.futureCount} 笔未来记录未计入` : ""}`);
          if (project.budgetCents !== null) { let budget; try { budget = core.displayMoney(projects.budgetAmount(project, code), code); } catch (_) { budget = "待换算"; } el(body, "p", "lfn-help", `预算 ${budget}`); }
          button(body, "查看专项", () => { this.projectId = project.id; this.range = "all"; this.chartCategories = null; this.search = ""; this.type = "all"; this.expenseCategory = ""; return this.render(); }, "lfn-link-button", p);
        }
        const footer = el(root, "div", "lfn-footer"); button(footer, "使用指南", () => p.openGuide(), "lfn-link-button", p);
        restoreViewState(this.contentEl, transient);
        return;
      }
      const records = special.filter(r => r.projectId === current.id);
      const tools = el(root, "div", "lfn-actions lfn-project-tools");
      if (current.status === "active") {
        decorate(button(tools, "记支出", () => new ProjectRecordModal(p, current, null, () => this.render()).open(), "lfn-primary"), "plus", { description: "记专项支出" });
        decorate(button(tools, "退款", () => new ProjectRecordModal(p, current, null, () => this.render(), "refund").open()), "refund", { description: "记退款" });
        decorate(button(tools, "从日常移入", () => new ProjectMigrationModal(p, current, () => this.render()).open()), "import");
      } else el(root, "p", "lfn-callout", "此专项已归档，历史数据仍参与全部实际花费统计。编辑专项并重新启用后可继续新增记录。");
      decorate(button(tools, "编辑", () => new ProjectMetadataModal(p, current, () => this.render()).open()), "edit", { description: "编辑专项" });
      decorate(noteButton(tools, current.path, p, "专项笔记"), "note", { description: "打开专项笔记" });
      decorate(button(tools, "固定支出", () => new FixedExpensesModal(p, this.month.slice(0, 4), current.id).open()), "repeat");
      if (current.description) el(root, "p", "lfn-help lfn-project-description", current.description);
      const summary = projects.total(records, code), stats = el(root, "div", "lfn-stats"); stats.style.setProperty("--lfn-stat-columns", current.budgetCents === null ? "2" : "3");
      stat(stats, "累计净支出", amount(summary, code), `消费 ${summary.missingFx.length ? "待补全" : core.displayMoney(summary.grossExpense, code)} · 退款 ${summary.missingFx.length ? "待补全" : core.displayMoney(summary.refund, code)}`);
      stat(stats, "已记录", `${summary.count} 笔`, summary.futureCount ? `${summary.futureCount} 笔未来记录到当天计入` : "跨月、跨年持续累计");
      if (current.budgetCents !== null) { let remaining = "待换算", hint = "预算仅作参考，未付款不记支出"; try { const b = projects.budgetAmount(current, code); if (!summary.missingFx.length) remaining = core.displayMoney(b - summary.net, code); hint = `预算 ${core.displayMoney(b, code)} · 按预算保存时的汇率换算`; } catch (_) {} stat(stats, "预算剩余", remaining, hint); }
      const nav = el(root, "div", "lfn-monthbar lfn-dashboard-monthbar"), months = [...new Set([core.today().slice(0, 7), ...records.map(r => r.date.slice(0, 7))])].sort().reverse(), years = [...new Set(months.map(m => m.slice(0, 4)))];
      const ranges = [["all", "整个专项周期"], ...years.map(y => [`year:${y}`, `${y} 年`]), ...months.map(m => [`month:${m}`, m])];
      if (!ranges.some(([key]) => key === this.range)) this.range = "all";
      const range = selectField(nav, "查看范围", "project_range", ranges, this.range); range.addEventListener("change", () => { this.range = range.value; this.showAll = false; p.run(() => this.render()); });
      let from = "", to = ""; if (this.range.startsWith("year:")) { from = this.range.slice(5) + "-01"; to = this.range.slice(5) + "-12"; } else if (this.range.startsWith("month:")) from = to = this.range.slice(6);
      const periodRecords = records.filter(r => (!from || r.date.slice(0, 7) >= from) && (!to || r.date.slice(0, 7) <= to));
      const charts = el(root, "div", "lfn-overview lfn-chart-panels"), catPanel = el(charts, "section", "lfn-panel"), catHead = heading(catPanel, "钱花在哪里"), controls = el(catHead, "div", "lfn-chart-controls"), catBody = el(catPanel, "div"), trendPanel = el(charts, "section", "lfn-panel");
      heading(trendPanel, "支出趋势", "仅本专项 · 按月查看"); const trendBody = el(trendPanel, "div"); let trendMonth = this.trendMonth || core.today().slice(0, 7), drawList = () => {};
      const names = [...new Set(periodRecords.map(r => r.category))].sort((a, b) => a.localeCompare(b, "zh-CN"));
      const drawCharts = () => {
        const s = projects.statistics(records, { from, to, code, selectedCategories: this.chartCategories });
        const isFiltered = this.chartCategories !== null, selectionEmpty = isFiltered && !names.some(n => this.chartCategories.has(n));
        renderCategoryChart(catBody, s.period, s.rangeLabel, code, isFiltered, selectionEmpty);
        renderTrendChart(trendBody, s, trendMonth, code, { filtered: isFiltered, selectionEmpty, onSelect: m => { trendMonth = m; this.trendMonth = m; } }); drawList();
      };
      this.chartFilter = createCategoryFilter(controls, names, this.chartCategories, selection => { this.chartCategories = selection; this.showAll = false; drawCharts(); });
      const panel = el(root, "section", "lfn-panel"); heading(panel, "专项记录", "默认最近 10 条 · 筛选合计使用全部匹配记录");
      const toolbar = el(panel, "div", "lfn-record-toolbar");
      const filters = el(toolbar, "div", "lfn-filters"), search = inputField(filters, "搜索", "project_search", this.search || "", "search"), type = selectField(filters, "类型", "project_type", [["all", "全部"], ["expense", "支出"], ["refund", "退款"]], this.type || "all"); search.placeholder = "日期、分类、金额或备注";
      type.parentElement.classList.add("lfn-type-filter");
      const expenseCategories = [...new Set([...(current.categories || []), ...periodRecords.filter(r => r.kind === "expense").map(r => r.category)])];
      if (!expenseCategories.includes(this.expenseCategory)) this.expenseCategory = "";
      const category = selectField(filters, "消费类型", "project_expense_category", [["", "全部消费类型"], ...expenseCategories.map(name => [name, name])], this.expenseCategory);
      category.parentElement.classList.add("lfn-category-filter"); category.parentElement.hidden = this.type !== "expense";
      const tally = el(toolbar, "aside", "lfn-record-summary"), list = el(panel, "div", "lfn-project-record-list"); tally.setAttribute("aria-label", "筛选汇总"); tally.setAttribute("aria-live", "polite");
      drawList = () => {
        const needle = (this.search || "").trim().toLocaleLowerCase();
        const selectedCategory = this.type === "expense" ? this.expenseCategory : "";
        const filtered = periodRecords.filter(r => (this.chartCategories === null || this.chartCategories.has(r.category)) && (!this.type || this.type === "all" || r.kind === this.type) && (!selectedCategory || r.category === selectedCategory) && `${r.date} ${r.category} ${r.memo} ${core.decimal(r.amountCents)} ${core.displayMoney(r.amountCents, r.currency)}`.toLocaleLowerCase().includes(needle)).sort((a, b) => b.date.localeCompare(a.date) || (b.offset || 0) - (a.offset || 0) || b.id.localeCompare(a.id));
        const s = projects.total(filtered, code), rangeTotals = projects.total(periodRecords, code);
        const value = (total, field) => total.missingFx.some(r => field === "net" || (r.kind === "expense" ? "grossExpense" : r.kind) === field) ? "待补全" : core.displayMoney(total[field], code);
        const field = this.type === "expense" ? "grossExpense" : this.type === "refund" ? "refund" : "net";
        const label = this.type === "expense" ? "支出" : this.type === "refund" ? "退款" : "净支出";
        tally.replaceChildren();
        const primary = el(tally, "div", "lfn-record-summary-main");
        el(primary, "span", "lfn-help", `筛选${label}合计`); el(primary, "strong", "lfn-record-summary-value", value(s, field)); el(primary, "span", "lfn-help lfn-record-summary-count", `${filtered.length} 笔`);
        if (field === "grossExpense") { const note = el(primary, "span", "lfn-help lfn-record-summary-note", "退款前"); note.title = "支出为退款前金额，退款单独计算"; }
        const references = el(tally, "div", "lfn-record-summary-details");
        const reference = (name, total, key) => { const row = el(references, "div", "lfn-record-summary-line"); el(row, "span", "", name); el(row, "strong", "", value(total, key)); };
        if (!this.type || this.type === "all") { reference("支出", s, "grossExpense"); reference("退款", s, "refund"); }
        if (selectedCategory) reference(`范围内「${selectedCategory}」`, projects.total(periodRecords.filter(r => r.kind === "expense" && r.category === selectedCategory), code), "grossExpense");
        reference(`范围内全部${label}`, rangeTotals, field);
        if (this.chartCategories !== null) el(tally, "div", "lfn-help lfn-record-summary-message", "明细已叠加图表类别筛选；范围内合计按上方查看范围统计。");
        if (s.futureCount) el(tally, "div", "lfn-help lfn-record-summary-message", `${s.futureCount} 笔未来记录尚未计入合计`);
        if (s.missingFx.length) el(tally, "div", "lfn-error lfn-record-summary-message", `${s.missingFx.length} 笔缺少汇率，相关合计待补全`);
        list.replaceChildren();
        for (const r of this.showAll ? filtered : filtered.slice(0, 10)) {
          const row = el(list, "div", "lfn-record"), text = el(row, "div", "lfn-record-description"); el(text, "strong", "", `${r.date} · ${r.category}`); if (r.memo) el(text, "div", "lfn-help", r.memo);
          if (r.date > core.today()) el(text, "span", "lfn-chip-static", "未来记录");
          el(row, "strong", "lfn-record-amount", `${r.kind === "refund" ? "+" : "−"}${core.displayMoney(r.amountCents, r.currency)}`);
          const actions = el(row, "div", "lfn-record-controls"), original = r.original || r;
          receiptButton(actions, r, p);
          button(actions, "编辑", () => new ProjectRecordModal(p, current, original, () => this.render()).open());
          const move = button(actions, "移到日常", () => new ProjectActionModal(p, original, "daily", () => this.render()).open()); move.title = "将这笔记录移到对应月份的日常流水，计入日常月度统计";
          button(actions, "回收站", () => new ProjectActionModal(p, original, "trash", () => this.render()).open(), "lfn-subtle-danger");
        }
        if (!filtered.length) empty(list, "没有符合条件的专项记录", "可以记一笔、从日常移入，或调整筛选条件。");
        if (filtered.length > 10) button(list, this.showAll ? "收起" : `显示全部 ${filtered.length} 条`, () => { this.showAll = !this.showAll; drawList(); }, "lfn-record-list-toggle");
      };
      search.addEventListener("input", () => { this.search = search.value; this.showAll = false; drawList(); });
      type.addEventListener("change", () => { this.type = type.value; this.expenseCategory = ""; category.value = ""; category.parentElement.hidden = this.type !== "expense"; this.showAll = false; drawList(); });
      category.addEventListener("change", () => { this.expenseCategory = category.value; this.showAll = false; drawList(); });
      drawCharts();
      const footer = el(root, "div", "lfn-help lfn-footer", "专项花费不会进入日常月报。金额按实际精度统计，界面向上取整；原币金额、汇率和自由正文都保存在本地 Markdown。");
      button(footer, "使用指南", () => p.openGuide(), "lfn-link-button", p);
      restoreViewState(this.contentEl, transient);
    }
  }
  return { PROJECT_VIEW_TYPE, ProjectView, ProjectMetadataModal, ProjectRecordModal, ProjectMigrationModal, ProjectActionModal };
}
module.exports = { createProjectUI };
