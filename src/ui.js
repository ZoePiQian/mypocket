"use strict";
const { ItemView, Modal, PluginSettingTab, Notice } = require("obsidian");
const core = require("./core");
const currency = require("./currency");
const fixed = require("./fixed");
const { evaluateExpression } = require("./calculator");
const { createSuggestions } = require("./suggest");
const { spendingSummary, spendingCategories } = require("./charts");
const { createCategoryFilter, renderCategoryChart, renderTrendChart } = require("./chart-ui");
const transactionFilters = require("./transactions");
const { isTouchDevice, adaptModal } = require("./mobile");
const { createId } = require("./identity");
const { decorate, brand } = require("./icons");
const { captureViewState, restoreViewState } = require("./view-state");
const { createReceiptEditor, receiptButton } = require("./attachments-ui");
const VIEW_TYPE = "local-finance-notes-dashboard";

class PocketModal extends Modal {
  open() {
    this.dataRoot = this.plugin?.store?.folder();
    super.open();
    this.mobileCleanup?.();
    this.mobileCleanup = adaptModal(this);
  }
  close() { super.close(); this.mobileCleanup?.(); this.mobileCleanup = null; }
  assertDataRoot() {
    if (this.dataRoot && this.plugin.store.folder() !== this.dataRoot) throw new Error("数据目录已改变，请复制当前输入并重新打开窗口；本次未保存。");
  }
}

function el(parent, tag, cls = "", text = "") {
  const element = parent.ownerDocument.createElement(tag);
  if (cls) element.className = cls;
  if (text !== "") element.textContent = text;
  parent.appendChild(element);
  return element;
}
function button(parent, text, action, cls = "", plugin = null) {
  const b = el(parent, "button", `lfn-button ${cls}`, text);
  b.type = "button";
  b.addEventListener("click", async () => {
    b.disabled = true;
    try { await action(); }
    catch (error) { if (plugin) plugin.fail(error); else new Notice(error.message); }
    finally { b.disabled = false; }
  });
  return b;
}
function inputField(parent, label, name, value = "", type = "text", description = "") {
  const wrap = el(parent, "label", "lfn-field");
  el(wrap, "span", "lfn-field-label", label);
  const input = el(wrap, "input");
  input.type = type;
  input.name = name;
  input.value = value;
  input.enterKeyHint = type === "search" ? "search" : "next";
  if (type === "date") { input.min = "1900-01-01"; input.max = "9999-12-31"; }
  if (name === "amount" || name === "principal" || name === "current_value") { input.inputMode = "decimal"; input.placeholder = "0"; input.autocomplete = "off"; }
  if (description) el(wrap, "span", "lfn-help", description);
  return input;
}
function selectField(parent, label, name, options, value) {
  const wrap = el(parent, "label", "lfn-field");
  el(wrap, "span", "lfn-field-label", label);
  const input = el(wrap, "select");
  input.name = name;
  for (const [v, name] of options) { const option = el(input, "option", "", name); option.value = v; }
  input.value = value;
  return input;
}
function suggestField(parent, label, name, options, value, app, scope) {
  const input = inputField(parent, label, name, value);
  return createSuggestions(input, options, label, app, scope);
}
function refreshSuggestions(list, options) {
  list.setOptions(options);
}
function accountField(parent, label, name, plugin, value, afterChange = null, scope) {
  const field = suggestField(parent, label, name, plugin.settings.accounts, value, plugin.app, scope);
  const settings = button(field.fieldEl, "个性化设置", () => new PersonalizationSettingsModal(plugin, "accounts", () => {
    refreshSuggestions(field.list, plugin.settings.accounts); afterChange?.();
  }).open(), "lfn-link-button");
  settings.setAttribute("aria-label", "个性化设置：付款方式");
  return field;
}
function stat(parent, label, value, hint, cls = "") {
  const card = el(parent, "div", `lfn-stat ${cls}`);
  el(card, "div", "lfn-stat-label", label);
  el(card, "div", "lfn-stat-value", value);
  el(card, "div", "lfn-help", hint);
}
function heading(parent, title, hint = "") {
  const h = el(parent, "div", "lfn-section-heading");
  el(h, "h3", "", title);
  if (hint) el(h, "span", "lfn-help", hint);
  return h;
}
function empty(parent, title, hint) {
  const block = el(parent, "div", "lfn-empty");
  el(block, "strong", "", title);
  el(block, "p", "lfn-help", hint);
}
function noteButton(parent, path, plugin, text = "打开笔记") {
  return button(parent, text, () => plugin.openPath(path), "lfn-link-button", plugin);
}

function currencyControl(grid, form, plugin, date, amount, initial, previous = null) {
  if (!plugin.settings.multiCurrencyEnabled) {
    return {
      input: { value: previous?.currency || initial || "CNY" },
      async resolve(code, day) {
        if (!core.validDate(day)) throw new Error("请选择有效日期");
        if (previous?.fx && day === previous.date) return previous.fx;
        if (previous?.valuationFx && day === previous.valuationDate) return previous.valuationFx;
        if (code === "CNY") return null;
        throw new Error("请先在「个性化设置 → 货币设置」中开启多币种记账，再记录外币付款或更改外币账目的日期");
      },
      refresh() {}, destroy() {}
    };
  }
  const input = selectField(grid, "记账币种", "currency", Object.entries(currency.CURRENCIES), initial || plugin.defaultCurrency());
  const panel = el(form, "div", "lfn-currency-preview");
  const preview = el(panel, "div", "lfn-help"); preview.setAttribute("aria-live", "polite");
  const details = el(panel, "details", "lfn-optional-fields");
  el(details, "summary", "", "离线或需调整汇率时，手动填写");
  const toggleWrap = el(details, "label", "lfn-toggle");
  const manual = el(toggleWrap, "input"); manual.type = "checkbox";
  el(toggleWrap, "span", "", "使用手动汇率");
  const rateGrid = el(details, "div", "lfn-form-grid");
  const rateDate = inputField(rateGrid, "汇率日期", "fx_date", previous?.fx?.date || date.value, "date");
  const usd = inputField(rateGrid, "1 人民币 = 多少美元", "fx_usd", previous?.fx?.rates.USD || ""); usd.inputMode = "decimal";
  const jpy = inputField(rateGrid, "1 人民币 = 多少日元", "fx_jpy", previous?.fx?.rates.JPY || ""); jpy.inputMode = "decimal";
  el(details, "p", "lfn-help", "两项均需填写，以便在三种汇总币种间切换。例：1 美元 = 7 人民币时，美元栏填 1 ÷ 7。手动汇率会保存在本笔账目中。");
  let closed = false, generation = 0, timer;
  const resolve = async (code = input.value, day = date.value) => {
    if (!currency.validCurrency(code) || !core.validDate(day)) throw new Error("请选择有效币种和日期");
    if (!plugin.settings.multiCurrencyEnabled) {
      if (previous?.fx && day === previous.date) return previous.fx;
      if (code === "CNY") return null;
      throw new Error("请在设置中开启多币种记账后保存外币账目");
    }
    if (manual.checked) return currency.snapshot({ date: rateDate.value, source: "手动", rates: { USD: Number(usd.value), JPY: Number(jpy.value) } }, day);
    if (previous?.fx && day === previous.date) return previous.fx;
    if (code === "CNY" && plugin.reportCurrency() === "CNY") return null;
    return plugin.exchange.get(day);
  };
  const refresh = async () => {
    const version = ++generation, code = input.value, day = date.value;
    preview.textContent = code === "CNY" && plugin.reportCurrency() === "CNY" && !manual.checked ? "人民币直接记录，保留实际金额。" : "正在获取参考汇率…";
    try {
      const fx = await resolve(code, day);
      if (closed || version !== generation) return;
      if (!fx) return;
      if (!manual.checked) { usd.value = fx.rates.USD; jpy.value = fx.rates.JPY; rateDate.value = fx.date; }
      const target = code === plugin.reportCurrency() ? (code === "CNY" ? "USD" : "CNY") : plugin.reportCurrency();
      const rate = fx.rates[target] / fx.rates[code];
      let conversion = "";
      try { conversion = ` · 折合 ${core.displayMoney(currency.convert(core.moneyToCents(amount.value, true), code, target, fx), target)}`; } catch (_) {}
      preview.textContent = `1 ${code} ≈ ${Number(rate.toPrecision(8))} ${target}${conversion} · 汇率 ${fx.date}${fx.date !== day ? "（该日可用参考汇率）" : ""} · ${fx.source}${fx.cached ? "（本地缓存）" : ""}${day > core.today() ? " · 未来记录采用当前可用汇率" : ""}`;
    } catch (error) { if (!closed && version === generation) preview.textContent = error.message; }
  };
  const schedule = () => { globalThis.clearTimeout(timer); timer = globalThis.setTimeout(refresh, 250); };
  for (const control of [input, date, manual, rateDate, usd, jpy]) control.addEventListener("change", refresh);
  for (const control of [amount, usd, jpy]) control.addEventListener("input", schedule);
  refresh();
  return { input, resolve, refresh, destroy() { closed = true; generation++; globalThis.clearTimeout(timer); } };
}

