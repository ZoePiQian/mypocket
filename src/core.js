"use strict";
const currency = require("./currency");
const attachments = require("./attachments");

const TYPES = { expense: "支出", refund: "退款", income: "收入", investment: "理财" };
const DEFAULTS = {
  folder: "财务管理/流水数据",
  expenseCategories: ["外卖", "买菜", "餐饮", "交通", "购物", "住房", "医疗", "娱乐", "学习", "固定支出", "其他"],
  incomeCategories: ["工资", "兼职", "奖金", "理财收益", "其他"],
  investmentCategories: ["基金", "银行理财", "定期存款", "股票", "其他"],
  accounts: ["微信", "支付宝", "银行卡", "现金"],
  incomeEnabled: true,
  investmentEnabled: true,
  projectsEnabled: true,
  multiCurrencyEnabled: false,
  defaultCurrency: "CNY",
  reportCurrency: "CNY",
  openNoteAfterSave: false
};
const REPORT_START = "<!-- local-finance-notes:report:start -->";
const REPORT_END = "<!-- local-finance-notes:report:end -->";
const MANAGED_FIELDS = ["finance_schema", "finance_kind", "id", "date", "currency", "fx", "valuation_fx", "category", "account", "memo", "attachments", "amount", "name", "principal", "current_value", "valuation_date", "status", "due_date", "updated_at"];

function featureEnabled(settings, kind) {
  if (kind === "income") return settings.incomeEnabled !== false;
  if (kind === "investment") return settings.investmentEnabled !== false;
  if (kind === "project") return settings.projectsEnabled !== false;
  return true; // Expense and refund are always available.
}

