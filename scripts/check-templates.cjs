"use strict";
// Template regression fixtures are held exclusively in this virtual vault.
const assert = require("node:assert/strict");
const { virtualVault, codec } = require("./test-support.cjs");
const { FinanceStore } = require("../src/storage"), templates = require("../src/templates");
function fixture() {
  const v = virtualVault(); let root = "data";
  const store = new FinanceStore(v.app, codec, () => root);
  return { v, store, setRoot(value) { root = value; } };
}
function value(changes = {}) {
  return { name: "虚构午餐模板", context: "daily", projectId: "", kind: "expense", category: "餐饮", account: "现金", amount: "12.34", currency: "CNY", memo: "仅供自动检查", ...changes };
}
async function project(store, id, name) {
  await store.saveProject({ id, name, status: "active", startDate: "2026-11-01", currency: "CNY", budget: "", categories: ["交通"], description: "虚构模板测试专项" });
}
function register(test) {
  test("templates reading an empty vault creates no note or financial transaction", async () => {
    const { v, store } = fixture();
    assert.deepEqual(await store.listTemplates(), { root: "data", templates: [], warnings: [] });
    assert.deepEqual(v.snapshot(), []);
    await store.saveTemplate(value(), null, "data");
    const data = await store.scan();
    assert.equal(data.records.length, 0); assert.equal(data.projectRecords.length, 0); assert.equal(data.fixedEntries.length, 0);
    assert.equal(data.warnings.length, 0);
    assert.deepEqual(v.snapshot().map(([path]) => path), ["data/常用模板.md"]);
  });
  test("templates whitelist prefill fields and round-trip blank amounts, decimals and Markdown text", async () => {
    const { store } = fixture();
    const extra = { date: "1900-01-01", id: "transaction-id-must-not-be-reused", fx: { date: "1900-01-01", rates: { CNY: 1, USD: 0.1, JPY: 10 } }, attachments: ["data/凭证/private.png"], principal: 200, name: "测试 | <br> & 模板", memo: "第一行\n第二行 &lt; <br> | \\" };
    const saved = await store.saveTemplate(value({ ...extra, amount: "" }), null, "data");
    assert.notEqual(saved.id, extra.id);
    for (const key of ["date", "fx", "attachments", "principal"]) assert.equal(Object.hasOwn(saved, key), false, key);
    const [read] = (await store.listTemplates()).templates;
    assert.equal(read.amountCents, null); assert.equal(read.name, extra.name); assert.equal(read.memo, extra.memo);
    const updated = await store.saveTemplate(value({ ...extra, amount: "0.01" }), read, "data");
    assert.equal(updated.id, saved.id); assert.equal(updated.amountCents, 1);
    assert.equal((await store.listTemplates()).templates[0].amountCents, 1);
  });
  test("templates separate daily and each project; same-scope duplicate names are refused", async () => {
    const { store, v } = fixture();
    await project(store, "p1", "虚构旅行"); await project(store, "p2", "虚构装修");
    await store.saveTemplate(value({ name: "通勤" }), null, "data");
    await store.saveTemplate(value({ name: "通勤", context: "project", projectId: "p1", kind: "refund" }), null, "data");
    await store.saveTemplate(value({ name: "通勤", context: "project", projectId: "p2" }), null, "data");
    assert.deepEqual((await store.listTemplates()).templates.map(t => [t.context, t.projectId, t.kind]), [["daily", "", "expense"], ["project", "p1", "refund"], ["project", "p2", "expense"]]);
    const before = v.snapshot();
    await assert.rejects(() => store.saveTemplate(value({ name: "通勤", context: "project", projectId: "p1" }), null, "data"), /已存在/);
    await assert.rejects(() => store.saveTemplate(value({ context: "project", projectId: "p1", kind: "income" }), null, "data"), /类型/);
    await assert.rejects(() => store.saveTemplate(value({ context: "project", projectId: "missing" }), null, "data"), /专项/);
    assert.deepEqual(v.snapshot(), before);
    const data = await store.scan(); assert.equal(data.records.length, 0); assert.equal(data.projectRecords.length, 0);
  });
  test("templates edit and delete preserve prose and reject stale snapshots", async () => {
    const { v, store } = fixture(), path = "data/常用模板.md";
    const first = await store.saveTemplate(value(), null, "data");
    v.set(path, v.text(path) + "\n## 手写说明\n保留这段文字和 [[关联笔记]]。\n");
    const changed = await store.saveTemplate(value({ name: "新午餐" }), first, "data");
    assert.ok(v.text(path).endsWith("保留这段文字和 [[关联笔记]]。\n"));
    const before = v.snapshot();
    await assert.rejects(() => store.saveTemplate(value({ name: "旧窗口" }), first, "data"), /修改或删除/);
    await assert.rejects(() => store.deleteTemplate(first, "data"), /修改或删除/);
    assert.deepEqual(v.snapshot(), before);
    await store.deleteTemplate(changed, "data");
    assert.equal((await store.listTemplates()).templates.length, 0);
    assert.ok(v.text(path).endsWith("保留这段文字和 [[关联笔记]]。\n"));
  });
  test("templates enforce opened-form and queued-operation data-root guards", async () => {
    const { v, store, setRoot } = fixture();
    const first = await store.saveTemplate(value(), null, "data"), before = v.snapshot();
    setRoot("other");
    await assert.rejects(() => store.saveTemplate(value(), first, "data"), /目录/);
    await assert.rejects(() => store.deleteTemplate(first, "data"), /目录/);
    assert.deepEqual(v.snapshot(), before);
    setRoot("data"); let release;
    store.pending = new Promise(resolve => { release = resolve; });
    const pending = store.saveTemplate(value({ name: "排队中" }), null, "data");
    setRoot("other"); release();
    await assert.rejects(() => pending, /目录/);
    assert.deepEqual(v.snapshot(), before);
  });
  test("templates CAS preserves concurrent external edits and queued separate creations", async () => {
    const { v, store } = fixture(), path = "data/常用模板.md";
    await Promise.all([store.saveTemplate(value({ name: "甲" }), null, "data"), store.saveTemplate(value({ name: "乙" }), null, "data")]);
    assert.deepEqual((await store.listTemplates()).templates.map(t => t.name), ["甲", "乙"]);
    const originalProcess = v.app.vault.process;
    v.app.vault.process = async (file, transform) => {
      v.set(file.path, v.text(file.path) + "\n同步端新写的说明\n");
      return originalProcess(file, transform);
    };
    await assert.rejects(() => store.saveTemplate(value({ name: "丙" }), null, "data"), /修改/);
    assert.ok(v.text(path).endsWith("同步端新写的说明\n"));
    assert.deepEqual((await store.listTemplates()).templates.map(t => t.name), ["甲", "乙"]);
  });
  test("templates reject malformed notes and unusable values without replacing existing content", async () => {
    const { v, store } = fixture(), path = "data/常用模板.md";
    v.add(path, "# 用户自己的同名文档\n必须保留。\n"); const before = v.snapshot();
    await assert.rejects(() => store.listTemplates(), /不是有效/);
    await assert.rejects(() => store.saveTemplate(value(), null, "data"), /不是有效/);
    assert.deepEqual(v.snapshot(), before);
    for (const changes of [{ amount: "1.234" }, { amount: "-1" }, { kind: "investment" }, { category: "餐\n饮" }, { account: "现\u0000金" }, { currency: "EUR" }, { context: "daily", projectId: "p1" }]) assert.throws(() => templates.validate({ id: "test", ...value(changes) }));
    const malformed = templates.create(codec).replace("<!-- mypocket:templates:end -->", "");
    assert.throws(() => templates.parse(malformed, path, codec), /标记/);
  });
}
module.exports = { register };
if (require.main === module) {
  const checks = []; register((name, run) => checks.push({ name, run }));
  (async () => { let failures = 0; for (const { name, run } of checks) { try { await run(); console.log("PASS " + name); } catch (error) { failures++; console.error("FAIL " + name + "\n" + error.stack); } } console.log(`${checks.length - failures}/${checks.length} template checks passed; all data stayed in memory.`); if (failures) process.exitCode = 1; })();
}