class CalculatorModal extends PocketModal {
  constructor(plugin) { super(plugin.app); }
  onOpen() {
    this.modalEl.classList.add("lfn-calculator-modal");
    this.contentEl.classList.add("lfn-modal", "lfn-calculator");
    this.contentEl.replaceChildren();
    el(this.contentEl, "h2", "", "计算器");
    const history = el(this.contentEl, "div", "lfn-calculator-history");
    const display = inputField(this.contentEl, "算式 / 结果", "calculation");
    display.classList.add("lfn-calculator-display");
    display.placeholder = "0";
    display.maxLength = 200;
    display.autocomplete = "off";
    display.spellcheck = false;
    display.setAttribute("aria-label", "算式 / 结果");
    const error = el(this.contentEl, "div", "lfn-error lfn-calculator-error");
    error.setAttribute("role", "alert");
    let completed = false;
    const touch = isTouchDevice(this.contentEl);
    const focus = () => { if (!touch) display.focus(); };
    const clearError = () => { error.textContent = ""; };
    const clear = () => {
      display.value = ""; history.textContent = ""; completed = false; clearError(); focus();
    };
    const insert = text => {
      if (completed) {
        if (/^[+−×÷*/-]$/.test(text)) display.setSelectionRange(display.value.length, display.value.length);
        else { display.value = ""; history.textContent = ""; }
      }
      completed = false;
      const start = display.selectionStart ?? display.value.length;
      const end = display.selectionEnd ?? start;
      if (display.value.length - (end - start) + text.length > display.maxLength) {
        error.textContent = "算式太长，请控制在 200 个字符以内"; focus(); return;
      }
      display.setRangeText(text, start, end, "end");
      clearError(); focus();
    };
    const backspace = () => {
      const start = display.selectionStart ?? display.value.length;
      const end = display.selectionEnd ?? start;
      display.setRangeText("", start === end ? Math.max(0, start - 1) : start, end, "end");
      completed = false; clearError(); focus();
    };
    const calculate = () => {
      const expression = display.value;
      try {
        const result = evaluateExpression(expression);
        history.textContent = `${expression} =`;
        display.value = result;
        completed = true;
        clearError();
        display.setSelectionRange(result.length, result.length);
      } catch (failure) { error.textContent = failure.message; completed = false; }
      focus();
    };
    display.addEventListener("input", () => { completed = false; clearError(); });
    display.addEventListener("keydown", event => {
      if (event.ctrlKey || event.metaKey || event.altKey) return;
      if (event.key === "Enter" || event.key === "=") {
        event.preventDefault(); event.stopPropagation(); calculate();
      } else if (event.key === "c" || event.key === "C") {
        event.preventDefault(); clear();
      } else if (completed && /^[+−×÷*/-]$/.test(event.key)) {
        event.preventDefault(); insert(event.key);
      } else if (completed && /^[\d.(]$/.test(event.key)) {
        display.value = ""; history.textContent = ""; completed = false;
      }
    });
    const keypad = el(this.contentEl, "div", "lfn-calculator-keypad");
    for (const key of ["C", "⌫", "(", ")", "7", "8", "9", "÷", "4", "5", "6", "×", "1", "2", "3", "−", "0", ".", "=", "+"]) {
      const action = key === "C" ? clear : key === "⌫" ? backspace : key === "=" ? calculate : () => insert(key);
      const cls = key === "=" ? "lfn-primary" : /^[+−×÷]$/.test(key) ? "lfn-calculator-operator" : "";
      const control = button(keypad, key, action, cls);
      if (key === "C") control.setAttribute("aria-label", "清空算式");
      if (key === "⌫") control.setAttribute("aria-label", "删除上一位");
      if (key === "=") control.setAttribute("aria-label", "计算结果");
    }
    el(this.contentEl, "p", "lfn-help", touch ? "点按键盘计算 · 长按结果可复制" : "Enter 计算 · C 清空 · 可选中结果复制");
    if (!touch) this.focusTimer = globalThis.setTimeout(focus, 50);
  }
  onClose() { globalThis.clearTimeout(this.focusTimer); this.contentEl.replaceChildren(); }
}

class MemoModal extends PocketModal {
  constructor(plugin) { super(plugin.app); this.plugin = plugin; }
  async onOpen() {
    this.modalEl.classList.add("lfn-memo-modal");
    this.contentEl.classList.add("lfn-modal", "lfn-memo");
    this.contentEl.replaceChildren();
    el(this.contentEl, "h2", "", "备忘录");
    el(this.contentEl, "p", "lfn-help", "随手记下账期、次数卡等信息，输入后自动保存。");
    this.editor = el(this.contentEl, "textarea", "lfn-memo-editor");
    this.editor.setAttribute("aria-label", "备忘录内容");
    this.editor.name = "finance_memo";
    this.editor.placeholder = "例如：\n信用卡每月几号还款\n剪发卡充值次数、剩余次数\n\n可以直接写文字，也支持 Markdown。";
    this.editor.disabled = true;
    this.status = el(this.contentEl, "div", "lfn-help lfn-memo-status", "正在读取…");
    this.status.setAttribute("role", "status");
    this.status.setAttribute("aria-live", "polite");
    this.error = el(this.contentEl, "div", "lfn-error");
    this.error.setAttribute("role", "alert");
    const path = el(this.contentEl, "div", "lfn-help lfn-memo-path");
    const actions = el(this.contentEl, "div", "lfn-modal-actions");
    this.discard = button(actions, "放弃未保存内容并关闭", () => { this.allowClose = true; this.close(); }, "lfn-link-button");
    this.discard.hidden = true;
    this.save = button(actions, "保存", () => this.persist());
    this.save.disabled = true;
    button(actions, "完成", () => this.close(), "lfn-primary");
    this.editor.addEventListener("input", () => {
      globalThis.clearTimeout(this.saveTimer);
      this.status.textContent = "未保存";
      this.saveTimer = globalThis.setTimeout(() => { this.persist().catch(() => {}); }, 700);
    });
    this.editor.addEventListener("keydown", event => {
      if ((event.ctrlKey || event.metaKey) && event.key === "Enter") {
        event.preventDefault(); event.stopPropagation(); this.close();
      }
    });
    const doc = this.contentEl.ownerDocument, win = doc.defaultView;
    const flush = () => { if (!this.closed && !this.allowClose) this.persist().catch(() => {}); };
    const background = () => { if (doc.visibilityState === "hidden") flush(); };
    this.editor.addEventListener("blur", flush);
    doc.addEventListener?.("visibilitychange", background);
    win?.addEventListener("pagehide", flush);
    this.cleanupMemoVisibility = () => {
      doc.removeEventListener?.("visibilitychange", background);
      win?.removeEventListener("pagehide", flush);
    };
    try {
      const note = await this.plugin.store.readMemo();
      if (this.closed) return;
      this.note = note;
      this.editor.value = note.text;
      this.editor.disabled = false;
      this.save.disabled = false;
      this.status.textContent = "已保存到本地";
      path.textContent = note.path;
      if (!isTouchDevice(this.contentEl)) this.editor.focus();
    } catch (error) {
      if (!this.closed) { this.status.textContent = "读取失败"; this.error.textContent = error.message; }
    }
  }
  persist() {
    globalThis.clearTimeout(this.saveTimer);
    if (this.writing) return this.writing;
    if (!this.note) return Promise.resolve();
    this.discard.hidden = true;
    this.writing = (async () => {
      // Include any edits made while an earlier write was still in progress.
      while (this.editor.value !== this.note.text) {
        const text = this.editor.value;
        this.status.textContent = "保存中…";
        this.note = await this.plugin.store.saveMemo(this.note, text);
      }
      this.status.textContent = "已保存到本地";
      this.error.textContent = "";
      this.discard.hidden = true;
    })().catch(error => {
      this.status.textContent = "尚未保存，请保留当前内容";
      this.error.textContent = error.message;
      this.discard.hidden = false;
      throw error;
    }).finally(() => { this.writing = null; });
    return this.writing;
  }
  close() {
    if (this.closing) return;
    if (this.allowClose || !this.note || (!this.writing && this.editor.value === this.note.text)) {
      super.close(); return;
    }
    this.editor.readOnly = true;
    this.closing = this.persist().then(() => {
      this.allowClose = true;
      super.close();
    }).catch(() => { this.editor.readOnly = false; this.editor.focus(); })
      .finally(() => { this.closing = null; });
  }
  onClose() {
    this.closed = true;
    this.cleanupMemoVisibility?.();
    globalThis.clearTimeout(this.saveTimer);
    if (this.plugin.memoModal === this) this.plugin.memoModal = null;
    this.contentEl.replaceChildren();
  }
}

class RecordModal extends PocketModal {
  constructor(plugin, kind = "expense", previous = null, date = core.today()) {
    super(plugin.app);
    this.plugin = plugin;
    this.kind = previous?.kind || kind;
    this.previous = previous;
    this.date = date;
  }
  open() {
    if (!core.featureEnabled(this.plugin.settings, this.kind)) { new Notice("此功能已关闭，可在「个性化设置 → 功能显示」中重新开启。"); return; }
    super.open();
  }
  onOpen() {
    const p = this.plugin, r = this.previous;
    const investment = this.kind === "investment";
    this.contentEl.classList.add("lfn-modal");
    this.contentEl.replaceChildren();
    if (!investment) {
      this.contentEl.classList.add("lfn-entry-modal");
      this.modalEl.classList.add("lfn-entry-dialog");
    }
    const header = investment ? this.contentEl : el(this.contentEl, "div", "lfn-entry-header");
    el(header, "h2", "", r ? `编辑${investment ? "理财持仓" : "收支记录"}` : investment ? "记录一项理财" : "记一笔");
    const tools = investment ? null : el(header, "div", "lfn-entry-tools");
    if (investment) el(this.contentEl, "p", "lfn-help", "记录目前还在理财中的本金；估值可稍后补充。");
    const form = el(this.contentEl, "form", "lfn-form");
    const fields = {};
    const templateSlot = !investment && !r ? el(tools, "div", "lfn-entry-templates") : null;
    const amountRow = investment ? null : el(form, "div", "lfn-entry-amount-row");
    const grid = el(form, "div", "lfn-form-grid");
    if (!investment) grid.classList.add("lfn-entry-details", ...(p.settings.multiCurrencyEnabled ? ["has-currency"] : []));
    if (!investment) {
      fields.amount = inputField(amountRow, p.settings.multiCurrencyEnabled ? "金额" : `金额（${r?.currency && r.currency !== "CNY" ? currency.CURRENCIES[r.currency] : "元"}）`, "amount", r ? core.decimal(r.amountCents) : "");
      fields.amount.required = true;
      fields.amount.parentElement.classList.add("lfn-entry-amount");
      fields.kind = selectField(amountRow, "类型", "kind", [["expense", "支出"], ["income", "收入"], ["refund", "退款"]].filter(([kind]) => core.featureEnabled(p.settings, kind)), this.kind);
      fields.kind.parentElement.classList.add("lfn-entry-kind");
    } else {
      fields.name = inputField(grid, "产品名称 *", "name", r?.name || "");
      fields.name.required = true;
      fields.name.maxLength = 120;
      fields.principal = inputField(grid, p.settings.multiCurrencyEnabled ? "目前在投本金 *" : `目前在投本金（${r?.currency && r.currency !== "CNY" ? currency.CURRENCIES[r.currency] : "元"}）*`, "principal", r ? core.decimal(r.principalCents) : "", "text", "赎回一部分后，请将本金改为剩余投入。");
      fields.principal.required = true;
    }
    fields.date = inputField(grid, investment ? "开始日期 *" : "日期", "date", r?.date || this.date, "date");
    fields.date.required = true;
    const categoriesFor = kind => p.categories(kind);
    const category = suggestField(grid, investment ? "理财类型 *" : "分类", "category", categoriesFor(this.kind), r?.category || "", p.app, this.scope);
    fields.category = category.input;
    fields.category.placeholder = investment ? "请选择或输入理财类型" : "选择或输入";
    fields.category.required = true;
    const refreshCategories = () => {
      refreshSuggestions(category.list, categoriesFor(investment ? "investment" : fields.kind.value));
    };
    const categorySettings = button(investment ? category.fieldEl : tools, investment ? "个性化设置" : "分类与账户设置", () => new PersonalizationSettingsModal(p, investment ? "investment" : fields.kind.value, () => {
      refreshCategories(); refreshSuggestions(account.list, p.settings.accounts);
    }).open(), "lfn-link-button");
    if (investment) categorySettings.setAttribute("aria-label", "个性化设置：分类");
    else decorate(categorySettings, "settings", { iconOnly: true, description: "个性化设置：分类与付款方式" });
    const account = investment
      ? accountField(grid, "平台 / 账户", "account", p, r?.account ?? p.settings.accounts[0] ?? "", refreshCategories, this.scope)
      : suggestField(grid, this.kind === "expense" ? "付款方式" : "收款账户", "account", p.settings.accounts, r?.account ?? p.settings.accounts[0] ?? "", p.app, this.scope);
    if (!investment) account.fieldEl.classList.add("lfn-entry-account");
    this.suggestions = [category.list, account.list];
    fields.account = account.input;
    this.currency = currencyControl(grid, form, p, fields.date, investment ? fields.principal : fields.amount, r?.currency, r);
    fields.currency = this.currency.input;
    if (!investment) {
      fields.kind.addEventListener("change", () => {
        fields.category.value = ""; refreshCategories();
        const label = fields.kind.value === "expense" ? "付款方式" : "收款账户";
        account.fieldEl.querySelector(".lfn-field-label").textContent = label;
        fields.account.setAttribute("aria-label", label);
        account.fieldEl.querySelector(".lfn-suggest-toggle").setAttribute("aria-label", `显示全部${label}`);
        account.fieldEl.querySelector(".lfn-suggest-menu").setAttribute("aria-label", label);
      });
      refreshCategories();
    } else {
      const optional = el(form, "details", "lfn-optional-fields");
      el(optional, "summary", "", "补充估值、到期日或状态（可选）");
      const optionalGrid = el(optional, "div", "lfn-form-grid");
      fields.currentValue = inputField(optionalGrid, p.settings.multiCurrencyEnabled ? "当前估值（与本金同币种，可留空）" : `当前估值（${r?.currency && r.currency !== "CNY" ? currency.CURRENCIES[r.currency] : "元"}，可留空）`, "current_value", r?.currentValueCents != null ? core.decimal(r.currentValueCents) : "", "text", "填写你在平台上看到的当前金额；允许 0。");
      fields.valuationDate = inputField(optionalGrid, "估值日期", "valuation_date", r?.valuationDate || core.today(), "date");
      fields.dueDate = inputField(optionalGrid, "到期日期（可留空）", "due_date", r?.dueDate || "", "date");
      fields.status = selectField(optionalGrid, "状态", "status", [["active", "正在理财"], ["closed", "已结束 / 全部赎回"]], r?.status || "active");
      el(optional, "p", "lfn-callout", "标为「已结束」后保留笔记，退出在投统计。已到账收益请另记为「收入 / 理财收益」，本金赎回无需记成收入。");
      optional.open = !!r;
    }
    const memoWrap = el(form, "label", "lfn-field");
    el(memoWrap, "span", "lfn-field-label", investment ? "备注（可留空）" : "备注");
    fields.memo = el(memoWrap, "textarea");
    fields.memo.name = "memo";
    fields.memo.value = r?.memo || "";
    fields.memo.maxLength = 2000;
    fields.memo.rows = 2;
    fields.memo.placeholder = investment ? "例如：为什么买这个产品" : "补充这笔记录的细节（选填）";
    if (templateSlot) this.templatePicker = createTemplatePicker(templateSlot, p, this, { fields });
    if (!investment) this.receiptEditor = createReceiptEditor(form, p, { record: r, dateInput: fields.date, root: this.dataRoot });
    if (investment) el(form, "p", "lfn-help", "新输入的分类会记入常用分类。估值为手动记录，历史变动可补充在笔记正文中。");
    else {
      const dateHint = el(form, "p", "lfn-help lfn-entry-date-hint");
      dateHint.setAttribute("aria-live", "polite");
      const updateDateHint = () => { dateHint.textContent = fields.date.value > core.today() ? "未来日期的收支，将在当天计入汇总。" : ""; };
      fields.date.addEventListener("change", updateDateHint); updateDateHint();
    }
    const errorBox = el(form, "div", "lfn-error");
    errorBox.setAttribute("role", "alert");
    const actions = el(form, "div", "lfn-modal-actions");
    button(actions, "取消", () => this.close());
    const submit = el(actions, "button", "lfn-button lfn-primary", r ? "保存修改" : "保存到笔记");
    submit.type = "submit";
    form.addEventListener("keydown", event => {
      if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) { event.preventDefault(); form.requestSubmit(); }
    });
    form.addEventListener("submit", async event => {
      event.preventDefault();
      if (submit.disabled) return;
      submit.disabled = true;
      errorBox.textContent = "";
      let receiptCommit = null;
      try {
        const kind = investment ? "investment" : fields.kind.value;
        if (!core.featureEnabled(p.settings, kind)) throw new Error("此功能已关闭，请先在「个性化设置 → 功能显示」中开启。");
        const fm = { finance_schema: 1, finance_kind: kind, id: r?.id || createId(), date: fields.date.value, currency: fields.currency.value, category: fields.category.value.trim(), account: fields.account.value.trim(), memo: fields.memo.value.trim(), updated_at: new Date().toISOString() };
        if (investment) {
          const hasValue = fields.currentValue.value.trim() !== "";
          Object.assign(fm, { name: fields.name.value.trim(), principal: Number(core.decimal(core.moneyToCents(fields.principal.value))), current_value: hasValue ? Number(core.decimal(core.moneyToCents(fields.currentValue.value, true))) : null, valuation_date: hasValue ? fields.valuationDate.value : null, status: fields.status.value, due_date: fields.dueDate.value || null });
        } else fm.amount = Number(core.decimal(core.moneyToCents(fields.amount.value)));
        fm.fx = await this.currency.resolve(fm.currency, fm.date);
        if (investment && fm.current_value !== null) {
          if (r?.valuationFx && fm.valuation_date === r.valuationDate) fm.valuation_fx = r.valuationFx;
          else if (fm.fx && fm.valuation_date === fm.date) fm.valuation_fx = fm.fx;
          else if (fm.currency !== "CNY" || p.reportCurrency() !== "CNY") fm.valuation_fx = await this.currency.resolve(fm.currency, fm.valuation_date);
        }
        if (!r) fm.tags = ["财务", investment ? "理财" : "流水"];
        this.assertDataRoot();
        core.validateRecord(fm);
        if (this.receiptEditor) { receiptCommit = await this.receiptEditor.commit(); fm.attachments = receiptCommit.attachments; }
        else if (r?.attachments) fm.attachments = r.attachments;
        this.assertDataRoot();
        const file = await p.store.save(fm, r);
        receiptCommit?.finish(); receiptCommit = null;
        try { if (!r || fm.category !== r.category || kind !== r.kind) await p.rememberCategory(kind, fm.category); }
        catch (error) { new Notice(`账目已保存，但常用分类未保存：${error.message}`, 8000); }
        this.close();
        p.invalidate();
        new Notice(`已保存到 ${file.path}`);
        if (p.settings.openNoteAfterSave) await p.openPath(file.path);
      } catch (error) { try { await receiptCommit?.rollback(); } catch (cleanup) { error.message += `；凭证清理未完成：${cleanup.message}`; } errorBox.textContent = error.message; }
      finally { submit.disabled = false; }
    });
    // Obsidian focuses the first field after onOpen; focus the money field afterwards.
    if (!isTouchDevice(this.contentEl)) this.focusTimer = globalThis.setTimeout(() => { if (this.contentEl.isConnected) (investment ? fields.name : fields.amount).focus(); }, 50);
  }
  onClose() { globalThis.clearTimeout(this.focusTimer); this.templatePicker?.destroy(); this.receiptEditor?.destroy(); this.currency?.destroy(); this.suggestions?.forEach(list => list.destroy()); this.contentEl.replaceChildren(); }
}

