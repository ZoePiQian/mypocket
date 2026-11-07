"use strict";
// Run with Node only: all financial fixtures live in virtualVault(), never on disk.
const assert = require("node:assert/strict"), fs = require("node:fs"), path = require("node:path"), vm = require("node:vm");
const { virtualVault, codec } = require("./test-support.cjs");
const core = require("../src/core"), monthly = require("../src/monthly"), projects = require("../src/projects");
const fixed = require("../src/fixed"), currency = require("../src/currency"), transactions = require("../src/transactions");
const { FinanceStore } = require("../src/storage");
const tests = [];
const test = (name, run) => tests.push({ name, run });
function fm(id = "sample", overrides = {}) {
  return { finance_schema: 1, finance_kind: "expense", id, date: "2026-11-05", currency: "CNY", amount: "32.50", category: "餐饮", account: "现金", memo: "虚构测试记录", ...overrides };
}
function fixture() {
  const v = virtualVault(); let folder = "data";
  const store = new FinanceStore(v.app, codec, () => folder);
  for (const event of ["create", "modify", "rename", "delete"]) v.app.vault.on(event, (file, old) => store.invalidate(file, old));
  return { ...v, v, store, setFolder: next => { folder = next; } };
}
function daily(v, entries, month = "2026-11", location = `data/流水/${month.slice(0, 4)}/${month}.md`) {
  let text = monthly.create(month, codec);
  for (const entry of entries) text = monthly.append(text, core.validateRecord(entry), monthly.parse(text, location, codec));
  v.add(location, text); return location;
}
function project(v, entries = [], options = {}) {
  const p = projects.validate({ id: "project-a", name: "装修演示", status: "active", budget: "5000", currency: "CNY", categories: ["家具"], ...options });
  const location = `data/专项/${p.name}.md`; let text = projects.create(p, codec);
  for (const entry of entries) text = monthly.append(text, core.validateRecord(entry), projects.parse(text, location, codec));
  v.add(location, text); return location;
}
const quote = (date, usd = .14) => [ { base: "CNY", quote: "USD", date, rate: usd }, { base: "CNY", quote: "JPY", date, rate: 20 } ];