function today(now = new Date()) {
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
}
function dateValue(value) {
  return value instanceof Date ? value.toISOString().slice(0, 10) : value;
}
function validDate(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [y, m, d] = value.split("-").map(Number);
  if (y < 1900 || y > 9999) return false;
  const t = new Date(Date.UTC(y, m - 1, d));
  return t.getUTCFullYear() === y && t.getUTCMonth() + 1 === m && t.getUTCDate() === d;
}
function validMonth(value) {
  return typeof value === "string" && /^\d{4}-\d{2}$/.test(value) && validDate(`${value}-01`);
}
function shiftMonth(month, delta) {
  if (!validMonth(month)) throw new Error("月份格式应为 YYYY-MM");
  const [y, m] = month.split("-").map(Number);
  const d = new Date(y, m - 1 + delta, 1);
  return today(d).slice(0, 7);
}
function moneyToCents(value, allowZero = false) {
  const text = typeof value === "number" ? String(value) : String(value ?? "").trim();
  if (!/^\d+(?:\.\d{1,2})?$/.test(text)) throw new Error("金额须为非负数字，最多两位小数，例如 32.50");
  const [whole, fraction = ""] = text.split(".");
  const cents = Number(whole) * 100 + Number(fraction.padEnd(2, "0"));
  if (!Number.isSafeInteger(cents) || cents > 99999999999) throw new Error("单笔金额不能超过 999,999,999.99");
  if (!allowZero && cents <= 0) throw new Error("金额须大于 0");
  return cents;
}
function decimal(cents) {
  if (!Number.isSafeInteger(cents)) throw new Error("金额计算超出安全范围");
  return `${cents < 0 ? "-" : ""}${Math.floor(Math.abs(cents) / 100)}.${String(Math.abs(cents) % 100).padStart(2, "0")}`;
}
function money(cents, code = "CNY") { return currency.money(cents, code).replace("−", "-"); }
function displayMoney(cents, code = "CNY") { return currency.money(cents, code, true); }
function sum(values) {
  const result = values.reduce((a, b) => a + b, 0);
  if (!Number.isSafeInteger(result)) throw new Error("合计金额超出安全范围");
  return result;
}
function field(value, label, required = true, max = 120) {
  if (typeof value !== "string" || (required && !value.trim()) || value.length > max || /[\r\n\u0000-\u001f]/.test(value)) throw new Error(`${label}须为${required ? "非空" : ""}单行文字（最多 ${max} 字）`);
  return value.trim();
}
function normalizeFolder(value) {
  const p = String(value || "").trim().replace(/\\/g, "/").replace(/\/+$/, "");
  if (!p || p.startsWith("/") || p.split("/").some(s => !s || s === "." || s === ".." || s.startsWith(".") || /[:*?"<>|\u0000-\u001f]/.test(s))) throw new Error("数据目录须为仓库内的普通相对路径，例如 财务管理/流水数据");
  return p;
}
function safeName(value) {
  const text = value.replace(/[\\/:*?"<>|\[\]#^\u0000-\u001f]/g, "-").replace(/[. ]+$/g, "").slice(0, 45) || "记录";
  return /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(text) ? `_${text}` : text;
}
function categoryKey(kind) {
  return kind === "investment" ? "investmentCategories" : kind === "income" ? "incomeCategories" : "expenseCategories";
}
function changeCategory(list, operation, name, replacement = "") {
  return changeOption(list, operation, name, replacement, "分类");
}
function changeAccount(list, operation, name, replacement = "") {
  return changeOption(list, operation, name, replacement, "付款方式", true);
}
function changeOption(list, operation, name, replacement, label, allowEmpty = false) {
  const current = field(name, `${label}名称`);
  if (operation === "add") {
    if (list.includes(current)) throw new Error(`这个${label}已经存在`);
    return [...list, current];
  }
  if (!list.includes(current)) throw new Error("个性化设置已改变，请重新打开设置");
  if (operation === "remove") {
    if (!allowEmpty && list.length === 1) throw new Error(`至少保留一个${label}`);
    return list.filter(value => value !== current);
  }
  if (operation !== "rename") throw new Error(`未知${label}操作`);
  const next = field(replacement, `${label}名称`);
  if (next !== current && list.includes(next)) throw new Error(`这个${label}已经存在`);
  return list.map(value => value === current ? next : value);
}
function validateRecord(fm, path = "") {
  if (!fm || fm.finance_schema !== 1) throw new Error("不支持的财务笔记版本（finance_schema 须为 1）");
  const kind = fm.finance_kind;
  if (!Object.hasOwn(TYPES, kind)) throw new Error("finance_kind 须为 expense、refund、income 或 investment");
  const id = field(fm.id, "ID");
  const date = dateValue(fm.date);
  if (!validDate(date)) throw new Error("日期须为真实日期，格式 YYYY-MM-DD");
  if (!currency.validCurrency(fm.currency)) throw new Error("currency 须为 CNY、USD 或 JPY");
  const fx = fm.fx == null ? null : currency.snapshot(fm.fx, date);
  if (fm.currency !== "CNY" && !fx) throw new Error("外币账目须保存汇率快照");
  if (fm.memo != null && typeof fm.memo !== "string") throw new Error("备注须为文字；纯数字备注请用引号括起");
  const receiptPaths = attachments.normalizePaths(fm.attachments);
  const record = { id, kind, date, path, currency: fm.currency, fx, category: field(fm.category, "分类"), account: field(fm.account ?? "", "账户", false), memo: typeof fm.memo === "string" ? fm.memo : "", attachments: receiptPaths, frontmatter: { ...fm, attachments: receiptPaths } };
  if (record.memo.length > 2000) throw new Error("备注最多 2000 字；长说明请写在笔记正文");
  if (kind === "investment") {
    record.name = field(fm.name, "理财名称");
    record.principalCents = moneyToCents(fm.principal);
    record.currentValueCents = fm.current_value == null || fm.current_value === "" ? null : moneyToCents(fm.current_value, true);
    record.valuationDate = dateValue(fm.valuation_date) || "";
    if (record.currentValueCents !== null && !validDate(record.valuationDate)) throw new Error("填写当前估值时须填写估值日期");
    if (record.currentValueCents === null && record.valuationDate) throw new Error("有估值日期但缺少当前估值");
    record.valuationFx = fm.valuation_fx == null ? null : currency.snapshot(fm.valuation_fx, record.valuationDate);
    if (record.currentValueCents !== null && fm.currency !== "CNY" && !record.valuationFx) throw new Error("外币估值须保存估值日期的汇率");
    record.status = fm.status;
    if (!["active", "closed"].includes(record.status)) throw new Error("理财状态须为 active 或 closed");
    record.dueDate = dateValue(fm.due_date) || "";
    if (record.dueDate && (!validDate(record.dueDate) || record.dueDate < date)) throw new Error("到期日期须为真实日期，且不早于开始日期");
  } else record.amountCents = moneyToCents(fm.amount);
  return record;
}
function readFrontmatter(text, parseYaml) {
  const match = /^\uFEFF?---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text);
  if (!match) return null;
  return parseYaml(match[1]);
}
function parseRecord(text, path, parseYaml) {
  let fm;
  try { fm = readFrontmatter(text, parseYaml); }
  catch (error) {
    if (/finance_(?:schema|kind)\s*:/.test(text)) throw new Error(`YAML 属性无法读取：${error.message}`);
    return null;
  }
  if (!fm) {
    if (/^\uFEFF?---\r?\n/.test(text) && /^finance_(?:schema|kind)\s*:/m.test(text)) throw new Error("财务笔记的 YAML 区块不完整，请检查开头和结尾的 ---");
    return null;
  }
  if (!Object.hasOwn(fm, "finance_schema") && !Object.hasOwn(fm, "finance_kind")) return null;
  return validateRecord(fm, path);
}
function signature(fm) {
  return JSON.stringify(MANAGED_FIELDS.map(key => [key, key === "attachments" ? attachments.normalizePaths(fm[key]) : fm[key] ?? null]));
}
function deduplicate(records, warnings) {
  const ids = new Map();
  for (const record of records) {
    if (!ids.has(record.id)) ids.set(record.id, []);
    ids.get(record.id).push(record);
  }
  const result = [];
  for (const list of ids.values()) {
    if (list.length === 1) result.push(list[0]);
    else for (const record of list) warnings.push({ path: record.path, message: "ID 重复，暂不计入统计。请删除复制件的财务属性，或给复制件填写独立 ID。" });
  }
  return result;
}
function summarize(records, month, asOf = today(), code = "CNY") {
  if (!validMonth(month) || !validDate(asOf)) throw new Error("统计日期不正确");
  const transactions = records.filter(r => !r.projectId && r.storage !== "project" && r.kind !== "investment" && r.date.startsWith(month));
  const missingFx = [];
  const ready = (r, field) => { try { currency.amount(r, field, code); return true; } catch (_) { missingFx.push(r); return false; } };
  const posted = transactions.filter(r => r.date <= asOf && ready(r, "amountCents"));
  const future = transactions.filter(r => r.date > asOf);
  const amount = (r, field = "amountCents") => currency.amount(r, field, code);
  const income = sum(posted.filter(r => r.kind === "income").map(r => amount(r)));
  const grossExpense = sum(posted.filter(r => r.kind === "expense").map(r => amount(r)));
  const refund = sum(posted.filter(r => r.kind === "refund").map(r => amount(r)));
  const expenses = grossExpense - refund;
  const categories = new Map();
  const days = new Map();
  for (const r of posted) {
    if (r.kind === "income") continue;
    const value = r.kind === "refund" ? -amount(r) : amount(r);
    categories.set(r.category, (categories.get(r.category) || 0) + value);
    days.set(r.date, (days.get(r.date) || 0) + value);
  }
  const investments = records.filter(r => r.kind === "investment" && r.status === "active" && r.date <= asOf);
  const principal = sum(investments.filter(r => ready(r, "principalCents")).map(r => amount(r, "principalCents")));
  const valued = investments.filter(r => r.currentValueCents !== null && r.valuationDate <= asOf && ready(r, "currentValueCents") && ready(r, "principalCents"));
  const valuedPrincipal = sum(valued.map(r => amount(r, "principalCents")));
  const valuation = sum(valued.map(r => amount(r, "currentValueCents")));
  return { month, asOf, currency: code, missingFx: [...new Set(missingFx)], transactions, posted, future, income, grossExpense, refund, expenses, net: income - expenses, categories: [...categories].sort((a, b) => b[1] - a[1]), days: [...days].sort((a, b) => b[0].localeCompare(a[0])), investments, principal, valuation, valuedPrincipal, valuedCount: valued.length, unrealized: valuation - valuedPrincipal };
}
function markdownCell(value) {
  return String(value ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/\|/g, "&#124;").replace(/\r?\n/g, "<br>");
}
function noteLink(path, label = "笔记") {
  const target = encodeURI(path.replace(/\.md$/, "")).replace(/[()\[\]#?]/g, c => encodeURIComponent(c));
  return `[${markdownCell(label).replace(/[\[\]]/g, "")}](${target})`;
}
function reportSection(summary, warnings = []) {
  const s = summary;
  const format = value => money(value, s.currency || "CNY");
  const rows = [...s.posted].sort((a, b) => b.date.localeCompare(a.date) || a.path.localeCompare(b.path));
  return [
    REPORT_START,
    `## ${s.month} 日常收支汇总`,
    "专项账本独立记录，不计入本月日常支出与分类统计。",
    `统计截至 ${s.asOf}；按记录日期统计，汇总币种：${currency.CURRENCIES[s.currency || "CNY"]}。明细保留原币金额；采用各笔账目的汇率快照。`,
    "",
    "| 项目 | 金额 |",
    "| --- | ---: |",
    `| 收入 | ${format(s.income)} |`,
    `| 支出（退款前） | ${format(s.grossExpense)} |`,
    `| 退款 | ${format(s.refund)} |`,
    `| 净支出 | ${format(s.expenses)} |`,
    `| 日常收支结余 | ${format(s.net)} |`,
    "",
    "日常收支结余 = 收入 − 日常净支出，未扣专项费用，不代表银行卡余额。理财本金单独记录；已到账的收益请记为「收入 / 理财收益」。",
    s.future.length ? `另有 ${s.future.length} 笔未来日期记录，尚未计入。` : "",
    warnings.length ? `⚠ 有 ${warnings.length} 处财务数据问题；请在财务面板查看并修正，当前合计可能不完整。` : "",
    "",
    "### 消费分类",
    "| 分类 | 净支出 |",
    "| --- | ---: |",
    ...s.categories.map(([name, value]) => `| ${markdownCell(name)} | ${format(value)} |`),
    ...(s.categories.length ? [] : [`| 暂无记录 | ${format(0)} |`]),
    "",
    "### 每日消费",
    "| 日期 | 净支出 |",
    "| --- | ---: |",
    ...s.days.map(([date, value]) => `| ${date} | ${format(value)} |`),
    "",
    "### 收支明细",
    "| 日期 | 类型 | 分类 | 账户 | 金额 | 备注 | 原始笔记 |",
    "| --- | --- | --- | --- | ---: | --- | --- |",
    ...rows.map(r => `| ${r.date} | ${TYPES[r.kind]} | ${markdownCell(r.category)} | ${markdownCell(r.account)} | ${money(r.amountCents, r.currency)} | ${markdownCell(r.memo)} | ${noteLink(r.path)} |`),
    "",
    `### 理财持仓快照（${s.asOf} 生成时的当前记录）`,
    `正在理财的本金：${format(s.principal)}。这部分是当前持仓快照，不是 ${s.month} 的历史持仓。`,
    `已填写估值的 ${s.valuedCount}/${s.investments.length} 项：估值 ${format(s.valuation)}，对应本金 ${format(s.valuedPrincipal)}，浮动盈亏 ${format(s.unrealized)}。未填写估值的项目不参与盈亏计算。`,
    "",
    "| 产品 | 类型 | 本金 | 当前估值 | 估值日期 | 平台 | 到期日期 | 原始笔记 |",
    "| --- | --- | ---: | ---: | --- | --- | --- | --- |",
    ...s.investments.map(r => `| ${markdownCell(r.name)} | ${markdownCell(r.category)} | ${money(r.principalCents, r.currency)} | ${r.currentValueCents === null ? "未填写" : money(r.currentValueCents, r.currency)} | ${(r.valuationDate || "—") + (r.valuationDate > s.asOf ? "（未来估值，未计入）" : "")} | ${markdownCell(r.account)} | ${r.dueDate || "—"} | ${noteLink(r.path)} |`),
    "",
    REPORT_END
  ].join("\n");
}
function replaceReport(text, section) {
  const start = text.indexOf(REPORT_START);
  const end = text.indexOf(REPORT_END);
  if (start < 0 || end < start || text.indexOf(REPORT_START, start + 1) >= 0 || text.indexOf(REPORT_END, end + 1) >= 0) throw new Error("月报的自动汇总标记缺失或重复。为保留正文，本次未覆盖；请换一个文件名或恢复标记。");
  return text.slice(0, start) + section + text.slice(end + REPORT_END.length);
}

module.exports = { TYPES, DEFAULTS, MANAGED_FIELDS, REPORT_START, REPORT_END, featureEnabled, today, validDate, validMonth, shiftMonth, moneyToCents, decimal, money, displayMoney, normalizeFolder, safeName, categoryKey, changeCategory, changeAccount, validateRecord, readFrontmatter, parseRecord, signature, deduplicate, summarize, markdownCell, noteLink, reportSection, replaceReport };