class TrashModal extends PocketModal {
  constructor(plugin, record) { super(plugin.app); this.plugin = plugin; this.record = record; }
  onOpen() {
    this.contentEl.classList.add("lfn-modal");
    const monthly = this.record.storage === "monthly";
    el(this.contentEl, "h2", "", monthly ? "删除这条流水？" : "移至回收站？");
    el(this.contentEl, "p", "", monthly
      ? `将 ${this.record.date} 的「${this.record.category}」${core.displayMoney(this.record.amountCents, this.record.currency)} 从流水表移至「${this.plugin.settings.folder}/回收站/${this.record.date.slice(0, 4)}.md」。其他记录和月笔记正文保留，可从回收站恢复这一行。`
      : `将整篇笔记「${this.record.path}」移至仓库的 .trash 本地回收站，正文和附件链接也随笔记移走。`);
    const row = el(this.contentEl, "div", "lfn-modal-actions");
    button(row, "取消", () => this.close());
    button(row, "移至回收站", async () => { this.assertDataRoot(); await this.plugin.store.trash(this.record); this.close(); this.plugin.invalidate(); }, "lfn-danger", this.plugin);
  }
}

class PersonalizationSettingsModal extends PocketModal {
  constructor(plugin, kind = "features", afterChange = null) {
    super(plugin.app); this.plugin = plugin; this.kind = ["features", "income", "investment", "accounts", "currency", "templates"].includes(kind) ? kind : "expense"; this.afterChange = afterChange;
  }
  onOpen() { this.draw(); }
  draw() {
    this.templateManager?.destroy();
    if (!core.featureEnabled(this.plugin.settings, this.kind)) this.kind = "features";
    const p = this.plugin, account = this.kind === "accounts", key = account ? "accounts" : core.categoryKey(this.kind), label = account ? "付款方式" : "分类";
    this.contentEl.replaceChildren(); this.contentEl.classList.add("lfn-modal");
    el(this.contentEl, "h2", "", "个性化设置");
    el(this.contentEl, "p", "lfn-help", this.kind === "features" ? "按自己的习惯选择功能，记支出始终保留。" : this.kind === "currency" ? "设置日常使用的货币，以及查看汇总时使用的货币。" : this.kind === "templates" ? "模板只预填记账表单，核对金额后再保存。日常与各专项分别管理。" : account
      ? "添加常用付款方式，可在记账表单中选择。重命名或移除只调整常用选项，历史账目的账户名称保留。"
      : "新增后即可在记账时选择。重命名或移除只调整常用选项，历史账目的分类名称保留；退款使用支出分类。");
    el(this.contentEl, "div", "lfn-field-label", "设置项目");
    const groups = el(this.contentEl, "div", "lfn-segments lfn-personalization-tabs");
    groups.setAttribute("role", "group"); groups.setAttribute("aria-label", "个性化设置项目");
    const drawGroups = () => {
      groups.replaceChildren();
      const choices = [["features", "功能显示"], ["expense", "支出分类"], ["income", "收入分类"], ["investment", "理财类型"], ["accounts", "付款方式"], ["currency", "货币设置"], ["templates", "常用模板"]].filter(([kind]) => core.featureEnabled(p.settings, kind));
      groups.style.setProperty("--lfn-settings-columns", choices.length <= 4 ? 2 : 3);
      for (const [kind, label] of choices) {
        const choice = button(groups, label, () => { this.kind = kind; this.draw(); }, kind === this.kind ? "lfn-primary" : "");
        choice.setAttribute("aria-pressed", String(kind === this.kind));
      }
    };
    drawGroups();
    const support = el(this.contentEl, "div", "lfn-actions lfn-support-actions");
    button(support, "使用指南", () => { this.close(); return p.openGuide(); }, "lfn-link-button", p);
    button(support, "数据恢复", () => new DataRecoveryModal(p).open(), "lfn-link-button", p);
    if (this.kind === "templates") {
      this.templateManager = createTemplateManager(this.contentEl, p, this);
      const actions = el(this.contentEl, "div", "lfn-modal-actions"); button(actions, "完成", () => this.close());
      return;
    }
    if (this.kind === "features") {
      const list = el(this.contentEl, "div", "lfn-feature-settings");
      const expense = el(list, "div", "lfn-feature-row");
      const expenseText = el(expense, "div"); el(expenseText, "strong", "", "记支出");
      el(expenseText, "p", "lfn-help", "记录消费与退款，始终保留。"); el(expense, "span", "lfn-feature-required", "始终开启");
      const error = el(this.contentEl, "div", "lfn-error"); error.setAttribute("role", "alert");
      for (const [kind, key, title, hint] of [["income", "incomeEnabled", "记收入", "显示收入入口、收入统计与收入记录。"], ["investment", "investmentEnabled", "理财", "显示理财入口、本金统计与持仓列表。"], ["project", "projectsEnabled", "专项账本", "独立记录装修、旅行、健身等专项，不计入日常月账单。"]]) {
        const row = el(list, "div", "lfn-feature-row"), text = el(row, "div");
        el(text, "strong", "", title); el(text, "p", "lfn-help", hint);
        const toggle = button(row, "", async () => {
          error.textContent = "";
          try {
            await p.setSettings({ [key]: !core.featureEnabled(p.settings, kind) });
            toggle.setAttribute("aria-checked", String(core.featureEnabled(p.settings, kind)));
            drawGroups(); p.invalidate(); this.afterChange?.();
          } catch (e) { error.textContent = `设置未保存：${e.message}`; }
        }, "lfn-feature-switch");
        toggle.setAttribute("role", "switch"); toggle.setAttribute("aria-label", title); toggle.setAttribute("aria-checked", String(core.featureEnabled(p.settings, kind)));
      }
      el(this.contentEl, "p", "lfn-help", "切换后自动保存。关闭只隐藏对应界面，已有笔记与完整月报数据保留；重新开启即可继续查看。");
      const actions = el(this.contentEl, "div", "lfn-modal-actions"); button(actions, "完成", () => this.close());
      return;
    }
    if (this.kind === "currency") {
      const toggleWrap = el(this.contentEl, "label", "lfn-toggle");
      const enabled = el(toggleWrap, "input"); enabled.type = "checkbox"; enabled.name = "multi_currency_enabled"; enabled.checked = p.settings.multiCurrencyEnabled;
      el(toggleWrap, "span", "", "启用多币种记账");
      el(this.contentEl, "p", "lfn-help", "默认关闭，直接使用人民币。开启后显示记账币种、汇总币种和汇率换算；关闭后保留已有账目和货币偏好。");
      const options = el(this.contentEl, "div");
      options.hidden = !enabled.checked;
      enabled.addEventListener("change", () => { options.hidden = !enabled.checked; });
      const grid = el(options, "div", "lfn-form-grid");
      const initial = selectField(grid, "默认记账币种", "default_currency", Object.entries(currency.CURRENCIES), p.settings.defaultCurrency);
      const report = selectField(grid, "汇总币种", "report_currency", Object.entries(currency.CURRENCIES), p.settings.reportCurrency);
      el(options, "p", "lfn-help", "默认人民币。长期用美元或日元时，可将两项都设为对应货币；每次记账仍可临时切换。更换汇总币种会重新换算统计，原币金额保留。");
      el(options, "p", "lfn-help", "金额在界面向上取整显示，实际金额和汇率保存在本地笔记，合计先按实际金额计算。参考汇率来自 Frankfurter / ECB，非交易日使用最近可用日期；联网仅查询日期和币种。");
      const error = el(this.contentEl, "div", "lfn-error"); error.setAttribute("role", "alert");
      const actions = el(this.contentEl, "div", "lfn-modal-actions");
      button(actions, "取消", () => this.close());
      button(actions, "保存设置", async () => {
        try { await p.setSettings({ multiCurrencyEnabled: enabled.checked, defaultCurrency: initial.value, reportCurrency: report.value }); p.invalidate(); this.afterChange?.(); this.close(); new Notice("货币设置已保存"); }
        catch (e) { error.textContent = e.message; }
      }, "lfn-primary");
      return;
    }
    const addForm = el(this.contentEl, "form", "lfn-category-add");
    const name = inputField(addForm, `新${label}名称`, account ? "new_account" : "new_category"); name.required = true; name.maxLength = 120;
    name.placeholder = account ? "例如：招商银行卡、信用卡、数字人民币" : "例如：孝敬父母、宠物、旅行";
    const add = el(addForm, "button", "lfn-button lfn-primary", `新增${label}`); add.type = "submit";
    const error = el(this.contentEl, "div", "lfn-error"); error.setAttribute("role", "alert");
    const change = async (operation, original, replacement = "") => {
      error.textContent = "";
      try {
        await p.setSettings(settings => ({ [key]: (account ? core.changeAccount : core.changeCategory)(settings[key], operation, original, replacement) }));
        p.invalidate(); this.afterChange?.(); this.draw();
        new Notice(operation === "add" ? `${label}已新增` : operation === "rename" ? `常用${label}名称已更新` : `已从常用${label}移除，历史账目保留`);
      } catch (e) { error.textContent = e.message; }
    };
    addForm.addEventListener("submit", async event => { event.preventDefault(); if (add.disabled) return; add.disabled = true; try { await change("add", name.value); } finally { add.disabled = false; } });
    const list = el(this.contentEl, "div", "lfn-category-settings-list");
    if (!p.settings[key].length) empty(list, "还没有常用付款方式", "可以在上方新增，也可以在记账时留空或手动输入账户。");
    for (const value of p.settings[key]) {
      const row = el(list, "div", "lfn-category-setting");
      const input = el(row, "input"); input.value = value; input.maxLength = 120; input.setAttribute("aria-label", `${value}${label}名称`);
      button(row, "重命名", () => change("rename", value, input.value));
      button(row, "移除", () => change("remove", value), "lfn-subtle-danger");
    }
    const actions = el(this.contentEl, "div", "lfn-modal-actions"); button(actions, "完成", () => this.close());
  }
  onClose() { this.templateManager?.destroy(); this.contentEl.replaceChildren(); }
}