test("recent ten includes newest same-day rows, totals use all matches", () => {
  const v = virtualVault(), location = daily(v, Array.from({ length: 12 }, (_, i) => fm(`r${i + 1}`)));
  const records = monthly.parse(v.text(location), location, codec).records;
  const selected = transactions.selection(records, "2026-11", { asOf: "2026-11-07" });
  assert.deepEqual(selected.list.slice(0, 10).map(r => r.id), Array.from({ length: 10 }, (_, i) => `r${12 - i}`));
  assert.equal(selected.totals.grossExpense, 39000); assert.equal(records[0].id, "r1");
});
test("daily summaries exclude project spending and future records", () => {
  const normal = core.validateRecord(fm("normal")), refund = core.validateRecord(fm("refund", { finance_kind: "refund", amount: "2.50" }));
  const special = { ...core.validateRecord(fm("special", { amount: "1000" })), storage: "project", projectId: "p" };
  const future = core.validateRecord(fm("future", { date: "2026-11-20" }));
  assert.equal(core.summarize([normal, refund, special, future], "2026-11", "2026-11-07").expenses, 3000);
  assert.equal(transactions.selection([normal, special], "2026-11", { asOf: "2026-11-07" }).list.length, 1);
});
test("currency snapshots and fractional cents stay exact", () => {
  const fx = currency.snapshot({ date: "2026-11-05", source: "手动", rates: { USD: .125, JPY: 20 } });
  assert.equal(currency.convert(1001, "USD", "CNY", fx), 8008); assert.equal(currency.money(1201, "CNY", true), "¥13");
  assert.equal(currency.convert(1001, "USD", "JPY", fx), 160160);
});
test("provisional FX rechecks next day without changing saved snapshots", async () => {
  let day = "2026-11-05", calls = 0;
  const rates = new currency.ExchangeRates(async () => { calls++; return quote(calls === 1 ? "2026-11-04" : "2026-11-05"); }, {}, async () => {}, () => day);
  const saved = await rates.get(day), before = JSON.stringify(saved); day = "2026-11-06";
  assert.equal((await rates.get("2026-11-05")).date, "2026-11-05");
  assert.equal(calls, 2); assert.equal(JSON.stringify(saved), before);
  day = "2026-12-01"; await rates.get("2026-11-05"); assert.equal(calls, 2);
});
test("weekend FX rechecks are bounded and legacy provisional cache is refreshed", async () => {
  let day = "2026-11-07", calls = 0;
  const cache = { "2026-11-07": { date: "2026-11-06", source: currency.SOURCE, rates: { CNY: 1, USD: .14, JPY: 20 }, fetchedAt: Date.now() } };
  const rates = new currency.ExchangeRates(async () => { calls++; return quote("2026-11-06"); }, cache, async () => {}, () => day);
  await rates.get("2026-11-07"); await rates.get("2026-11-07"); assert.equal(calls, 1);
  day = "2026-11-08"; await rates.get("2026-11-07"); await rates.get("2026-11-07"); assert.equal(calls, 2);
  day = "2026-11-14"; await rates.get("2026-11-07"); assert.equal(calls, 3);
  day = "2027-01-01"; await rates.get("2026-11-07"); assert.equal(calls, 3);
});
test("FX uses safe offline fallback and coalesces simultaneous requests", async () => {
  let calls = 0;
  const rates = new currency.ExchangeRates(async () => { calls++; return quote("2026-11-05"); }, {}, async () => {}, () => "2026-11-05");
  await Promise.all([rates.get("2026-11-05"), rates.get("2026-11-05")]); assert.equal(calls, 1);
  rates.today = () => "2026-11-06"; rates.cache["2026-11-05"].date = "2026-11-04"; rates.request = async () => { throw new Error("offline"); };
  assert.equal((await rates.get("2026-11-05")).cached, true);
  await assert.rejects(rates.get("2026-11-03"), /无法获取/);
});
test("fixed fees are plans until paid, and duplicate payment is rejected", async () => {
  const { store } = fixture();
  await store.saveFixed({ id: "fixed-a", year: "2026", name: "虚构年费", cycle: "yearly", amount: "100", firstDate: "2026-11-01", currency: "CNY", status: "active", memo: "" });
  let data = await store.scan(); assert.equal(data.records.length, 0); const entry = data.fixedEntries[0];
  await store.payFixed(entry, "2026-11-01", { amount: "90", date: "2026-11-05" }, "2026-11-07");
  data = await store.scan(); assert.equal(data.records.length, 1); assert.equal(data.records[0].amountCents, 9000);
  await assert.rejects(store.payFixed(entry, "2026-11-01", { amount: "90", date: "2026-11-05" }, "2026-11-07"), /已经记录/);
});
test("fixed payments assigned to project do not enter daily ledger", async () => {
  const { v, store } = fixture(); project(v);
  await store.saveFixed({ id: "fixed-project", year: "2026", name: "虚构专项费用", cycle: "yearly", amount: "100", firstDate: "2026-11-01", currency: "CNY", projectId: "project-a", status: "active", memo: "" });
  const entry = (await store.scan()).fixedEntries[0];
  await store.payFixed(entry, "2026-11-01", { amount: "80", date: "2026-11-05" }, "2026-11-07");
  const data = await store.scan(); assert.equal(data.records.length, 0); assert.equal(data.projectRecords[0].amountCents, 8000);
});
test("stale folder edits/deletes leave both ledgers unchanged", async () => {
  const { v, store, setFolder } = fixture(), location = daily(v, [fm()]);
  const previous = monthly.parse(v.text(location), location, codec).records[0], before = v.snapshot();
  setFolder("other");
  await assert.rejects(store.save(fm("sample", { date: "2026-12-01" }), previous), /目录/);
  await assert.rejects(store.trash(previous), /目录/); assert.deepEqual(v.snapshot(), before);
});
test("project-to-daily rejects mismatched target month without removing source", async () => {
  const { v, store } = fixture(), location = project(v, [fm()]);
  daily(v, [], "2026-10", "data/流水/2026/2026-11.md");
  const record = projects.parse(v.text(location), location, codec).records[0], before = v.snapshot();
  await assert.rejects(store.moveProjectRecordToDaily(record), /月份/); assert.deepEqual(v.snapshot(), before);
});
test("directory change while write waits in queue rejects without creating data", async () => {
  const { v, store, setFolder } = fixture(); let release;
  const blocker = store.queue(() => new Promise(resolve => { release = resolve; }), true);
  await Promise.resolve(); const pending = store.save(fm()); const before = v.snapshot();
  setFolder("other"); release(); await blocker;
  await assert.rejects(pending, /目录/); assert.deepEqual(v.snapshot(), before);
});
test("directory change at final write callback does not overwrite source", async () => {
  const { v, store, setFolder } = fixture(), location = daily(v, [fm()]);
  const previous = monthly.parse(v.text(location), location, codec).records[0], before = v.snapshot(), original = v.app.vault.process;
  v.app.vault.process = async (file, change) => { setFolder("other"); return original(file, change); };
  await assert.rejects(store.save(fm("sample", { amount: "88" }), previous), /目录/); assert.deepEqual(v.snapshot(), before);
});
test("unchanged scans reuse parses; file events invalidate only changed note", async () => {
  const { v, store } = fixture();
  for (let m = 1; m <= 12; m++) daily(v, [], `2025-${String(m).padStart(2, "0")}`);
  v.resetReads(); await store.scan(); assert.equal(v.reads, 12);
  v.resetReads(); await store.scan(); assert.equal(v.reads, 0);
  const location = "data/流水/2025/2025-11.md"; v.set(location, v.text(location) + "\n虚构补充说明\n");
  v.resetReads(); await store.scan(); assert.equal(v.reads, 1);
});

