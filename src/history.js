"use strict";
const core = require("./core"), currency = require("./currency");
const PRESETS = [["month", "本月"], ["3months", "最近 3 个月"], ["6months", "最近 6 个月"], ["year", "今年"], ["custom", "自定义日期"]];
const KINDS = ["expense", "refund", "income"];

function normalizeFilters(value = {}) {
  const text = key => typeof value[key] === "string" ? value[key] : "";
  return {
    preset: PRESETS.some(([id]) => id === value.preset) ? value.preset : "6months",
    start: text("start"), end: text("end"),
    scope: ["daily", "projects", "project"].includes(value.scope) ? value.scope : "daily",
    projectId: text("projectId"), type: ["all", ...KINDS].includes(value.type) ? value.type : "all",
    category: text("category"), search: text("search")
  };
}
function resolveRange(filters, asOf = core.today()) {
  if (!core.validDate(asOf)) throw new Error("统计日期无效");
  const f = normalizeFilters(filters), month = asOf.slice(0, 7);
  let start, end = asOf;
  if (f.preset === "custom") {
    start = f.start; end = f.end;
    if (!core.validDate(start) || !core.validDate(end)) throw new Error("请填写有效的开始与结束日期（1900–9999 年）");
    if (start > end) throw new Error("开始日期不能晚于结束日期");
  } else if (f.preset === "year") start = `${asOf.slice(0, 4)}-01-01`;
  else {
    const offset = f.preset === "3months" ? -2 : f.preset === "6months" ? -5 : 0;
    start = `${core.shiftMonth(month, offset)}-01`;
    if (start < "1900-01-01") start = "1900-01-01";
  }
  return { start, end, postedEnd: end < asOf ? end : asOf, asOf };
}
function inScope(record, filters, incomeEnabled = true) {
  if (!KINDS.includes(record.kind) || (!incomeEnabled && record.kind === "income")) return false;
  const isProject = Boolean(record.projectId) || record.storage === "project";
  if (filters.scope === "daily") return !isProject;
  if (!isProject || record.kind === "income") return false;
  return filters.scope === "projects" || (filters.scope === "project" && Boolean(filters.projectId) && record.projectId === filters.projectId);
}
function categoryOptions(records, filters, { incomeEnabled = true } = {}) {
  const f = normalizeFilters(filters);
  return [...new Set(records.filter(r => inScope(r, f, incomeEnabled) && (f.type === "all" || r.kind === f.type)).map(r => r.category).filter(Boolean))].sort((a, b) => a.localeCompare(b, "zh-CN"));
}
function totals(records, code) {
  const result = { grossExpense: 0, refund: 0, income: 0, netExpense: 0, count: records.length, missingFx: [], incomplete: { grossExpense: false, refund: false, income: false, netExpense: false } };
  for (const r of records) {
    const field = r.kind === "expense" ? "grossExpense" : r.kind;
    let amount;
    try { amount = currency.amount(r, "amountCents", code); }
    catch (_) { result.missingFx.push(r); result.incomplete[field] = true; continue; }
    if (!Number.isSafeInteger(amount) || !Number.isSafeInteger(result[field] + amount)) throw new Error("查询合计超出安全金额范围");
    result[field] += amount;
  }
  result.netExpense = result.grossExpense - result.refund;
  if (!Number.isSafeInteger(result.netExpense)) throw new Error("查询合计超出安全金额范围");
  result.incomplete.netExpense = result.incomplete.grossExpense || result.incomplete.refund;
  return result;
}
function selection(records, filters, { asOf = core.today(), code = "CNY", incomeEnabled = true } = {}) {
  if (!currency.validCurrency(code)) throw new Error("汇总币种无效");
  const f = normalizeFilters(filters), range = resolveRange(f, asOf), needle = f.search.trim().toLocaleLowerCase();
  if (f.scope === "project" && !f.projectId) throw new Error("请选择一个专项账本");
  const list = records.filter(r => inScope(r, f, incomeEnabled) && core.validDate(r.date)
    && r.date >= range.start && r.date <= range.postedEnd
    && (f.type === "all" || r.kind === f.type) && (!f.category || r.category === f.category)
    && `${r.date} ${r.category} ${r.memo || ""} ${core.decimal(r.amountCents)} ${core.displayMoney(r.amountCents, r.currency)} ${r.currency}`.toLocaleLowerCase().includes(needle))
    .sort((a, b) => b.date.localeCompare(a.date) || (b.path || "").localeCompare(a.path || "") || (b.offset || 0) - (a.offset || 0) || String(b.id).localeCompare(String(a.id)));
  return { list, totals: totals(list, code), range, filters: f };
}
module.exports = { PRESETS, normalizeFilters, resolveRange, inScope, categoryOptions, selection };