class FixedEntryModal extends PocketModal {
  constructor(plugin, year, previous = null, afterSave = null, projectId = "") {
    super(plugin.app); this.plugin = plugin; this.year = String(year); this.previous = previous; this.afterSave = afterSave; this.defaultProjectId = projectId;
  }
  async onOpen() {
    const p = this.plugin, e = this.previous;
    this.closed = false;
    let projectChoices;
    try { projectChoices = (await p.store.scan()).projects || []; }
    catch (err) { el(this.contentEl, "p", "lfn-error", err.message); button(this.contentEl, "关闭", () => this.close()); return; }
    if (this.closed) return;
    this.contentEl.classList.add("lfn-modal");
    el(this.contentEl, "h2", "", e ? "编辑固定支出" : `新增 ${this.year} 年固定支出`);
    el(this.contentEl, "p", "lfn-help", "先保存年度清单，付款后再点「记录付款」。清单本身不增加实际支出。");
    const form = el(this.contentEl, "form"), grid = el(form, "div", "lfn-form-grid");
    const name = inputField(grid, "项目名称 *", "fixed_name", e?.name || ""); name.required = true; name.maxLength = 120; name.placeholder = "例如：网盘年费、电视会员";
    const cycle = selectField(grid, "付费周期", "fixed_cycle", [["yearly", "按年付费"], ["monthly", "按月付费"]], e?.cycle || "yearly");
    const selectedCurrency = e?.currency || p.defaultCurrency();
    const amount = inputField(grid, p.settings.multiCurrencyEnabled ? "每次费用 *" : `每次费用（${selectedCurrency === "CNY" ? "元" : currency.CURRENCIES[selectedCurrency]}）*`, "amount", e ? core.decimal(e.amountCents) : ""); amount.required = true;
    const code = p.settings.multiCurrencyEnabled ? selectField(grid, "费用币种", "fixed_currency", Object.entries(currency.CURRENCIES), selectedCurrency) : { value: selectedCurrency };
    const initialOwner = e?.projectId ?? this.defaultProjectId;
    const owners = [["", "日常支出"], ...projectChoices.filter(project => project.status === "active" || project.id === initialOwner).map(project => [project.id, `${project.name}${project.status === "archived" ? "（已归档）" : ""}`])];
    if (initialOwner && !owners.some(([id]) => id === initialOwner)) owners.push([initialOwner, "原专项不可用，请检查后调整"]);
    const owner = core.featureEnabled(p.settings, "project") ? selectField(grid, "付款归属", "fixed_project", owners, initialOwner) : { value: initialOwner };
    if (!core.featureEnabled(p.settings, "project") && e?.projectId) el(form, "p", "lfn-help", "此计划归属专项；专项入口虽已隐藏，付款仍写入原专项。");
    const defaultDate = this.year === core.today().slice(0, 4) ? core.today() : `${this.year}-01-01`;
    const date = inputField(grid, "本年首次付款 / 续费日 *", "fixed_first_date", e?.firstDate || defaultDate, "date", "月付从此月算到年底；月底遇到短月，按该月最后一天安排。"); date.required = true; date.min = `${this.year}-01-01`; date.max = `${this.year}-12-31`;
    const accountFieldControl = accountField(grid, "付款方式 / 支付账户", "fixed_account", p, e?.account ?? p.settings.accounts[0] ?? "", null, this.scope);
    const account = accountFieldControl.input;
    this.accountSuggestions = accountFieldControl.list;
    const status = selectField(grid, "状态", "fixed_status", [["active", "启用"], ["paused", "停用（保留历史付款）"]], e?.status || "active");
    const wrap = el(form, "label", "lfn-field"); el(wrap, "span", "lfn-field-label", "备注");
    const memo = el(wrap, "textarea"); memo.name = "fixed_memo"; memo.maxLength = 1500; memo.rows = 2; memo.value = e?.memo || "";
    el(form, "p", "lfn-help", "价格与付款归属只影响之后的付款；已记录的费用保留原归属。已有付款时，周期与首次付款日保留；换套餐可停用原项目，再新增一项。");
    const error = el(form, "div", "lfn-error"); error.setAttribute("role", "alert");
    const actions = el(form, "div", "lfn-modal-actions"); button(actions, "取消", () => this.close());
    const save = el(actions, "button", "lfn-button lfn-primary", "保存年度清单"); save.type = "submit";
    form.addEventListener("submit", async event => {
      event.preventDefault(); if (save.disabled) return; save.disabled = true; error.textContent = "";
      try {
        this.assertDataRoot();
        await p.store.saveFixed({ year: this.year, id: e?.id || createId(), name: name.value.trim(), cycle: cycle.value,
          amount: amount.value, currency: code.value, projectId: owner.value, firstDate: date.value, account: account.value.trim(), status: status.value, memo: memo.value.trim() }, e);
        this.close(); p.invalidate(); await this.afterSave?.(); new Notice("固定支出已保存到年度笔记，实际付款请另行确认");
      } catch (err) { error.textContent = err.message; } finally { save.disabled = false; }
    });
  }
  onClose() { this.closed = true; this.accountSuggestions?.destroy(); this.contentEl.replaceChildren(); }
}