test("configured folder scans preserve custom and legacy notes without enumerating or reading unrelated notes", async () => {
  const { v, store, setFolder } = fixture(), root = "books/家用"; setFolder(root);
  daily(v, [fm("custom")], "2026-11", `${root}/手动目录.md/自定义账本.md`);
  const old = `${root}/导入/单笔旧记录.md`;
  v.add(old, `---\n${codec.stringifyYaml(fm("legacy"))}\n---\n保留旧正文\n`);
  const excluded = [`${root}/备忘录.md`, `${root}/回收站/2026.md`, `${root}/旧版备份/原始.md`];
  for (const location of excluded) daily(v, [fm("excluded")], "2026-11", location);
  daily(v, [fm("unrelated")], "2026-11", "books/家用外/流水/2026-11.md");
  v.add("其他笔记.md", "unrelated private fixture");
  Object.defineProperty(v.folder("books/家用外"), "children", { get() { throw new Error("Unrelated directory enumerated"); } });
  v.app.vault.getMarkdownFiles = v.app.vault.getFiles = () => { throw new Error("Whole-vault enumeration"); };
  const data = await store.scan();
  assert.deepEqual(data.records.map(r => r.id).sort(), ["custom", "legacy"]);
  assert.equal(data.warnings.length, 0); assert.ok(v.files.has(`${root}/旧版备份/导入/单笔旧记录.md.bak`));
  assert.ok(v.text(`${root}/流水/2026/2026-11.md`).includes("保留旧正文"));
  assert.ok(v.readPaths.every(location => location.startsWith(root + "/") && !excluded.includes(location)));
  v.resetReads(); const recovery = await store.listRecovery();
  assert.equal(recovery.items[0].record.id, "excluded"); assert.deepEqual(v.readPaths, [`${root}/回收站/2026.md`]);
});

test("year migration uses only direct legacy months and preserves custom nested paths", async () => {
  const { v, store } = fixture();
  const old = daily(v, [fm("old-month")], "2026-11", "data/流水/2026-11.md");
  const nested = daily(v, [fm("nested", { date: "2026-12-05" })], "2026-12", "data/流水/手动目录/2026-12.md");
  v.add("data/月报/2026-11.md", `---\n${codec.stringifyYaml({ finance_report: true, month: "2026-11" })}\n---\n旧月报\n`);
  v.app.vault.getMarkdownFiles = () => { throw new Error("Whole-vault enumeration"); };
  assert.deepEqual(await store.migrateYearFolders(), []);
  assert.equal(v.files.has(old), false); assert.ok(v.files.has("data/流水/2026/2026-11.md"));
  assert.ok(v.files.has("data/月报/2026/2026-11.md")); assert.ok(v.files.has(nested));
  assert.ok(!v.readPaths.includes(nested));
  assert.deepEqual((await store.scan()).records.map(r => r.id).sort(), ["nested", "old-month"]);
});

test("scoped traversal handles missing folders, file occupants and folders named md", async () => {
  const { markdownFilesIn } = require("../src/scoped-files"), v = virtualVault();
  assert.deepEqual(markdownFilesIn(v.app.vault, "missing"), []);
  v.add("occupied", "file, not folder"); assert.deepEqual(markdownFilesIn(v.app.vault, "occupied"), []);
  const direct = v.add("data/direct.md", "a"), nested = v.add("data/folder.md/nested.md", "b");
  v.add("data/receipt.png", "binary fixture"); v.folder("data/empty.md");
  const outside = v.add("data-extra/other.md", "outside");
  v.folder("data").children.push(outside); // A stale/misparented entry must not escape the boundary.
  assert.deepEqual(markdownFilesIn(v.app.vault, "data", { recursive: false }), [direct]);
  assert.deepEqual(markdownFilesIn(v.app.vault, "data"), [direct, nested]);
  await v.app.vault.rename(v.folder("data/folder.md"), "data/moved.md");
  assert.equal(nested.path, "data/moved.md/nested.md");
  assert.equal(v.app.vault.getAbstractFileByPath("data/folder.md/nested.md"), null);
  assert.deepEqual(markdownFilesIn(v.app.vault, "data"), [direct, nested]);
  assert.equal(v.folder("data/moved.md").extension, undefined);
});

