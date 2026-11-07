"use strict";
const core = require("./core");
const currency = require("./currency");

function period() { return { grossExpense: 0, refund: 0, count: 0, missingFx: [], categories: new Map() }; }
function add(a, b) {
  const value = a + b;
  if (!Number.isSafeInteger(value)) throw new Error("图表合计超出安全金额范围");
  return value;
}
function finish(value) {
  return { ...value, net: add(value.grossExpense, -value.refund), categories: [...value.categories].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], "zh-CN")) };
}
function spendingSummary(records, month, asOf = core.today(), code = "CNY", selectedCategories = null) {
  if (!core.validMonth(month) || !core.validDate(asOf) || !currency.validCurrency(code)) throw new Error("图表日期或币种无效");
  const year = month.slice(0, 4), monthly = period(), yearly = period();
  const buckets = Array.from({ length: 12 }, () => period());
  for (const record of records) {
    if (record.projectId || record.storage === "project") continue;
    if (!["expense", "refund"].includes(record.kind) || !record.date.startsWith(year) || record.date > asOf) continue;
    if (selectedCategories !== null && !selectedCategories.has(record.category)) continue;
    const targets = [yearly, buckets[Number(record.date.slice(5, 7)) - 1]];
    if (record.date.startsWith(month)) targets.push(monthly);
    let amount;
    try { amount = currency.amount(record, "amountCents", code); }
    catch (_) { for (const target of targets) target.missingFx.push(record); continue; }
    for (const target of targets) {
      target.count++;
      const field = record.kind === "expense" ? "grossExpense" : "refund";
      target[field] = add(target[field], amount);
      target.categories.set(record.category, add(target.categories.get(record.category) || 0, record.kind === "refund" ? -amount : amount));
    }
  }
  const months = buckets.map((bucket, index) => {
    const key = `${year}-${String(index + 1).padStart(2, "0")}`, total = finish(bucket);
    const future = key > asOf.slice(0, 7), incomplete = total.missingFx.length > 0;
    return { ...total, month: key, future, incomplete, value: future || incomplete ? null : total.net };
  });
  return { year, month, asOf, currency: code, monthly: finish(monthly), yearly: finish(yearly), months };
}

// Include historical names and refund-only categories, even when a quote is missing.
function spendingCategories(records, year, asOf = core.today()) {
  return [...new Set(records.filter(record => !record.projectId && record.storage !== "project" && ["expense", "refund"].includes(record.kind) && record.date.startsWith(`${year}-`) && record.date <= asOf).map(record => record.category))].sort((a, b) => a.localeCompare(b, "zh-CN"));
}

function categorySlices(categories, limit = 6) {
  if (!Number.isInteger(limit) || limit < 2) throw new Error("分类数量无效");
  const positive = categories.filter(([, amount]) => amount > 0).map(([name, amount]) => ({ name, amount }));
  const negative = categories.filter(([, amount]) => amount < 0).map(([name, amount]) => ({ name, amount }));
  const total = positive.reduce((sum, item) => add(sum, item.amount), 0);
  const grouped = positive.length > limit;
  const slices = grouped ? positive.slice(0, limit - 1) : positive.slice();
  if (grouped) {
    const children = positive.slice(limit - 1);
    slices.push({ name: `其余分类（${children.length}类）`, amount: children.reduce((sum, item) => add(sum, item.amount), 0), children });
  }
  for (const slice of slices) {
    slice.share = slice.amount / total;
    for (const child of slice.children || []) child.share = child.amount / total;
  }
  return { total, slices, negative };
}

function trendLayout(months, width = 480, height = 234) {
  const plot = { left: 66, right: width - 18, top: 20, bottom: height - 38 };
  const values = months.map(item => item.value).filter(value => value !== null);
  const min = Math.min(0, ...values), max = Math.max(0, ...values);
  const rough = (max - min || 100) / 3, power = 10 ** Math.floor(Math.log10(rough));
  const step = Math.max(1, [1, 2, 5, 10].map(value => value * power).find(value => value >= rough));
  const low = Math.floor(min / step) * step, high = Math.ceil(max / step) * step || (low === 0 ? step : 0);
  const y = value => plot.bottom - (value - low) / (high - low) * (plot.bottom - plot.top);
  const points = months.map((item, index) => ({ ...item, x: months.length === 1 ? (plot.left + plot.right) / 2 : plot.left + index / Math.max(1, months.length - 1) * (plot.right - plot.left), y: item.value === null ? null : y(item.value) }));
  const ticks = [];
  for (let value = low; value <= high; value += step) ticks.push({ value, y: y(value) });
  const segments = []; let segment = [];
  for (const point of points) {
    if (point.y === null) { if (segment.length) segments.push(segment); segment = []; }
    else segment.push(point);
  }
  if (segment.length) segments.push(segment);
  return { width, height, plot, points, ticks, segments, zeroY: y(0) };
}
module.exports = { spendingSummary, spendingCategories, categorySlices, trendLayout };