class FixedPaymentModal extends PocketModal {
  constructor(plugin, entry, records, afterSave = null) { super(plugin.app); this.plugin = plugin; this.entry = entry; this.records = records; this.afterSave = afterSave; }
  onOpen() {
    const p = this.plugin, entry = this.entry;
    this.contentEl.classList.add("lfn-modal");
    el(this.contentEl, "h2", "", `记录付款 · ${entry.name}`);
    el(this.contentEl, "p", "lfn-callout", entry.projectId ? "确认付款后仅写入所属专项，不计入日常月账单。同一期只记录一次；年度计划不会再加一次。" : "确认已经付款后保存。实际金额计入付款月份的「固定支出」，同一期只记一次；年度计划和月均参考不会再加一次。");
    const pending = fixed.payments(entry, this.records).filter(item => !item.record);
    if (!pending.length) { el(this.contentEl, "p", "", "本年各期付款已记录。"); button(this.contentEl, "关闭", () => this.close()); return; }
    const form = el(this.contentEl, "form"), grid = el(form, "div", "lfn-form-grid");
    const period = selectField(grid, "对应期次", "fixed_period", pending.map(item => [item.date, `${item.date}${item.date > core.today() ? "（提前续费）" : ""}`]), pending[0].date);
    const amount = inputField(grid, p.settings.multiCurrencyEnabled ? "实际付款金额 *" : `实际付款金额（${entry.currency === "CNY" ? "元" : currency.CURRENCIES[entry.currency]}）*`, "amount", core.decimal(entry.amountCents)); amount.required = true;
    const defaultDate = entry.year === core.today().slice(0, 4) ? core.today() : pending[0].date;
    const date = inputField(grid, "实际付款日 *", "fixed_paid_date", defaultDate, "date"); date.required = true; date.min = `${entry.year}-01-01`; date.max = `${entry.year}-12-31` < core.today() ? `${entry.year}-12-31` : core.today();
    this.currency = currencyControl(grid, form, p, date, amount, entry.currency);
    const accountFieldControl = accountField(grid, "付款方式 / 支付账户", "fixed_payment_account", p, entry.account, null, this.scope);
    const account = accountFieldControl.input;
    this.accountSuggestions = accountFieldControl.list;
    const wrap = el(form, "label", "lfn-field"); el(wrap, "span", "lfn-field-label", "备注");
    const memo = el(wrap, "textarea"); memo.name = "fixed_payment_memo"; memo.maxLength = 1500; memo.rows = 2; memo.value = entry.memo;
    this.receiptEditor = createReceiptEditor(form, p, { dateInput: date, root: this.dataRoot });
    const error = el(form, "div", "lfn-error"); error.setAttribute("role", "alert");
    const actions = el(form, "div", "lfn-modal-actions"); button(actions, "取消", () => this.close());
    const save = el(actions, "button", "lfn-button lfn-primary", "确认已付，记入支出"); save.type = "submit";
    form.addEventListener("submit", async event => {
      event.preventDefault(); if (save.disabled) return; save.disabled = true; error.textContent = "";
      let receiptCommit = null;
      try {
        const values = { amount: core.decimal(core.moneyToCents(amount.value)), currency: this.currency.input.value, date: date.value, account: account.value.trim(), memo: memo.value.trim() };
        const scheduledDate = period.value;
        values.fx = await this.currency.resolve(values.currency, values.date);
        this.assertDataRoot();
        core.validateRecord({ finance_schema: 1, finance_kind: "expense", id: "fixed-payment-validation", category: "固定支出", ...values });
        receiptCommit = await this.receiptEditor.commit(); values.attachments = receiptCommit.attachments;
        this.assertDataRoot();
        const file = await p.store.payFixed(entry, scheduledDate, values);
        receiptCommit.finish(); receiptCommit = null;
        this.close(); p.invalidate(); await this.afterSave?.(); new Notice(`已记入 ${file.path}，年度清单不会重复计费`);
      } catch (err) { try { await receiptCommit?.rollback(); } catch (cleanup) { err.message += `；凭证清理未完成：${cleanup.message}`; } error.textContent = err.message; } finally { save.disabled = false; }
    });
  }
  onClose() { this.receiptEditor?.destroy(); this.currency?.destroy(); this.accountSuggestions?.destroy(); this.contentEl.replaceChildren(); }
}

class FixedExpensesModal extends PocketModal {
  constructor(plugin, year = core.today().slice(0, 4), projectId = "*") { super(plugin.app); this.plugin = plugin; this.year = String(year); this.owner = projectId; this.generation = 0; }
  onOpen() { this.closed = false; this.plugin.run(() => this.draw()); }
  onClose() { this.closed = true; this.generation++; this.contentEl.replaceChildren(); }
  async draw() {
    const generation = ++this.generation, p = this.plugin, code = p.reportCurrency();
    const scanned = await p.store.scan();
    const data = await p.prepare({ ...scanned, records: [...scanned.records, ...(scanned.projectRecords || [])] }, `${this.year}-01`, code);
    if (this.closed || generation !== this.generation) return;
    this.contentEl.replaceChildren(); this.contentEl.classList.add("lfn-modal", "lfn-fixed-manager");
    el(this.contentEl, "h2", "", "年度固定支出");
    el(this.contentEl, "p", "lfn-help", "网盘、电视会员等放在年度清单里。付款时一键记账，下一年可沿用清单。计划费用仅供参考，不自动扣款或生成支出。");
    const nav = el(this.contentEl, "div", "lfn-monthbar");
    button(nav, "←", () => { if (Number(this.year) > 1900) { this.year = String(Number(this.year) - 1); return this.draw(); } }, "", p).setAttribute("aria-label", "上一年");
    const year = inputField(nav, "清单年份", "fixed_year", this.year, "number"); year.min = "1900"; year.max = "9999"; year.step = "1";
    year.addEventListener("change", () => { if (fixed.validYear(year.value)) { this.year = year.value; p.run(() => this.draw()); } else new Notice("请选择 1900 至 9999 之间的年份"); });
    button(nav, "→", () => { if (Number(this.year) < 9999) { this.year = String(Number(this.year) + 1); return this.draw(); } }, "", p).setAttribute("aria-label", "下一年");
    button(nav, "刷新", () => { p.store.invalidate(); return this.draw(); }, "", p);
    const ownerChoices = [["*", "全部固定支出"], ["", "日常支出"], ...(data.projects || []).map(project => [project.id, project.name + (project.status === "archived" ? "（已归档）" : "")])];
    if (!ownerChoices.some(([id]) => id === this.owner)) ownerChoices.push([this.owner, "原专项不可用"]);
    const owner = selectField(nav, "付款归属", "fixed_owner_filter", ownerChoices, this.owner);
    owner.addEventListener("change", () => { this.owner = owner.value; p.run(() => this.draw()); });
    const scope = item => this.owner === "*" || (item.projectId || "") === this.owner;
    const summary = fixed.summarize(data.fixedEntries.filter(scope), data.records.filter(scope), this.year, core.today(), code);
    const planMissing = summary.missingFx.some(item => !!item.cycle), actualMissing = summary.missingFx.some(item => !item.cycle);
    const money = value => core.displayMoney(value, code);
    const stats = el(this.contentEl, "div", "lfn-fixed-stats");
    stat(stats, "本年计划费用", (planMissing ? "待补全" : money(summary.planned)), p.settings.multiCurrencyEnabled ? "启用项目，外币计划按当前可用汇率估算" : "本年启用的固定支出项目");
    stat(stats, "已记固定支出", (actualMissing ? "待补全" : money(summary.actual)), this.owner === "*" ? "包含日常和专项的固定付款，退款会抵扣" : "仅统计所选归属的实际付款，退款会抵扣");
    stat(stats, "月均参考", (planMissing ? "待补全" : money(summary.monthlyAverage)), "本年计划 ÷ 12，仅作参考");
    const actions = el(this.contentEl, "div", "lfn-actions");
    button(actions, "+ 新增固定支出", () => new FixedEntryModal(p, this.year, null, () => this.draw(), this.owner === "*" ? "" : this.owner).open(), "lfn-primary");
    const copy = button(actions, "沿用上年清单", async () => { this.assertDataRoot(); await p.store.copyFixedYear(this.year); p.invalidate(); await this.draw(); new Notice("已沿用上年价格与项目，请检查续费日期；尚未生成付款流水"); }, "", p);
    copy.disabled = this.owner !== "*" || data.fixedEntries.some(e => e.year === this.year) || Number(this.year) === 1900;
    copy.title = this.owner !== "*" ? "切换到全部固定支出后沿用完整年度清单" : data.fixedEntries.some(e => e.year === this.year) ? "本年已有项目，避免重复复制" : "复制上年启用项目，不复制付款记录";
    const path = `${p.settings.folder}/固定支出/${this.year}.md`;
    if (p.app.vault.getAbstractFileByPath(path)) noteButton(actions, path, p, "打开年度笔记");
    if (data.warnings.length) el(this.contentEl, "p", "lfn-warning", "账本有数据问题，请在财务面板修正后再记录付款；以下合计可能不完整。");
    if (!summary.entries.length) empty(this.contentEl, "本年还没有固定支出清单", "添加一项年费，或沿用上年清单；价格可逐年调整。");
    for (const entry of summary.entries.sort((a, b) => a.firstDate.localeCompare(b.firstDate) || a.name.localeCompare(b.name))) {
      const payments = fixed.payments(entry, data.records), pending = payments.filter(item => !item.record), recorded = payments.length - pending.length;
      const row = el(this.contentEl, "div", "lfn-fixed-entry");
      const description = el(row, "div", "lfn-record-description"); el(description, "strong", "", entry.name);
      el(description, "div", "lfn-help", `${entry.cycle === "yearly" ? "年付" : "月付"} ${core.displayMoney(entry.amountCents, entry.currency)} · 本年 ${payments.length} 期 · 已记 ${recorded} 期${entry.status === "paused" ? " · 已停用" : pending.length ? ` · 下期待记 ${pending[0].date}` : " · 本年已记完"}`);
      if (entry.memo) el(description, "div", "lfn-help", entry.memo);
      if (entry.projectId) el(description, "div", "lfn-help", `归属专项：${data.projects.find(project => project.id === entry.projectId)?.name || "专项不可用，请检查"} · 不计入日常月账单`);
      const controls = el(row, "div", "lfn-record-controls");
      const pay = button(controls, pending.length ? "记录付款" : "已记录", () => new FixedPaymentModal(p, entry.original || entry, data.records, () => this.draw()).open(), "", p);
      pay.disabled = !pending.length || entry.status === "paused" || entry.year > core.today().slice(0, 4);
      if (entry.year > core.today().slice(0, 4)) pay.title = "未来年度先保存计划，到付款年份再记账";
      button(controls, "编辑", () => new FixedEntryModal(p, this.year, entry.original || entry, () => this.draw()).open());
      const latest = payments.filter(item => item.record).at(-1)?.record;
      if (latest) noteButton(controls, latest.path, p, "付款笔记");
    }
    const footer = el(this.contentEl, "div", "lfn-modal-actions"); button(footer, "完成", () => this.close());
  }
}