test("a note moved outside the configured folder before its read is skipped", async () => {
  const { v, store } = fixture();
  for (let i = 0; i < 21; i++) daily(v, [fm(`note-${i}`)], "2026-11", `data/custom/${i}.md`);
  const read = v.app.vault.read, moved = v.files.get("data/custom/20.md"); let changed = false;
  v.app.vault.read = async file => {
    if (!changed) { changed = true; await v.app.vault.rename(moved, "other/moved.md"); }
    return read(file);
  };
  const data = await store.readAll();
  assert.equal(data.records.length, 20); assert.ok(data.warnings.some(warning => warning.path === "other/moved.md"));
  assert.ok(v.readPaths.every(location => location.startsWith("data/")));
});
test("deleted daily record restores exact cents, memo, ID and target month", async () => {
  const { v, store } = fixture(), location = daily(v, [fm("restore", { memo: "测试 | & <br>\n第二行" })]);
  const record = monthly.parse(v.text(location), location, codec).records[0]; await store.trash(record);
  const list = await store.listRecovery(); assert.equal(list.items.length, 1);
  const result = await store.restoreRecovery(list.items[0]); assert.equal(result.path, location);
  const restored = monthly.parse(v.text(location), location, codec).records[0];
  assert.equal(monthly.fingerprint(restored), monthly.fingerprint(record)); assert.equal((await store.listRecovery()).items.length, 0);
});
test("recovery selects exact historical version and refuses already active ID", async () => {
  const { v, store } = fixture(), location = daily(v, [fm("history")]);
  let record = monthly.parse(v.text(location), location, codec).records[0]; await store.trash(record);
  await store.save(fm("history", { amount: "88.08" })); record = monthly.parse(v.text(location), location, codec).records[0]; await store.trash(record);
  let list = await store.listRecovery(); assert.equal(list.items.length, 2);
  await store.restoreRecovery(list.items.find(i => i.record.amountCents === 8808));
  assert.equal(monthly.parse(v.text(location), location, codec).records[0].amountCents, 8808);
  list = await store.listRecovery(); assert.equal(list.items.length, 1); const before = v.snapshot();
  await assert.rejects(store.restoreRecovery(list.items[0]), /已经存在/); assert.deepEqual(v.snapshot(), before);
});
test("project recovery retains original project; archived target refuses safely", async () => {
  const { v, store } = fixture(), location = project(v, [fm("restore-project")]);
  let parsed = projects.parse(v.text(location), location, codec); await store.trashProjectRecord(parsed.records[0]);
  let list = await store.listRecovery(); assert.equal(list.items[0].projectId, "project-a");
  parsed = projects.parse(v.text(location), location, codec); v.set(location, projects.updateMetadata(v.text(location), { ...parsed.project, status: "archived" }, codec));
  const before = v.snapshot(); await assert.rejects(store.restoreRecovery(list.items[0]), /已归档/); assert.deepEqual(v.snapshot(), before);
  parsed = projects.parse(v.text(location), location, codec); v.set(location, projects.updateMetadata(v.text(location), { ...parsed.project, status: "active" }, codec));
  await store.restoreRecovery(list.items[0]); assert.equal((await store.scan()).projectRecords.length, 1); assert.equal((await store.scan()).records.length, 0);
});
test("duplicate same-file rows keep selected version and archive other version", async () => {
  const { v, store } = fixture(), location = daily(v, [fm("duplicate"), fm("duplicate", { amount: "99.99" })]);
  const group = (await store.listDuplicates()).groups[0]; assert.equal(group.items.length, 2);
  await store.resolveDuplicate(group, group.items.find(i => i.record.amountCents === 9999));
  const records = monthly.parse(v.text(location), location, codec).records;
  assert.equal(records.length, 1); assert.equal(records[0].amountCents, 9999);
  assert.equal((await store.listRecovery()).items[0].record.amountCents, 3250); assert.equal((await store.listDuplicates()).groups.length, 0);
});
test("duplicate cross-ledger selection preserves project survivor and daily prose", async () => {
  const { v, store } = fixture(), source = daily(v, [fm("duplicate")]), target = project(v, [fm("duplicate", { amount: "500" })]);
  v.set(source, v.text(source) + "\n保留这段虚构自由笔记\n");
  const group = (await store.listDuplicates()).groups[0]; await store.resolveDuplicate(group, group.items.find(i => i.path === target));
  assert.match(v.text(source), /保留这段虚构自由笔记/); assert.equal((await store.scan()).records.length, 0); assert.equal((await store.scan()).projectRecords.length, 1);
});
test("stale recovery and duplicate previews cannot overwrite concurrent edits", async () => {
  const { v, store } = fixture(), location = daily(v, [fm()]);
  await store.trash(monthly.parse(v.text(location), location, codec).records[0]);
  const item = (await store.listRecovery()).items[0]; v.set(item.path, v.text(item.path) + "\n其他设备的说明\n"); let before = v.snapshot();
  await assert.rejects(store.restoreRecovery(item), /改变/); assert.deepEqual(v.snapshot(), before);
  const duplicatePath = daily(v, [fm("duplicate"), fm("duplicate", { amount: "66" })], "2026-11", "data/流水/2026/duplicate.md");
  const group = (await store.listDuplicates()).groups[0]; v.set(duplicatePath, v.text(duplicatePath) + "\n新笔记\n"); before = v.snapshot();
  await assert.rejects(store.resolveDuplicate(group, group.items[0]), /修改/); assert.deepEqual(v.snapshot(), before);
});
test("failed recovery rolls target back and leaves deleted row recoverable", async () => {
  const { v, store } = fixture(), location = daily(v, [fm("rollback")]);
  await store.trash(monthly.parse(v.text(location), location, codec).records[0]);
  const item = (await store.listRecovery()).items[0], before = v.snapshot(), process = v.app.vault.process; let fail = true;
  v.app.vault.process = async (file, change) => {
    if (fail && file.path === item.path) { fail = false; throw new Error("simulated I/O failure"); }
    return process(file, change);
  };
  await assert.rejects(store.restoreRecovery(item), /simulated I\/O failure/); assert.deepEqual(v.snapshot(), before);
  await store.restoreRecovery(item); assert.equal((await store.scan()).records.length, 1);
});

