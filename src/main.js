"use strict";
const { Plugin, Notice, parseYaml, stringifyYaml, requestUrl } = require("obsidian");
const core = require("./core");
const currency = require("./currency");
const { FinanceStore } = require("./storage");
const { isMonthlyPath } = require("./periods");
const { VIEW_TYPE, PROJECT_VIEW_TYPE, ProjectView, FinanceView, RecordModal, PersonalizationSettingsModal, FixedExpensesModal, CalculatorModal, MemoModal, FinanceSettingsTab, DataRecoveryModal, TemplatesManagerModal } = require("./ui");
const { GUIDE_VIEW_TYPE, GuideView } = require("./guide");
const { HISTORY_VIEW_TYPE, HistoryView } = require("./history-ui");

class LocalFinancePlugin extends Plugin {
  async onload() {
    const saved = await this.loadData();
    this.settings = { ...core.DEFAULTS, ...(saved || {}) };
    for (const key of ["expenseCategories", "incomeCategories", "investmentCategories", "accounts"]) {
      const list = this.settings[key];
      this.settings[key] = Array.isArray(list) && list.every(v => typeof v === "string" && v.trim() && v.length <= 120) && (list.length || key === "accounts") ? [...list] : [...core.DEFAULTS[key]];
    }
    this.settingsWrites = Promise.resolve();
    this.settings.multiCurrencyEnabled = this.settings.multiCurrencyEnabled === true;
    for (const key of ["incomeEnabled", "investmentEnabled", "projectsEnabled"]) this.settings[key] = this.settings[key] !== false;
    for (const key of ["defaultCurrency", "reportCurrency"]) if (!currency.validCurrency(this.settings[key])) this.settings[key] = "CNY";
    // Follow the renamed default directory after sync; leave existing books and
    // custom locations untouched. This never creates or moves financial files.
    if (this.settings.folder === "财务管理/账本"
      && !this.app.vault.getAbstractFileByPath(this.settings.folder)
      && Array.isArray(this.app.vault.getAbstractFileByPath(core.DEFAULTS.folder)?.children)) {
      await this.setSettings({ folder: core.DEFAULTS.folder });
    }
    this.exchange = new currency.ExchangeRates(async url => {
      if (!this.settings.multiCurrencyEnabled) throw new Error("多币种记账未开启");
      let timer;
      try {
        const response = await Promise.race([requestUrl({ url, method: "GET", throw: false }), new Promise((_, reject) => { timer = globalThis.setTimeout(() => reject(new Error("连接超时")), 12000); })]);
        if (response.status !== 200) throw new Error(`服务状态 ${response.status}`);
        return response.json;
      } finally { globalThis.clearTimeout(timer); }
    }, this.settings.exchangeRateCache || {}, cache => this.setSettings({ exchangeRateCache: { ...cache } }), core.today);
    this.store = new FinanceStore(this.app, { parseYaml, stringifyYaml }, () => this.settings.folder);
    this.registerView(VIEW_TYPE, leaf => new FinanceView(leaf, this));
    this.registerView(PROJECT_VIEW_TYPE, leaf => new ProjectView(leaf, this));
    this.registerView(GUIDE_VIEW_TYPE, leaf => new GuideView(leaf, this));
    this.registerView(HISTORY_VIEW_TYPE, leaf => new HistoryView(leaf, this));
    this.addRibbonIcon("wallet", `打开 ${this.manifest.name}`, () => this.run(() => this.activateView()));
    this.addCommand({ id: "open-dashboard", name: "打开财务面板", callback: () => this.run(() => this.activateView()) });
    this.addCommand({ id: "category-settings", name: "打开个性化设置", callback: () => new PersonalizationSettingsModal(this).open() });
    this.addCommand({ id: "fixed-expenses", name: "管理年度固定支出", callback: () => new FixedExpensesModal(this).open() });
    this.addCommand({ id: "calculator", name: "打开计算器", callback: () => new CalculatorModal(this).open() });
    this.addCommand({ id: "memo", name: "打开备忘录", callback: () => this.openMemo() });
    this.addCommand({ id: "guide", name: "打开使用指南", callback: () => this.run(() => this.openGuide()) });
    this.addCommand({ id: "history", name: "跨月查账", callback: () => this.run(() => this.openHistory()) });
    this.addCommand({ id: "templates", name: "管理常用模板", callback: () => new TemplatesManagerModal(this).open() });
    this.addCommand({ id: "data-recovery", name: "打开数据恢复", callback: () => new DataRecoveryModal(this).open() });
    this.addCommand({ id: "projects", name: "打开专项账本", checkCallback: checking => {
      if (!core.featureEnabled(this.settings, "project")) return false;
      if (!checking) this.run(() => this.openProjectView());
      return true;
    } });
    for (const kind of ["expense", "income", "refund", "investment"]) this.addCommand({ id: `add-${kind}`, name: kind === "investment" ? "记录理财持仓" : `记录${core.TYPES[kind]}`, checkCallback: checking => {
      if (!core.featureEnabled(this.settings, kind)) return false;
      if (!checking) new RecordModal(this, kind).open();
      return true;
    } });
    this.addCommand({ id: "current-month-report", name: "生成 / 更新本月月报", callback: () => this.run(async () => { const file = await this.report(core.today().slice(0, 7)); await this.openPath(file.path); }) });
    this.addSettingTab(new FinanceSettingsTab(this.app, this));
    this.app.workspace.onLayoutReady(() => this.run(async () => {
      const data = await this.store.scan();
      if (this.settings.fixedCategoryVersion !== 1) await this.setSettings(settings => ({ expenseCategories: [...new Set([...settings.expenseCategories, "固定支出"])], fixedCategoryVersion: 1 }));
      if (this.settings.categoryImportVersion !== 2) {
        await this.setSettings(settings => {
          const changes = { categoryImportVersion: 2 };
          for (const kind of ["expense", "income", "investment"]) {
            const key = core.categoryKey(kind);
            changes[key] = [...new Set([...settings[key], ...data.records.filter(r => core.categoryKey(r.kind) === key).map(r => r.category)])];
          }
          return changes;
        });
      }
      this.invalidate();
    }));
    const changed = (file, oldPath = "") => {
      this.store.invalidate(file, oldPath);
      if (file.path === this.store.memoPath() && !oldPath) return;
      const root = `${this.settings.folder}/`;
      if (file.path.startsWith(root) || oldPath.startsWith(root)) this.invalidate();
    };
    for (const event of ["create", "modify", "delete", "rename"]) this.registerEvent(this.app.vault.on(event, changed));
    // Recalculate at local midnight, including records entered for future dates.
    this.lastDay = core.today();
    this.registerInterval(globalThis.setInterval(() => { const day = core.today(); if (day !== this.lastDay) { this.lastDay = day; this.invalidate(); } }, 60000));
  }
  onunload() {
    globalThis.clearTimeout(this.refreshTimer);
    this.memoModal?.close();
    // Obsidian owns registered views and restores their state on reload.
  }
  categories(kind) {
    return this.settings[core.categoryKey(kind)];
  }
  defaultCurrency() { return this.settings.multiCurrencyEnabled ? this.settings.defaultCurrency : "CNY"; }
  openMemo() {
    if (this.memoModal) { this.memoModal.editor?.focus(); return; }
    this.memoModal = new MemoModal(this);
    this.memoModal.open();
  }
  reportCurrency() { return this.settings.multiCurrencyEnabled ? this.settings.reportCurrency : "CNY"; }
  async prepare(data, month, code = this.reportCurrency(), { yearlySpending = false, allSpending = false } = {}) {
    const enabled = this.settings.multiCurrencyEnabled;
    if (!enabled) code = "CNY";
    const result = { ...data, records: data.records.map(r => ({ ...r, original: r.original || r })), fixedEntries: data.fixedEntries.map(e => ({ ...e, original: e.original || e })), projects: (data.projects || []).map(p => ({ ...p, original: p.original || p })), warnings: [...data.warnings] };
    const jobs = [];
    const add = (record, key, date) => jobs.push(async () => {
      try {
        if (enabled) record[key] = await this.exchange.get(date);
        else {
          // Previously saved foreign plans may still use a local reference quote.
          // Turning the feature off must never initiate a rate request.
          const quotes = Object.values(this.settings.exchangeRateCache || {}).flatMap(value => {
            try { return [currency.snapshot(value, date)]; } catch (_) { return []; }
          }).sort((a, b) => b.date.localeCompare(a.date));
          if (!quotes.length) throw new Error("历史外币数据缺少本地汇率，请在设置中开启多币种记账后查看");
          record[key] = { ...quotes[0], cached: true };
        }
      }
      catch (error) { result.warnings.push({ path: record.path, message: `无法换算为 ${code}：${error.message}` }); }
    });
    const year = month.slice(0, 4);
    for (const r of result.records) {
      const relevant = r.kind === "investment" ? r.status === "active" && r.date <= core.today() : r.date <= core.today() && (allSpending || r.date.startsWith(month) || (r.date.startsWith(year) && ((yearlySpending && ["expense", "refund"].includes(r.kind)) || r.category === "固定支出" || r.id.startsWith("lfn-fixed-"))));
      if (!relevant || r.currency === code) continue;
      if (!r.fx) add(r, "fx", r.date);
      if (r.kind === "investment" && r.currentValueCents !== null && r.valuationDate <= core.today() && !r.valuationFx) add(r, "valuationFx", r.valuationDate);
    }
    for (const e of result.fixedEntries) if (e.year === year && e.status === "active" && e.currency !== code) add(e, "fx", core.today());
    if (allSpending) for (const p of result.projects) if (p.budgetCents !== null && p.currency !== code && !p.budgetFx) add(p, "budgetFx", p.budgetDate);
    let index = 0;
    await Promise.all(Array.from({ length: Math.min(3, jobs.length) }, async () => { while (index < jobs.length) await jobs[index++](); }));
    return result;
  }
  report(month) {
    const code = this.reportCurrency();
    return this.store.report(month, code, data => this.prepare(data, month, code));
  }
  rememberCategory(kind, name) {
    const key = core.categoryKey(kind);
    return this.categories(kind).includes(name) ? Promise.resolve() : this.setSettings(settings => ({ [key]: [...new Set([...settings[key], name])] }));
  }
  async setSettings(changes) {
    const write = this.settingsWrites.then(async () => {
      const next = { ...this.settings, ...(typeof changes === "function" ? changes(this.settings) : changes) };
      await this.saveData(next);
      if (next.folder !== this.settings.folder) this.store?.invalidate();
      this.settings = next;
    });
    this.settingsWrites = write.catch(() => {});
    return write;
  }
  fail(error) { console.error(`${this.manifest.name}:`, error); new Notice(`操作未完成：${error.message}`, 8000); }
  async run(action) { try { return await action(); } catch (error) { this.fail(error); } }
  invalidate() {
    globalThis.clearTimeout(this.refreshTimer);
    this.refreshTimer = globalThis.setTimeout(() => {
      for (const type of [VIEW_TYPE, PROJECT_VIEW_TYPE, HISTORY_VIEW_TYPE]) for (const leaf of this.app.workspace.getLeavesOfType(type)) this.run(() => leaf.view.render());
    }, 250);
  }
  async activateView() {
    let leaf = this.app.workspace.getLeavesOfType(VIEW_TYPE)[0];
    if (!leaf) {
      leaf = this.app.workspace.getLeaf("tab");
      await leaf.setViewState({ type: VIEW_TYPE, active: true });
    }
    await this.app.workspace.revealLeaf(leaf);
  }
  async openProjectView(id = undefined) {
    if (!core.featureEnabled(this.settings, "project")) { new Notice("请先在个性化设置中开启专项账本"); return; }
    let leaf = this.app.workspace.getLeavesOfType(PROJECT_VIEW_TYPE)[0];
    if (!leaf) { leaf = this.app.workspace.getLeaf("tab"); await leaf.setViewState({ type: PROJECT_VIEW_TYPE, active: true }); }
    if (id !== undefined) { leaf.view.projectId = id; await leaf.view.render(); }
    await this.app.workspace.revealLeaf(leaf);
  }
  async openPath(path) {
    const file = this.app.vault.getAbstractFileByPath(path);
    if (!file || file.extension !== "md") throw new Error("这篇笔记已移动或不存在，请刷新面板");
    const isMonthly = ["monthly", "project"].includes(this.app.metadataCache.getFileCache(file)?.frontmatter?.finance_kind)
      || file.path.startsWith(`${this.settings.folder}/专项/`)
      || isMonthlyPath(file.path, this.settings.folder);
    await this.app.workspace.getLeaf("tab").openFile(file, isMonthly ? { state: { mode: "preview" } } : undefined);
  }
  async openGuide() {
    let leaf = this.app.workspace.getLeavesOfType(GUIDE_VIEW_TYPE)[0];
    if (!leaf) {
      leaf = this.app.workspace.getLeaf("tab");
      await leaf.setViewState({ type: GUIDE_VIEW_TYPE, active: true });
    }
    await this.app.workspace.revealLeaf(leaf);
  }
  async openHistory(filters = null) {
    let leaf = this.app.workspace.getLeavesOfType(HISTORY_VIEW_TYPE)[0];
    if (!leaf) { leaf = this.app.workspace.getLeaf("tab"); await leaf.setViewState({ type: HISTORY_VIEW_TYPE, active: true }); }
    if (filters) await leaf.view.setState({ ...leaf.view.getState(), ...filters });
    await this.app.workspace.revealLeaf(leaf);
  }
}
module.exports = LocalFinancePlugin;