class FinanceView extends ItemView {
  constructor(leaf, plugin) {
    super(leaf);
    this.plugin = plugin;
    this.month = core.today().slice(0, 7);
    this.search = "";
    this.filter = "all";
    this.expenseCategory = "";
    this.includeClosed = false;
    this.showAllRecords = false;
    this.categoryScope = "month";
    this.chartCategories = null;
    this.generation = 0;
  }
  getViewType() { return VIEW_TYPE; }
  getDisplayText() { return this.plugin.manifest.name; }
  getIcon() { return "wallet"; }
  async onOpen() { this.closed = false; await this.render(); }
  async onClose() { this.closed = true; this.generation++; this.chartFilter?.destroy(); }
  record(kind) {
    const date = this.month === core.today().slice(0, 7) ? core.today() : `${this.month}-01`;
    new RecordModal(this.plugin, kind, null, kind === "investment" ? core.today() : date).open();
  }
  async render() {
    const generation = ++this.generation;
    const p = this.plugin;
    const settings = p.settings, incomeEnabled = core.featureEnabled(settings, "income"), investmentEnabled = core.featureEnabled(settings, "investment");
    const code = this.plugin.reportCurrency();
    let data;
    try {
      const scanned = await p.store.scan();
      // Visibility applies to the dashboard only; reports still read all saved data.
      data = await p.prepare({ ...scanned, records: scanned.records.filter(record => core.featureEnabled(settings, record.kind)) }, this.month, code, { yearlySpending: true });
    }
    catch (error) {
      if (generation !== this.generation || this.closed) return;
      this.chartFilter?.destroy();
      this.contentEl.replaceChildren();
      empty(this.contentEl, "账本暂时无法读取", error.message);
      button(this.contentEl, "重新读取", () => this.render(), "", this.plugin);
      return;
    }
    if (generation !== this.generation || this.closed) return;
    const renderKey = this.plugin.settings.folder + ":" + this.month;
    const transient = this.renderedKey === renderKey ? captureViewState(this.contentEl) : null;
    if (this.renderedKey !== renderKey) { this.showAllRecords = false; this.trendMonth = this.month; }
    this.renderedKey = renderKey;
    this.chartFilter?.destroy();
    this.contentEl.replaceChildren();
    this.contentEl.classList.add("lfn-dashboard");
    this.contentEl.classList.toggle("lfn-touch", isTouchDevice(this.contentEl));
    const root = el(this.contentEl, "div", "lfn-shell");
    const s = core.summarize(data.records, this.month, core.today(), code);
    const money = value => core.displayMoney(value, code);
    const readyMoney = (value, records, field = "amountCents") => records.some(r => { try { currency.amount(r, field, code); return false; } catch (_) { return true; } }) ? "待补全" : money(value);
    const postedFor = kinds => s.transactions.filter(r => r.date <= core.today() && kinds.includes(r.kind));
    const expenseMoney = readyMoney(s.grossExpense, postedFor(["expense"])), refundMoney = readyMoney(s.refund, postedFor(["refund"]));
    const header = el(root, "div", "lfn-header lfn-app-header");
    const identity = el(header, "div", "lfn-brand-identity"); brand(identity);
    const title = el(identity, "div", "lfn-title");
    el(title, "h1", "lfn-brand", "My Pocket");
    el(title, "p", "lfn-help lfn-tagline", "你的口袋管家。");
    const dock = el(header, "div", "lfn-action-dock");
    const actions = el(dock, "div", "lfn-actions lfn-main-actions");
    actions.setAttribute("role", "group"); actions.setAttribute("aria-label", "记账与账本");
    decorate(button(actions, "记支出", () => this.record("expense"), "lfn-primary"), "plus");
    if (incomeEnabled) decorate(button(actions, "收入", () => this.record("income")), "income", { description: "记收入" });
    if (investmentEnabled) decorate(button(actions, "理财", () => this.record("investment")), "investment", { description: "理财持仓" });
    decorate(button(actions, "固定支出", () => new FixedExpensesModal(p, this.month.slice(0, 4)).open()), "repeat");
    if (core.featureEnabled(p.settings, "project")) decorate(button(actions, "专项", () => p.openProjectView(), "", p), "projects", { description: "专项账本" });
    const utilities = el(dock, "div", "lfn-actions lfn-utility-actions");
    utilities.setAttribute("role", "group"); utilities.setAttribute("aria-label", "随手工具");
    decorate(button(utilities, "计算器", () => new CalculatorModal(p).open()), "calculator", { iconOnly: true });
    decorate(button(utilities, "备忘录", () => p.openMemo(), "", p), "memo", { iconOnly: true });
    decorate(button(utilities, "设置", () => new PersonalizationSettingsModal(p).open()), "settings", { iconOnly: true, description: "个性化设置" });
    const nav = el(root, "div", "lfn-monthbar lfn-dashboard-monthbar");
    const monthNavigation = el(nav, "div", "lfn-month-navigation");
    monthNavigation.setAttribute("role", "group"); monthNavigation.setAttribute("aria-label", "统计月份切换");
    const previousMonth = button(monthNavigation, "‹", async () => { const value = core.shiftMonth(this.month, -1); if (core.validMonth(value)) { this.month = value; await this.render(); } }, "lfn-month-step", p);
    previousMonth.setAttribute("aria-label", "上一月"); previousMonth.title = "上一月"; previousMonth.disabled = this.month === "1900-01";
    const monthInput = inputField(monthNavigation, "统计月份", "month", this.month, "month");
    monthInput.parentElement.classList.add("lfn-month-picker");
    monthInput.setAttribute("aria-label", "统计月份"); monthInput.title = "选择统计月份";
    monthInput.min = "1900-01";
    monthInput.max = "9999-12";
    if (monthInput.type !== "month") {
      monthInput.inputMode = "numeric";
      monthInput.placeholder = "YYYY-MM";
      monthInput.setAttribute("aria-label", "统计月份，格式 YYYY-MM，也可用左右按钮切换");
    }
    monthInput.addEventListener("change", () => { if (core.validMonth(monthInput.value)) { this.month = monthInput.value; p.run(() => this.render()); } else monthInput.value = this.month; });
    const nextMonth = button(monthNavigation, "›", async () => { const value = core.shiftMonth(this.month, 1); if (core.validMonth(value)) { this.month = value; await this.render(); } }, "lfn-month-step", p);
    nextMonth.setAttribute("aria-label", "下一月"); nextMonth.title = "下一月"; nextMonth.disabled = this.month === "9999-12";
    button(nav, "回到本月", async () => { this.month = core.today().slice(0, 7); await this.render(); }, "lfn-month-today", p);
    if (p.settings.multiCurrencyEnabled) {
      const reportCode = selectField(nav, "汇总币种", "dashboard_currency", Object.entries(currency.CURRENCIES), code);
      reportCode.addEventListener("change", () => p.run(async () => { await p.setSettings({ reportCurrency: reportCode.value }); await this.render(); }));
    }
    const navEnd = el(nav, "div", "lfn-nav-end");
    decorate(button(navEnd, "生成月报", async () => { const file = await p.report(this.month); await p.openPath(file.path); new Notice("月报已保存，手写复盘已保留"); }, "", p), "report", { description: "生成 / 更新月报" });
    const monthFile = p.store.monthlyFile(this.month);
    if (monthFile) decorate(noteButton(navEnd, monthFile.path, p, "月流水"), "note", { description: "打开本月流水" });
    decorate(button(navEnd, "刷新", () => { p.store.invalidate(); return this.render(); }, "", p), "refresh", { iconOnly: true });
    if (data.warnings.length) {
      const warning = el(root, "details", "lfn-warning");
      el(warning, "summary", "", `${data.warnings.length} 处数据问题，合计可能不完整（点击检查）`);
      for (const item of data.warnings) {
        const row = el(warning, "p");
        noteButton(row, item.path, p, item.path);
        el(row, "span", "", ` — ${item.message}`);
      }
    }
    const cards = el(root, "div", "lfn-stats");
    const statCount = 1 + (incomeEnabled ? 2 : 0) + (investmentEnabled ? 1 : 0);
    cards.classList.toggle("lfn-stats-single", statCount === 1);
    cards.style.setProperty("--lfn-stat-columns", statCount); cards.style.setProperty("--lfn-stat-mobile-columns", Math.min(statCount, 2));
    const period = this.month === core.today().slice(0, 7) ? "本月" : "所选月份";
    if (incomeEnabled) stat(cards, `${period}收入`, readyMoney(s.income, postedFor(["income"])), investmentEnabled ? "实际收入，含已到账理财收益" : "实际到账的收入", "lfn-income");
    stat(cards, `${period}日常净支出`, readyMoney(s.expenses, postedFor(["expense", "refund"])), `消费 ${expenseMoney} · 退款 ${refundMoney}`);
    if (incomeEnabled) stat(cards, "日常收支结余", readyMoney(s.net, postedFor(["income", "expense", "refund"])), "收入 − 日常净支出，未扣专项费用");
    if (investmentEnabled) stat(cards, "正在理财的本金", readyMoney(s.principal, s.investments, "principalCents"), `当前 ${s.investments.length} 项持仓，与所选月份无关`, "lfn-investment");
    if (s.missingFx.length) el(root, "p", "lfn-warning", `${s.missingFx.length} 笔账目缺少汇率，对应金额暂未计入汇总。原币记录保留，请${p.settings.multiCurrencyEnabled ? "联网刷新" : "在设置中开启多币种记账"}后查看完整合计。`);
    if (s.future.length) el(root, "p", "lfn-callout", `所选月份有 ${s.future.length} 笔未来日期记录，尚未计入收支统计。`);
    const chartSummary = spendingSummary(data.records, this.month, core.today(), code);
    const overview = el(root, "div", "lfn-overview lfn-chart-panels");
    const categories = el(overview, "section", "lfn-panel");
    const categoryHeading = heading(categories, "钱花在哪里");
    const chartControls = el(categoryHeading, "div", "lfn-chart-controls");
    const names = spendingCategories(data.records, chartSummary.year, chartSummary.asOf);
    const scopeButtons = el(chartControls, "div", "lfn-chart-scopes"); scopeButtons.setAttribute("role", "group"); scopeButtons.setAttribute("aria-label", "类别占比统计范围");
    const categoryBody = el(categories, "div");
    const trend = el(overview, "section", "lfn-panel");
    const trendHeading = heading(trend, "支出趋势", `${chartSummary.year}年 · 每月净支出`);
    const trendBody = el(trend, "div");
    let trendMonth = this.trendMonth || this.month;
    const drawCharts = () => {
      for (const choice of scopeButtons.children) {
        const active = choice.dataset.scope === this.categoryScope;
        choice.classList.toggle("lfn-primary", active); choice.setAttribute("aria-pressed", String(active));
      }
      const label = this.categoryScope === "year" ? `${chartSummary.year}年` : `${this.month.slice(0, 4)}年${Number(this.month.slice(5))}月`;
      const filtered = this.chartCategories !== null;
      const totals = filtered ? spendingSummary(data.records, this.month, chartSummary.asOf, code, this.chartCategories) : chartSummary;
      const selectionEmpty = filtered && !names.some(name => this.chartCategories.has(name));
      renderCategoryChart(categoryBody, this.categoryScope === "year" ? totals.yearly : totals.monthly, label, code, filtered, selectionEmpty);
      trendHeading.querySelector(".lfn-help").textContent = `${chartSummary.year}年 · ${filtered ? "所选类别" : "每月净支出"}`;
      renderTrendChart(trendBody, totals, trendMonth, code, { filtered, selectionEmpty, onSelect: month => { trendMonth = month; this.trendMonth = month; } });
    };
    for (const [scope, text] of [["month", this.month === core.today().slice(0, 7) ? "本月" : "所选月份"], ["year", chartSummary.year === core.today().slice(0, 4) ? "今年" : `${chartSummary.year}年`]]) {
      const choice = button(scopeButtons, text, () => { this.categoryScope = scope; drawCharts(); }); choice.dataset.scope = scope;
    }
    this.chartFilter = createCategoryFilter(chartControls, names, this.chartCategories, selection => { this.chartCategories = selection; drawCharts(); });
    chartControls.insertBefore(chartControls.lastElementChild, scopeButtons);
    drawCharts();
    const daily = el(root, "section", "lfn-panel");
    heading(daily, "每天的消费", "按日期查看净支出");
    if (!s.days.length) empty(daily, "从今天开始", "日期默认今天，也可以补记之前的消费。");
    else {
      const list = el(daily, "div", "lfn-daily-list");
      for (const [date, amount] of s.days) {
        const row = el(list, "div", "lfn-line lfn-day-row");
        el(row, "span", "", date);
        el(row, "strong", "", money(amount));
      }
    }
    const fixedPanel = el(root, "section", "lfn-panel");
    const fixedHeading = heading(fixedPanel, `${this.month.slice(0, 4)} 年固定支出`, "年费与月付清单");
    button(fixedHeading, "管理年度清单", () => new FixedExpensesModal(p, this.month.slice(0, 4)).open());
    const annual = fixed.summarize(data.fixedEntries.filter(e => !e.projectId), data.records, this.month.slice(0, 4), core.today(), code);
    el(fixedPanel, "p", "lfn-help", annual.entries.length ? `${annual.active.length} 项启用 · 本年计划 ${annual.missingFx.some(e => e.cycle) ? "待补全" : money(annual.planned)} · 已记固定支出 ${annual.missingFx.some(e => !e.cycle) ? "待补全" : money(annual.actual)}。${p.settings.multiCurrencyEnabled ? "外币计划按当前汇率估算；" : ""}实际付款已包含在上方的月度支出中。` : "把网盘、电视会员等加入年度清单，明年可直接沿用；付款后才计入月度支出。");
    if (annual.missingFx.length) el(fixedPanel, "p", "lfn-warning", `部分历史固定支出缺少汇率，计划或付款合计暂不完整。请${p.settings.multiCurrencyEnabled ? "联网刷新" : "在设置中开启多币种记账"}。`);
    const transactions = el(root, "section", "lfn-panel");
    const transactionHeading = heading(transactions, incomeEnabled ? "收支记录" : "支出记录", `${s.transactions.length} 笔 · 同月共用一篇流水笔记`);
    button(transactionHeading, "跨月查账", () => p.openHistory({ scope: "daily", projectId: "", type: this.filter, category: this.expenseCategory, search: this.search }), "lfn-link-button", p);
    const toolbar = el(transactions, "div", "lfn-record-toolbar");
    const filters = el(toolbar, "div", "lfn-filters");
    const search = inputField(filters, "搜索", "search", this.search, "search");
    search.placeholder = "日期、金额或备注";
    if (!incomeEnabled && this.filter === "income") this.filter = "all";
    const type = selectField(filters, "类型", "type", [["all", "全部"], ["expense", "支出"], ["refund", "退款"], ["income", "收入"]].filter(([kind]) => core.featureEnabled(settings, kind)), this.filter);
    type.parentElement.classList.add("lfn-type-filter");
    const expenseCategories = transactionFilters.expenseCategories(s.transactions, this.month, p.categories("expense"));
    if (!expenseCategories.includes(this.expenseCategory)) this.expenseCategory = "";
    const category = selectField(filters, "消费类型", "expense_category", [["", "全部消费类型"], ...expenseCategories.map(name => [name, name])], this.expenseCategory);
    category.parentElement.classList.add("lfn-category-filter");
    category.parentElement.hidden = this.filter !== "expense";
    const summary = el(toolbar, "aside", "lfn-record-summary");
    summary.setAttribute("aria-label", "筛选汇总");
    summary.setAttribute("aria-live", "polite");
    const recordList = el(transactions, "div", "lfn-record-list");

    const drawList = () => {
      recordList.replaceChildren();
      const selected = transactionFilters.selection(s.transactions, this.month, { type: this.filter, category: this.expenseCategory, search: this.search, asOf: core.today(), code });
      const { list, totals, monthTotals, categoryTotals } = selected;
      const value = (total, field) => total.missingFx.some(r => (r.kind === "expense" ? "grossExpense" : r.kind) === field) ? "待补全" : money(total[field]);
      const field = this.filter === "income" ? "income" : this.filter === "refund" ? "refund" : "grossExpense";
      const label = this.filter === "income" ? "收入" : this.filter === "refund" ? "退款" : "支出";
      summary.replaceChildren();
      const primary = el(summary, "div", "lfn-record-summary-main");
      el(primary, "span", "lfn-help", `筛选${label}合计`);
      el(primary, "strong", "lfn-record-summary-value", value(totals, field));
      el(primary, "span", "lfn-help lfn-record-summary-count", `${list.length} 笔`);
      if (field === "grossExpense") {
        const note = el(primary, "span", "lfn-help lfn-record-summary-note", "退款前");
        note.title = "支出为退款前金额，退款单独计算";
      }
      const references = el(summary, "div", "lfn-record-summary-details");
      const reference = (name, total, field) => {
        const row = el(references, "div", "lfn-record-summary-line");
        el(row, "span", "", name);
        el(row, "strong", "", value(total, field));
      };
      if (this.filter === "all") {
        if (incomeEnabled) reference("收入", totals, "income");
        reference("退款", totals, "refund");
      }
      if (this.filter === "expense" && this.expenseCategory) {
        reference(`${period}「${this.expenseCategory}」`, categoryTotals, "grossExpense");
      }
      reference(`${period}全部${label}`, monthTotals, field);
      if (totals.futureCount) el(summary, "div", "lfn-help lfn-record-summary-message", `${totals.futureCount} 笔未来记录尚未计入合计`);
      if (totals.missingFx.length) el(summary, "div", "lfn-error lfn-record-summary-message", `${totals.missingFx.length} 笔缺少汇率，相关合计待补全`);
      if (!list.length) { empty(recordList, s.transactions.length ? "没有符合条件的记录" : "这个月还没有账目", s.transactions.length ? "试试其他筛选条件，或清空搜索。" : incomeEnabled ? "点击右上方「记支出」或「记收入」开始。" : "点击右上方「记支出」开始。"); return; }
      const visible = this.showAllRecords ? list : list.slice(0, 10);
      const fragment = recordList.ownerDocument.createDocumentFragment();
      for (const r of visible) {
        const row = el(fragment, "div", "lfn-record");
        const desc = el(row, "div", "lfn-record-description");
        const line = el(desc, "div", "lfn-line-title");
        el(line, "strong", "", r.date);
        if (r.date > core.today()) el(line, "span", "lfn-chip-static", "未来记录");
        if (r.memo) el(desc, "div", "lfn-help", r.memo);
        const shownAmount = el(row, "strong", `lfn-record-amount ${r.kind === "expense" ? "" : "lfn-positive"}`, `${r.kind === "expense" ? "−" : "+"}${core.displayMoney(r.amountCents, r.currency)}`);
        shownAmount.title = `${currency.CURRENCIES[r.currency]}${p.settings.multiCurrencyEnabled && r.fx ? `；汇率日期 ${r.fx.date}` : ""}；实际金额可在编辑或笔记中查看`;
        const controls = el(row, "div", "lfn-record-controls");
        receiptButton(controls, r, p);
        noteButton(controls, r.path, p, "打开月笔记");
        button(controls, "编辑", () => new RecordModal(p, r.kind, r.original || r).open());
        button(controls, "回收站", () => new TrashModal(p, r.original || r).open(), "lfn-subtle-danger");
      }
      recordList.appendChild(fragment);
      if (list.length > 10) {
        const footer = el(recordList, "div", "lfn-record-list-footer");
        el(footer, "span", "lfn-help", `已显示 ${visible.length} / ${list.length} 条`);
        const toggle = button(footer, this.showAllRecords ? "收起" : "显示全部", () => {
          this.showAllRecords = !this.showAllRecords; drawList();
          if (!this.showAllRecords) transactions.scrollIntoView({ block: "start" });
        }, "lfn-record-list-toggle");
        toggle.setAttribute("aria-expanded", String(this.showAllRecords));
        if (this.showAllRecords) toggle.setAttribute("aria-label", "收起，仅显示最近 10 条");
      }
    };
    search.addEventListener("input", () => { this.search = search.value; this.showAllRecords = false; drawList(); });
    type.addEventListener("change", () => {
      this.filter = type.value; this.expenseCategory = ""; category.value = "";
      category.parentElement.hidden = this.filter !== "expense";
      this.showAllRecords = false; drawList();
    });
    category.addEventListener("change", () => { this.expenseCategory = category.value; this.showAllRecords = false; drawList(); });
    drawList();
    if (investmentEnabled) {
      const investments = el(root, "section", "lfn-panel");
      const investHeading = heading(investments, "理财持仓", "当前持仓 · 手动更新估值");
      button(investHeading, this.includeClosed ? "隐藏已结束" : "查看已结束", () => { this.includeClosed = !this.includeClosed; return this.render(); }, "", p);
      const valuedRecords = s.investments.filter(r => r.currentValueCents !== null && r.valuationDate <= core.today());
      const valuation = readyMoney(s.valuation, valuedRecords, "currentValueCents"), valuedPrincipal = readyMoney(s.valuedPrincipal, valuedRecords, "principalCents");
      el(investments, "p", "lfn-help", `已填写生效估值 ${valuedRecords.length}/${s.investments.length} 项：估值合计 ${valuation} · 对应本金 ${valuedPrincipal} · 浮动盈亏 ${valuation === "待补全" || valuedPrincipal === "待补全" ? "待补全" : money(s.unrealized)}。未估值项目不参与盈亏计算。`);
      const holdings = data.records.filter(r => r.kind === "investment" && (this.includeClosed || r.status === "active")).sort((a, b) => a.name.localeCompare(b.name, "zh-CN"));
      if (!holdings.length) empty(investments, "记录你正在理财的资金", "填写产品名称和目前在投本金即可；有估值时再补上。");
      else for (const r of holdings) {
        const row = el(investments, "div", "lfn-holding");
        const desc = el(row, "div", "lfn-holding-description");
        el(desc, "strong", "", r.name);
        const status = r.status === "closed" ? "已结束" : r.date > core.today() ? "未来持仓 · 未计入" : "正在理财";
        el(desc, "div", "lfn-help", `${r.category} · ${r.account || "未指定平台"} · ${status}${r.dueDate ? ` · 到期 ${r.dueDate}` : ""}`);
        const amounts = el(row, "div", "lfn-holding-amounts");
        el(amounts, "div", "", `本金 ${core.displayMoney(r.principalCents, r.currency)}`);
        el(amounts, "div", "lfn-help", r.currentValueCents === null ? "尚未填写估值" : `估值 ${core.displayMoney(r.currentValueCents, r.currency)} · ${r.valuationDate}${r.valuationDate > core.today() ? "（未来估值，未计入）" : ""}`);
        const controls = el(row, "div", "lfn-record-controls");
        noteButton(controls, r.path, p);
        button(controls, "更新持仓", () => new RecordModal(p, "investment", r.original || r).open());
        button(controls, "回收站", () => new TrashModal(p, r.original || r).open(), "lfn-subtle-danger");
      }
    }
    const footer = el(root, "div", "lfn-footer");
    el(footer, "span", "", `日常统计不含专项费用。金额向上取整显示，按实际金额统计${p.settings.multiCurrencyEnabled ? "；收支明细保留原币" : ""}。所有账目保存在本地 Markdown。 `);
    button(footer, "使用指南", () => p.openGuide(), "lfn-link-button", p);
    button(footer, "数据恢复", () => new DataRecoveryModal(p).open(), "lfn-link-button", p);
    restoreViewState(this.contentEl, transient);
  }
}

