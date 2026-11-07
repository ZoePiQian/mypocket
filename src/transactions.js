"use strict";
const core = require("./core");
const currency = require("./currency");
const KINDS = ["expense", "income", "refund"];

function expenseCategories(records, month, preferred = []) {
  return [...new Set([...preferred, ...records.filter(r => r.date.startsWith(month) && r.kind === "expense").map(r => r.category)])];
}
function totals(records, asOf, code) {
  const result = { grossExpense: 0, income: 0, refund: 0, postedCount: 0, futureCount: 0, missingFx: [] };
  for (const record of records) {
    if (record.date > asOf) { result.futureCount++; continue; }
    let amount;
    try { amount = currency.amount(record, "amountCents", code); }
    catch (_) { result.missingFx.push(record); continue; }
    const field = record.kind === "expense" ? "grossExpense" : record.kind;
    const next = result[field] + amount;
    if (!Number.isSafeInteger(next)) throw new Error("筛选合计超出安全金额范围");
    result[field] = next;
    result.postedCount++;
  }
  return result;
}
function selection(records, month, { type = "all", category = "", search = "", asOf = core.today(), code = "CNY" } = {}) {
  if (!core.validMonth(month) || !core.validDate(asOf) || !currency.validCurrency(code) || !["all", ...KINDS].includes(type)) throw new Error("筛选条件无效");
  const monthly = records.filter(r => !r.projectId && r.storage !== "project" && KINDS.includes(r.kind) && r.date.startsWith(month));
  const selectedCategory = type === "expense" ? category : "";
  const needle = search.trim().toLocaleLowerCase();
  const list = monthly.filter(r => (type === "all" || r.kind === type)
    && (!selectedCategory || r.category === selectedCategory)
    && `${r.date} ${core.decimal(r.amountCents)} ${core.displayMoney(r.amountCents, r.currency)} ${r.memo}`.toLocaleLowerCase().includes(needle))
    .sort((a, b) => b.date.localeCompare(a.date) || (b.path || "").localeCompare(a.path || "")
      || (b.offset || 0) - (a.offset || 0) || String(b.id).localeCompare(String(a.id)));
  const monthTotals = totals(monthly, asOf, code);
  return {
    list, totals: totals(list, asOf, code), monthTotals,
    categoryTotals: selectedCategory ? totals(monthly.filter(r => r.kind === "expense" && r.category === selectedCategory), asOf, code) : monthTotals
  };
}
module.exports = { expenseCategories, selection };
