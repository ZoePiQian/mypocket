"use strict";
const core = require("./core"), table = require("./monthly"), currency = require("./currency");
const appearance = require("./project-appearance");

function projectId(value, optional = false) {
  if (optional && (value == null || value === "")) return "";
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(value)) throw new Error("专项 ID 无效");
  return value;
}
function nameKey(value) { return String(value).trim().normalize("NFKC").toLowerCase(); }
function fileName(value) {
  const name = String(value ?? "").trim();
  if (!name || name.length > 120 || /^[.]/.test(name) || /[. ]$/.test(name)
    || /[\\/:*?"<>|\[\]#^\x00-\x1f]/.test(name)
    || /^(con|prn|aux|nul|clock\$|conin\$|conout\$|com[0-9¹²³]|lpt[0-9¹²³])(?:\.|$)/i.test(name)) {
    throw new Error('专项名称须为 1–120 字，不能以点开头或结尾，不能使用文件名保留字或 \\ / : * ? " < > | [ ] # ^ 等字符');
  }
  return `${name}.md`;
}
function validate(value, path = "") {
  const id = projectId(value.id), name = String(value.name ?? "").trim();
  if (!name || name.length > 120 || /[\r\n\x00-\x1f]/.test(name)) throw new Error("专项名称须为 1–120 字的单行文字");
  if (!["active", "archived"].includes(value.status)) throw new Error("专项状态无效");
  const startDate = value.startDate || "";
  if (startDate && !core.validDate(startDate)) throw new Error("开始日期无效");
  if (!currency.validCurrency(value.currency || "CNY")) throw new Error("预算币种无效");
  const categories = value.categories ?? [];
  if (!Array.isArray(categories) || categories.length > 100 || categories.some(v => typeof v !== "string" || !v.trim() || v.length > 120 || /[\r\n\x00-\x1f]/.test(v))) throw new Error("分类须为不重复的单行文字，最多 100 个");
  const description = value.description || "";
  if (typeof description !== "string" || description.length > 2000) throw new Error("专项说明最多 2000 字");
  const budgetCents = value.budget == null || value.budget === "" ? null : core.moneyToCents(value.budget, true);
  const budgetDate = value.budgetDate || core.today();
  if (!core.validDate(budgetDate)) throw new Error("预算日期无效");
  const budgetFx = value.budgetFx == null ? null : currency.snapshot(value.budgetFx, budgetDate);
  return { id, name, status: value.status, startDate, currency: value.currency || "CNY", budgetCents, budgetDate, budgetFx, categories: [...new Set(categories.map(v => v.trim()))], description, ...appearance.normalize(value), path };
}
function metadata(p) {
  return { finance_schema: 3, finance_kind: "project", id: p.id, name: p.name, status: p.status, start_date: p.startDate || null,
    budget: p.budgetCents == null ? null : core.decimal(p.budgetCents), currency: p.currency, budget_date: p.budgetDate, budget_fx: p.budgetFx,
    categories: p.categories, description: p.description, cover_icon: appearance.normalize(p).coverIcon, cover_color: appearance.normalize(p).coverColor };
}
function signature(p) { return JSON.stringify(metadata(p)); }
function parse(text, path, codec) {
  const fm = core.readFrontmatter(text, codec.parseYaml);
  if (fm?.finance_schema !== 3 || fm.finance_kind !== "project") throw new Error("不是有效的专项笔记");
  const p = validate({ ...fm, startDate: fm.start_date, budgetDate: fm.budget_date, budgetFx: fm.budget_fx, coverIcon: fm.cover_icon, coverColor: fm.cover_color }, path);
  const parsed = table.parseTable(text, path);
  if (parsed.records.some(r => !["expense", "refund"].includes(r.kind))) throw new Error("专项仅支持支出与退款，收入请保留在日常流水");
  const records = parsed.records.map(r => ({ ...r, storage: "project", projectId: p.id }));
  return { ...parsed, records, project: { ...p, frontmatter: fm } };
}
function create(p, codec) {
  return `---\n${codec.stringifyYaml({ ...metadata(p), tags: ["财务", "专项"] }).trimEnd()}\n---\n\n# ${p.name.replace(/[\r\n]/g, " ")}\n\n本专项独立统计，不计入日常月流水、日常图表和月报。充值按实际付款记录，使用次数不重复记费。\n\n${table.START}\n${table.HEADER}\n${table.SEPARATOR}\n${table.END}\n\n## 专项说明与凭证\n\n可以在这里补充合同、课程安排、收据、图片和 [[关联笔记]]。表格外的内容由你自由书写。\n`;
}
function updateMetadata(text, p, codec) {
  const fm = core.readFrontmatter(text, codec.parseYaml);
  return text.replace(/^\uFEFF?---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/, `---\n${codec.stringifyYaml({ ...fm, ...metadata(p) }).trimEnd()}\n---\n`);
}
function total(records, code = "CNY", asOf = core.today()) {
  let grossExpense = 0, refund = 0, count = 0, futureCount = 0;
  const missingFx = [], categories = new Map();
  for (const r of records) {
    if (!["expense", "refund"].includes(r.kind)) continue;
    if (r.date > asOf) { futureCount++; continue; }
    let amount;
    try { amount = currency.amount(r, "amountCents", code); } catch (_) { missingFx.push(r); continue; }
    if (r.kind === "expense") grossExpense += amount; else refund += amount;
    const categoryAmount = (categories.get(r.category) || 0) + (r.kind === "refund" ? -amount : amount);
    if (![grossExpense, refund, categoryAmount, grossExpense - refund].every(Number.isSafeInteger)) throw new Error("专项金额合计超出安全范围");
    categories.set(r.category, categoryAmount); count++;
  }
  return { grossExpense, refund, net: grossExpense - refund, count, futureCount, missingFx, categories: [...categories].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], "zh-CN")) };
}
function statistics(records, { from = "", to = "", selectedCategories = null, code = "CNY", asOf = core.today() } = {}) {
  if (!core.validDate(asOf) || !currency.validCurrency(code) || (from && !core.validMonth(from)) || (to && !core.validMonth(to)) || (from && to && from > to)) throw new Error("专项统计范围无效");
  const selected = records.filter(r => (!from || r.date.slice(0, 7) >= from) && (!to || r.date.slice(0, 7) <= to) && (selectedCategories === null || selectedCategories.has(r.category)));
  const ready = records.filter(r => r.date <= asOf), start = from || ready.map(r => r.date.slice(0, 7)).sort()[0] || asOf.slice(0, 7), end = to || asOf.slice(0, 7);
  const months = [];
  for (let key = start; key <= end; key = core.shiftMonth(key, 1)) {
    if (months.length >= 2400) throw new Error("统计跨度超过 200 年，请选择较短范围");
    const s = total(selected.filter(r => r.date.startsWith(key)), code, asOf), future = key > asOf.slice(0, 7);
    months.push({ ...s, month: key, future, incomplete: s.missingFx.length > 0, value: future || s.missingFx.length ? null : s.net });
    if (key === "9999-12") break;
  }
  const summary = total(selected, code, asOf);
  return { period: summary, year: asOf.slice(0, 4), asOf, months, yearly: summary, rangeLabel: from === to && from ? from : from ? `${from} 至 ${end}` : "整个专项周期", longLabels: start.slice(0, 4) !== end.slice(0, 4) };
}
function budgetAmount(p, code) { return p.budgetCents == null ? null : currency.convert(p.budgetCents, p.currency, code, p.budgetFx); }
module.exports = { projectId, nameKey, fileName, validate, metadata, signature, parse, create, updateMetadata, total, statistics, budgetAmount };