class FinanceSettingsTab extends PluginSettingTab {
  constructor(app, plugin) { super(app, plugin); this.plugin = plugin; }
  display() {
    const p = this.plugin;
    this.containerEl.replaceChildren();
    this.containerEl.classList.add("lfn-settings");
    this.containerEl.classList.toggle("lfn-touch", isTouchDevice(this.containerEl));
    el(this.containerEl, "h2", "", p.manifest.name);
    el(this.containerEl, "p", "lfn-help", "账目存放在 Markdown 笔记中。这里的设置仅保存目录、常用分类和界面偏好。");
    const folder = inputField(this.containerEl, "数据目录", "folder", p.settings.folder, "text", "相对于当前仓库。更改目录会切换账本；原目录的笔记保留，需自行移动后才能在新目录中统计。");
    const error = el(this.containerEl, "div", "lfn-error");
    button(this.containerEl, "应用数据目录", async () => {
      try {
        const next = core.normalizeFolder(folder.value);
        await p.setSettings({ folder: next });
        error.textContent = "";
        p.invalidate();
        new Notice(`账本目录已切换为 ${next}`);
      } catch (e) { error.textContent = e.message; }
    });
    button(this.containerEl, "个性化设置", () => new PersonalizationSettingsModal(p).open(), "lfn-primary");
    el(this.containerEl, "p", "lfn-help", "在个性化设置中开关收入与理财功能，管理分类和付款方式。");
    const currencyToggleWrap = el(this.containerEl, "label", "lfn-toggle");
    const currencyToggle = el(currencyToggleWrap, "input"); currencyToggle.type = "checkbox"; currencyToggle.name = "multi_currency_enabled"; currencyToggle.checked = p.settings.multiCurrencyEnabled;
    el(currencyToggleWrap, "span", "", "启用多币种记账");
    el(this.containerEl, "p", "lfn-help", "默认关闭，使用人民币。开启后可选择记账与汇总币种，并显示汇率换算和手动汇率。关闭后已有账目和货币偏好保留。");
    currencyToggle.addEventListener("change", () => p.run(async () => {
      await p.setSettings({ multiCurrencyEnabled: currencyToggle.checked }); p.invalidate(); this.display();
    }));
    if (p.settings.multiCurrencyEnabled) button(this.containerEl, "货币设置", () => new PersonalizationSettingsModal(p, "currency").open());
    const toggleWrap = el(this.containerEl, "label", "lfn-toggle");
    const toggle = el(toggleWrap, "input");
    toggle.type = "checkbox";
    toggle.checked = p.settings.openNoteAfterSave;
    toggle.addEventListener("change", () => p.run(() => p.setSettings({ openNoteAfterSave: toggle.checked })));
    el(toggleWrap, "span", "", "保存后自动打开原始笔记");
    button(this.containerEl, "打开财务面板", () => p.activateView(), "lfn-primary", p);
  }
}

