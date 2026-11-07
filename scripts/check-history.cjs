"use strict";
const assert = require("node:assert/strict"), history = require("../src/history");
function record(id, date, amount, kind = "expense", extra = {}) { return { id, date, amountCents: amount, kind, category: "餐饮", currency: "CNY", memo: "虚构查询记录", path: `data/流水/${date.slice(0, 4)}/${date.slice(0, 7)}.md`, offset: 0, ...extra }; }
function register(test) {
  test("history calendar presets cross years, clamp boundaries and include today", () => {
    assert.deepEqual(history.resolveRange({ preset: "6months" }, "2027-02-17"), { start: "2026-09-01", end: "2027-02-17", postedEnd: "2027-02-17", asOf: "2027-02-17" });
    assert.equal(history.resolveRange({ preset: "3months" }, "2026-01-05").start, "2025-11-01");
    assert.equal(history.resolveRange({ preset: "6months" }, "1900-01-01").start, "1900-01-01");
    assert.equal(history.resolveRange({ preset: "year" }, "2024-02-29").start, "2024-01-01");
    assert.equal(history.resolveRange({ preset: "month" }, "9999-12-31").start, "9999-12-01");
    assert.equal(history.resolveRange({ preset: "custom", start: "2024-02-29", end: "2024-03-01" }, "2024-02-29").postedEnd, "2024-02-29");
    for (const [start, end] of [["2023-02-29", "2023-03-01"], ["2026-05-03", "2026-05-01"], ["1899-12-31", "1900-01-01"], ["9999-12-31", "10000-01-01"]]) assert.throws(() => history.resolveRange({ preset: "custom", start, end }));
  });
  test("history category totals cover six months, not only visible ten; expenses and refunds stay separate", () => {
    const records = Array.from({ length: 12 }, (_, i) => record(`r${i}`, "2026-11-07", 101, "expense", { offset: i }));
    records.push(record("june", "2026-06-01", 2000), record("old", "2026-05-31", 90000), record("future", "2026-11-08", 90000), record("today-refund", "2026-11-07", 101, "refund"), record("income", "2026-07-01", 50000, "income", { category: "工资" }), record("other-category", "2026-09-01", 555, "expense", { category: "交通" }));
    const result = history.selection(records, { preset: "6months", category: "餐饮" }, { asOf: "2026-11-07" });
    assert.equal(result.list.length, 14); assert.equal(result.totals.grossExpense, 3212); assert.equal(result.totals.refund, 101); assert.equal(result.totals.netExpense, 3111);
    assert.equal(result.list.filter(r => r.kind === "expense")[0].id, "r11"); assert.equal(result.list.slice(0, 10).length, 10);
    const refund = history.selection(records, { preset: "6months", category: "餐饮", type: "refund" }, { asOf: "2026-11-07" });
    assert.equal(refund.totals.netExpense, -101); assert.equal(refund.totals.grossExpense, 0);
  });
  test("history keeps daily and projects separate, includes archived project records, honors income visibility", () => {
    const entries = [record("daily", "2026-11-01", 1000), record("salary", "2026-11-01", 5000, "income"), record("p1", "2026-11-01", 2000, "expense", { projectId: "p1", storage: "project" }), record("p2-archived", "2026-11-01", 3000, "expense", { projectId: "p2", storage: "project" }), record("invalid-project-income", "2026-11-01", 9000, "income", { projectId: "p2", storage: "project" })];
    const options = { asOf: "2026-11-07" };
    assert.equal(history.selection(entries, {}, options).totals.grossExpense, 1000);
    assert.equal(history.selection(entries, {}, { ...options, incomeEnabled: false }).list.length, 1);
    assert.equal(history.selection(entries, { scope: "projects" }, options).totals.grossExpense, 5000);
    assert.equal(history.selection(entries, { scope: "projects" }, options).totals.income, 0);
    assert.equal(history.selection(entries, { scope: "project", projectId: "p2" }, options).totals.grossExpense, 3000);
    assert.throws(() => history.selection(entries, { scope: "project" }, options));
  });
  test("history search and category choices keep historical names; missing FX marks only affected aggregates", () => {
    const entries = [record("unknown", "2026-10-01", 125, "expense", { currency: "USD", category: "旧分类", memo: "午餐账单" }), record("known", "2026-10-01", 123, "refund", { category: "旧分类" }), record("salary", "2026-10-01", 9876, "income", { category: "工资" })];
    const result = history.selection(entries, { category: "旧分类" }, { asOf: "2026-11-07" });
    assert.equal(result.totals.incomplete.grossExpense, true); assert.equal(result.totals.incomplete.netExpense, true); assert.equal(result.totals.incomplete.refund, false); assert.equal(result.totals.refund, 123); assert.equal(result.totals.count, 2);
    assert.deepEqual(history.categoryOptions(entries, { type: "refund" }), ["旧分类"]);
    for (const search of ["午餐", "1.25", "USD", "2026-10-01"]) assert.ok(history.selection(entries, { search }, { asOf: "2026-11-07" }).list.some(r => r.id === "unknown"));
    const fx = { date: "2026-10-01", source: "手动", rates: { CNY: 1, USD: .125, JPY: 20 } };
    const converted = history.selection([{ ...entries[0], fx }], {}, { asOf: "2026-11-07" });
    assert.equal(converted.totals.grossExpense, 1000); assert.equal(converted.totals.incomplete.netExpense, false);
    assert.equal(entries[0].fx, undefined);
  });
}
module.exports = { register };
if (require.main === module) {
  const tests = []; register((name, run) => tests.push({ name, run }));
  for (const { name, run } of tests) { run(); console.log(`OK ${name}`); }
  console.log(`${tests.length} history checks passed; all records stayed in memory.`);
}