require("./check-attachments.cjs")(test);
require("./check-history.cjs").register(test);
require("./check-templates.cjs").register(test);
if (!process.argv.includes("--logic-only")) {
  test("release versions, complete bundle and assets match canonical sources", () => {
    const root = path.resolve(__dirname, ".."), read = name => fs.readFileSync(path.join(root, name), "utf8");
    const manifest = JSON.parse(read("manifest.json")), pkg = JSON.parse(read("package.json"));
    assert.equal(manifest.version, pkg.version); assert.match(manifest.version, /^\d+\.\d+\.\d+$/);
    assert.equal(manifest.id, "local-finance-notes"); assert.equal(manifest.isDesktopOnly, false);
    const bundle = read("安装文件/local-finance-notes/main.js"), expected = require("./build").createBundle();
    assert.equal(bundle, expected, "Run npm run build before release checks");
    assert.equal(read("styles.css"), read("安装文件/local-finance-notes/styles.css"));
    assert.deepEqual(manifest, JSON.parse(read("安装文件/local-finance-notes/manifest.json")));
    for (const name of fs.readdirSync(path.join(root, "src")).filter(name => name.endsWith(".js"))) new vm.Script(read("src/" + name), { filename: name });
    const module = { exports: {} }, external = { Plugin: class {}, ItemView: class {}, Modal: class {}, PluginSettingTab: class {}, Component: class {} };
    const context = { module, console, require: name => { assert.equal(name, "obsidian"); return external; } };
    vm.runInNewContext(bundle, context); assert.equal(typeof module.exports, "function");
    // Verify all declared modules resolve, including optional views and generated guide assets.
    vm.runInNewContext(bundle + "\nfor (const id of Object.keys(modules)) localRequire(id);", { ...context, module: { exports: {} } });
  });
}
(async () => {
  let failed = 0;
  for (const { name, run } of tests) {
    try { await run(); console.log("PASS " + name); }
    catch (error) { failed++; console.error("FAIL " + name + "\n" + error.stack); }
  }
  console.log(`${tests.length - failed}/${tests.length} checks passed; all financial fixtures stayed in memory.`);
  if (failed) process.exitCode = 1;
})();