const { DataRecoveryModal } = require("./recovery-ui").createRecoveryUI({ PocketModal, el, button, empty, noteButton });
const { TemplatesManagerModal, TemplateEditorModal, createTemplatePicker, createTemplateManager } = require("./templates-ui").createTemplatesUI({ PocketModal, el, button, inputField, selectField, empty });
const { PROJECT_VIEW_TYPE, ProjectView, ProjectMetadataModal, ProjectRecordModal, ProjectMigrationModal, ProjectActionModal } = require("./projects-ui").createProjectUI({ PocketModal, el, button, inputField, selectField, suggestField, refreshSuggestions, accountField, currencyControl, heading, stat, empty, noteButton, isTouchDevice, PersonalizationSettingsModal, CalculatorModal, FixedExpensesModal, createTemplatePicker });
module.exports = { TemplatesManagerModal, TemplateEditorModal, TrashModal, ProjectActionModal, DataRecoveryModal, VIEW_TYPE, PROJECT_VIEW_TYPE, ProjectView, ProjectMetadataModal, ProjectRecordModal, ProjectMigrationModal, FinanceView, RecordModal, PersonalizationSettingsModal, FixedExpensesModal, FixedEntryModal, FixedPaymentModal, CalculatorModal, MemoModal, FinanceSettingsTab };
