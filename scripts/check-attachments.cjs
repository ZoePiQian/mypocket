"use strict";
// All receipts and ledgers in these regression checks exist only in memory.
const assert = require("node:assert/strict");
const { virtualVault, codec } = require("./test-support.cjs");
const core = require("../src/core"), monthly = require("../src/monthly"), projects = require("../src/projects");
const attachments = require("../src/attachments"), { FinanceStore } = require("../src/storage");
const PNG = Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 0]);
const PDF = new TextEncoder().encode("%PDF-1.4\nfictional test fixture\n%%EOF");
function fm(id = "receipt-test", changes = {}) {
  return { finance_schema: 1, finance_kind: "expense", id, date: "2026-11-05", currency: "CNY", amount: "32.50", category: "餐饮", account: "现金", memo: "虚构凭证测试", ...changes };
}
function fixture() {
  const v = virtualVault(), binary = new Map(); let root = "data";
  const store = new FinanceStore(v.app, codec, () => root), vault = v.app.vault;
  vault.createBinary = async (path, data) => {
    const bytes = new Uint8Array(data).slice(), file = v.add(path, "<virtual binary>");
    binary.set(file, bytes); file.stat.size = bytes.length; return file;
  };
  vault.readBinary = async file => { if (!binary.has(file)) throw new Error("Binary missing"); return binary.get(file).slice().buffer; };
  const remove = vault.delete;
  vault.delete = async file => { await remove(file); binary.delete(file); };
  for (const event of ["create", "modify", "delete", "rename"]) vault.on(event, (file, old) => store.invalidate(file, old));
  return { v, store, binary, setRoot: value => { root = value; } };
}
function daily(v, entries, month = "2026-11") {
  const path = `data/流水/${month.slice(0, 4)}/${month}.md`; let text = monthly.create(month, codec);
  for (const entry of entries) text = monthly.append(text, core.validateRecord(entry), monthly.parse(text, path, codec));
  v.add(path, text); return path;
}
function project(v, entries = []) {
  const p = projects.validate({ id: "receipt-project", name: "装修测试", status: "active", categories: ["餐饮"] });
  const path = `data/专项/${p.name}.md`; let text = projects.create(p, codec);
  for (const entry of entries) text = monthly.append(text, core.validateRecord(entry), projects.parse(text, path, codec));
  v.add(path, text); return path;
}
const paths = ["data/凭证/2026/11/午餐 & 票据.png", "data/凭证/2026/11/合同.pdf"];
function editorFixture(store, app) {
  // A minimal document tests the editor's save/cancel lifecycle, not CSS.
  const notices = [];
  const doc = { defaultView: { URL: { createObjectURL: () => "blob:virtual-receipt", revokeObjectURL() {} } } };
  doc.createElement = tag => ({ tagName: tag, ownerDocument: doc, children: [], handlers: {}, classList: {
    values: new Set(),
    add(...names) { for (const name of names) this.values.add(name); },
    remove(...names) { for (const name of names) this.values.delete(name); },
    contains(name) { return this.values.has(name); },
    toggle(name, force) { const enabled = force === undefined ? !this.values.has(name) : Boolean(force); if (enabled) this.values.add(name); else this.values.delete(name); return enabled; }
  },
    appendChild(child) { this.children.push(child); child.parentNode = this; }, replaceChildren() { this.children = []; },
    remove() { if (this.parentNode) this.parentNode.children = this.parentNode.children.filter(child => child !== this); },
    addEventListener(name, fn) { (this.handlers[name] ||= []).push(fn); }, setAttribute() {} });
  const source = require("node:fs").readFileSync(require("node:path").join(__dirname, "../src/attachments-ui.js"), "utf8"), module = { exports: {} };
  const localRequire = id => id === "obsidian" ? { Modal: class {}, Notice: class { constructor(text) { notices.push(text); } } } : id === "./mobile" ? { adaptModal: () => () => {} } : id === "./icons" ? { decorate: value => value } : require("../src/" + id.slice(2));
  new Function("require", "module", source)(localRequire, module);
  const parent = doc.createElement("form"), editor = module.exports.createReceiptEditor(parent, { store, app }, { dateInput: { value: "2026-11-05" }, root: "data" });
  const walk = node => [node, ...node.children.flatMap(walk)]; const picker = walk(parent).find(node => node.tagName === "input");
  const pick = file => { picker.files = [file]; for (const fn of picker.handlers.change) fn(); };
  return { editor, pick, notices };
}
function deferred() { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; }
function register(test) {
  test("receipt paths reject URLs, traversal, aliases, unsafe types and over ten", () => {
    for (const path of ["../x.png", "/x.png", "https://x/a.png", "C:\\x.png", "a/../x.png", "a/.hidden/x.png", "a/x.svg", "a/x.png|alias", "a/x.png#section", "a/%2e%2e/x.png", "a//x.png"])
      assert.throws(() => attachments.normalizePaths([path]));
    assert.throws(() => attachments.normalizePaths(Array(11).fill("a/x.png")));
    assert.deepEqual(attachments.normalizePaths(["data\\票据.png", "data/票据.png"]), ["data/票据.png"]);
    assert.throws(() => attachments.parseCell("[[data/x.png|别名]]"));
  });
  test("receipt type and byte validation accepts only original supported formats", () => {
    const formats = { "x.png": PNG, "x.pdf": PDF, "x.jpg": Uint8Array.of(255, 216, 255, 224), "x.jpeg": Uint8Array.of(255, 216, 255, 224), "x.gif": new TextEncoder().encode("GIF89a"), "x.webp": new TextEncoder().encode("RIFF1234WEBP") };
    for (const [name, data] of Object.entries(formats)) assert.equal(attachments.validateUpload({ name, data }).bytes.length, data.length);
    assert.throws(() => attachments.validateUpload({ name: "wrong.png", data: PDF }), /内容/);
    assert.throws(() => attachments.validateUpload({ name: "huge.pdf", data: new Uint8Array(attachments.MAX_BYTES + 1) }), /10 MB/);
    assert.throws(() => attachments.validateUpload({ name: "empty.pdf", data: new ArrayBuffer(0) }), /非空/);
  });
  test("seven and thirteen column ledgers remain compatible; receipt column round trips", () => {
    for (const foreign of [false, true]) {
      const base = fm("legacy", foreign ? { currency: "USD", fx: { date: "2026-11-05", source: "手动", rates: { CNY: 1, USD: .125, JPY: 20 } } } : {});
      let text = monthly.create("2026-11", codec);
      text = monthly.append(text, core.validateRecord(base), monthly.parse(text, "sample.md", codec));
      const old = monthly.parse(text, "sample.md", codec); assert.equal(old.receipts, false); assert.equal(old.multi, foreign); assert.deepEqual(old.records[0].attachments, []);
      text += "\n保留手写正文\n";
      text = monthly.replace(text, old.records[0], core.validateRecord({ ...base, attachments: paths }));
      const current = monthly.parse(text, "sample.md", codec);
      assert.equal(current.receipts, true); assert.equal(current.multi, foreign); assert.equal(current.warnings.length, 0);
      assert.deepEqual(current.records[0].attachments, paths); assert.deepEqual(current.records[0].frontmatter.attachments, paths);
      assert.match(text, /\[\[data\/凭证\/2026\/11\/合同.pdf\]\]/); assert.ok(text.includes(`[[${paths[0]}]]`)); assert.match(text, /<br>/); assert.match(text, /保留手写正文/);
      text = monthly.append(text, core.validateRecord(fm("second")), current);
      assert.deepEqual(monthly.parse(text, "sample.md", codec).records[1].attachments, []);
    }
  });
  test("currency upgrade retains existing receipts and receipt-only edits conflict", () => {
    let text = monthly.create("2026-11", codec);
    text = monthly.append(text, core.validateRecord(fm("one", { attachments: paths })), monthly.parse(text, "a.md", codec));
    const before = monthly.parse(text, "a.md", codec).records[0];
    text = monthly.append(text, core.validateRecord(fm("usd", { currency: "USD", fx: { date: "2026-11-05", source: "手动", rates: { CNY: 1, USD: .125, JPY: 20 } } })), monthly.parse(text, "a.md", codec));
    let parsed = monthly.parse(text, "a.md", codec); assert.equal(parsed.multi, true); assert.deepEqual(parsed.records[0].attachments, paths);
    text = monthly.replace(text, parsed.records[0], core.validateRecord(fm("one", { attachments: [paths[1]] })));
    parsed = monthly.parse(text, "a.md", codec); assert.throws(() => monthly.checked(parsed, before), /已被修改/);
  });
  test("malformed receipt references warn and block row edits without dropping the original", () => {
    let text = monthly.create("2026-11", codec);
    text = monthly.append(text, core.validateRecord(fm("safe", { attachments: paths })), monthly.parse(text, "a.md", codec));
    const previous = monthly.parse(text, "a.md", codec).records[0];
    const invalid = text.replace("[[data/凭证/2026/11/合同.pdf]]", "[[../合同.pdf]]"), parsed = monthly.parse(invalid, "a.md", codec);
    assert.equal(parsed.warnings.length, 1); assert.equal(parsed.records.length, 0); assert.throws(() => monthly.checked(parsed, previous), /格式错误/);
  });
  test("legacy individual-note migration retains receipt paths and handwritten body", async () => {
    const { v, store } = fixture(), value = fm("legacy-receipt", { attachments: paths });
    v.add("data/旧流水/午餐.md", `---\n${codec.stringifyYaml(value)}\n---\n\n虚构旧记录正文\n`);
    const data = await store.scan(); assert.equal(data.warnings.length, 0); assert.equal(data.records.length, 1);
    assert.deepEqual(data.records[0].attachments, paths); assert.match(v.text(data.records[0].path), /虚构旧记录正文/);
    assert.ok(v.files.has("data/旧版备份/旧流水/午餐.md.bak"));
  });
  test("daily receipt links survive editing and month changes; unlink does not delete binaries", async () => {
    const { v, store, binary } = fixture(); const upload = await store.importReceipt({ name: "票据.png", data: PNG.buffer }, "2026-11-05", "data");
    await store.save(fm("edit", { attachments: [upload.path] })); store.releaseImportedReceipt(upload);
    let record = (await store.scan()).records[0];
    await store.save(fm("edit", { memo: "修改备注" }), record); record = (await store.scan()).records[0]; assert.deepEqual(record.attachments, [upload.path]);
    await store.save(fm("edit", { date: "2026-10-30" }), record); record = (await store.scan()).records[0]; assert.equal(record.date, "2026-10-30"); assert.deepEqual(record.attachments, [upload.path]);
    await store.save(fm("edit", { date: "2026-10-30", attachments: [] }), record); assert.deepEqual((await store.scan()).records[0].attachments, []);
    assert.equal(binary.size, 1); assert.ok(v.files.has(upload.path));
  });
  test("receipt links survive daily to project and back plus project trash and restore", async () => {
    const { v, store } = fixture(); daily(v, [fm("move", { attachments: paths })]); project(v);
    await store.moveToProject("receipt-project", (await store.scan()).records);
    let record = (await store.scan()).projectRecords[0]; assert.deepEqual(record.attachments, paths);
    await store.saveProjectRecord("receipt-project", fm("move", { memo: "只修改专项备注" }), record);
    record = (await store.scan()).projectRecords[0]; assert.deepEqual(record.attachments, paths);
    await store.trashProjectRecord(record); let recovery = await store.listRecovery(); assert.deepEqual(recovery.items[0].record.attachments, paths);
    await store.restoreRecovery(recovery.items[0]); record = (await store.scan()).projectRecords[0];
    await store.moveProjectRecordToDaily(record); record = (await store.scan()).records[0]; assert.deepEqual(record.attachments, paths);
    await store.trash(record); recovery = await store.listRecovery(); assert.deepEqual(recovery.items[0].record.attachments, paths);
    await store.restoreRecovery(recovery.items[0]); assert.deepEqual((await store.scan()).records[0].attachments, paths);
  });
  test("fixed payment receipts work in daily and project destinations", async () => {
    const { v, store } = fixture(); project(v);
    for (const projectId of ["", "receipt-project"]) {
      await store.saveFixed({ id: projectId ? "fixed-project" : "fixed-daily", year: "2026", name: "测试会员", cycle: "yearly", amount: "20", currency: "CNY", firstDate: "2026-11-01", status: "active", memo: "", projectId });
      const plan = (await store.scan()).fixedEntries.find(e => e.projectId === projectId);
      await store.payFixed(plan, "2026-11-01", { amount: "19", date: "2026-11-05", attachments: paths }, "2026-11-07");
    }
    const data = await store.scan(); assert.deepEqual(data.records[0].attachments, paths); assert.deepEqual(data.projectRecords[0].attachments, paths);
  });
  test("duplicate variants that differ only by receipts preserve both versions", async () => {
    const { v, store } = fixture(); daily(v, [fm("duplicate", { attachments: [paths[0]] }), fm("duplicate", { attachments: [paths[1]] })]);
    const group = (await store.listDuplicates()).groups[0]; assert.notEqual(group.items[0].key, group.items[1].key);
    await store.resolveDuplicate(group, group.items.find(item => item.record.attachments[0] === paths[1]));
    assert.deepEqual((await store.scan()).records[0].attachments, [paths[1]]);
    assert.deepEqual((await store.listRecovery()).items[0].record.attachments, [paths[0]]);
  });
  test("receipt import sanitizes and randomizes filenames, never overwrites", async () => {
    const { store, binary } = fixture();
    const one = await store.importReceipt({ name: "../午餐:*?.PNG", data: PNG }, "2026-11-05", "data");
    const two = await store.importReceipt({ name: "../午餐:*?.PNG", data: PNG }, "2026-11-05", "data");
    assert.match(one.path, /^data\/凭证\/2026\/11\/午餐---[a-z0-9-]+\.png$/); assert.notEqual(one.path, two.path); assert.equal(binary.size, 2);
    const retained = await store.removeImportedReceipt(one, "data");
    assert.equal(retained.removed, false); assert.equal(retained.path, one.path); assert.equal(retained.reusable, true);
    assert.equal((await store.removeImportedReceipt(two, "data")).removed, false); assert.equal(binary.size, 2);
    assert.equal(store.importedReceipts.size, 0);
  });
  test("receipt rollback refuses guessed tokens, released handles, altered bytes and linked files", async () => {
    const { v, store, binary } = fixture();
    let handle = await store.importReceipt({ name: "票据.png", data: PNG }, "2026-11-05", "data");
    await assert.rejects(store.removeImportedReceipt({ path: handle.path, token: "guess" }, "data"), /本次/);
    store.releaseImportedReceipt(handle); await assert.rejects(store.removeImportedReceipt(handle, "data"), /本次/); assert.ok(v.files.has(handle.path));
    handle = await store.importReceipt({ name: "票据.png", data: PNG }, "2026-11-05", "data"); binary.set(v.files.get(handle.path), Uint8Array.of(1, 2));
    assert.equal((await store.removeImportedReceipt(handle, "data")).removed, false); assert.ok(v.files.has(handle.path));
    handle = await store.importReceipt({ name: "合同.pdf", data: PDF }, "2026-11-05", "data"); await store.save(fm("linked", { attachments: [handle.path] }));
    assert.equal((await store.removeImportedReceipt(handle, "data")).removed, false); assert.ok(v.files.has(handle.path));
  });
  test("receipt rollback respects archived and ordinary note links", async () => {
    const { v, store } = fixture();
    const handle = await store.importReceipt({ name: "票据 & 报销.png", data: PNG }, "2026-11-05", "data");
    await store.save(fm("archive", { attachments: [handle.path] })); await store.trash((await store.scan()).records[0]);
    assert.equal((await store.removeImportedReceipt(handle, "data")).removed, false); assert.ok(v.files.has(handle.path));
    const other = await store.importReceipt({ name: "合同.pdf", data: PDF }, "2026-11-05", "data"); v.add("其他笔记.md", `收据 [[${other.path}]]`);
    assert.equal((await store.removeImportedReceipt(other, "data")).removed, false); assert.ok(v.files.has(other.path));
  });
  test("receipt rollback never scans notes, reads bytes or deletes files", async () => {
    const { v, store, binary } = fixture();
    const handle = await store.importReceipt({ name: "同时修改.png", data: PNG }, "2026-11-05", "data"), file = v.files.get(handle.path);
    v.add("其他笔记.md", `[[${handle.path}]]`); file.stat.mtime++; binary.set(file, Uint8Array.of(9, 8, 7));
    for (const method of ["getMarkdownFiles", "getFiles", "read", "readBinary", "delete"]) v.app.vault[method] = () => { throw new Error("Unexpected vault access: " + method); };
    const result = await store.removeImportedReceipt(handle, "data"); assert.equal(result.removed, false); assert.ok(v.files.has(handle.path));
    assert.equal(result.reusable, false); assert.equal(store.importedReceipts.size, 0);
    assert.deepEqual([...binary.get(v.files.get(handle.path))], [9, 8, 7]);
  });
  test("receipt imports reject stale roots and report retained upload if root changes during binary write", async () => {
    const { v, store, binary, setRoot } = fixture(); setRoot("other");
    await assert.rejects(store.importReceipt({ name: "x.png", data: PNG }, "2026-11-05", "data"), /目录/); assert.equal(binary.size, 0);
    setRoot("data"); const create = v.app.vault.createBinary;
    v.app.vault.createBinary = async (...args) => { const file = await create(...args); setRoot("other"); return file; };
    await assert.rejects(store.importReceipt({ name: "x.png", data: PNG }, "2026-11-05", "data"), error => {
      assert.match(error.message, /目录/); assert.ok(error.importedReceipt);
      assert.ok(error.message.includes(error.importedReceipt.path));
      assert.equal(error.retainedReceipt.path, error.importedReceipt.path); assert.equal(error.retainedReceipt.removed, false);
      assert.ok(v.files.has(error.importedReceipt.path)); return true;
    });
    assert.equal(binary.size, 1); assert.equal(store.importedReceipts.size, 0);
  });
  test("failed ledger save retains imported receipt without touching existing ledger data", async () => {
    const { v, store, binary } = fixture(); daily(v, [fm("conflict")]);
    const previous = (await store.scan()).records[0], handle = await store.importReceipt({ name: "x.png", data: PNG }, previous.date, "data");
    await store.save(fm("conflict", { amount: "99" }), previous);
    await assert.rejects(store.save(fm("conflict", { attachments: [handle.path] }), previous), /已被修改/);
    assert.equal((await store.removeImportedReceipt(handle, "data")).removed, false); assert.equal(binary.size, 1); assert.equal((await store.scan()).records[0].amountCents, 9900);
  });
  test("receipt editor closing during binary import retains file and notifies its path without saving ledger data", async () => {
    const { v, store, binary } = fixture(), { editor, pick, notices } = editorFixture(store, v.app), entered = deferred(), resume = deferred();
    const create = v.app.vault.createBinary;
    v.app.vault.createBinary = async (...args) => { entered.resolve(); await resume.promise; return create(...args); };
    pick({ name: "临时票据.png", size: PNG.length, arrayBuffer: async () => PNG.buffer });
    const saving = editor.commit(); await entered.promise; editor.destroy(); resume.resolve();
    await assert.rejects(saving, /窗口/); assert.equal(binary.size, 1); assert.equal(v.app.vault.getMarkdownFiles().length, 0);
    const path = [...binary.keys()][0].path; assert.ok(notices.some(text => text.includes(path) && text.includes("保留")));
    assert.equal(store.importedReceipts.size, 0);
  });
  test("receipt editor retries failed saves with the retained file instead of importing duplicates", async () => {
    const { v, store, binary } = fixture(), { editor, pick, notices } = editorFixture(store, v.app);
    pick({ name: "重试.png", size: PNG.length, arrayBuffer: async () => PNG.buffer });
    const first = await editor.commit(); await first.rollback();
    assert.equal(binary.size, 1); assert.equal(store.importedReceipts.size, 0);
    assert.ok(notices[0].includes(first.attachments[0]));
    const retry = await editor.commit(); assert.deepEqual(retry.attachments, first.attachments); assert.equal(binary.size, 1);
    await store.save(fm("retried", { attachments: retry.attachments })); retry.finish();
    assert.deepEqual((await store.scan()).records[0].attachments, first.attachments); editor.destroy();
  });
  test("partial multi-receipt failure retains the first file and imports only the missing file on retry", async () => {
    const { v, store, binary } = fixture(), { editor, pick, notices } = editorFixture(store, v.app);
    const create = v.app.vault.createBinary; let calls = 0;
    v.app.vault.createBinary = async (...args) => { if (++calls === 2) throw new Error("simulated upload failure"); return create(...args); };
    for (const name of ["第一张.png", "第二张.png"]) pick({ name, size: PNG.length, arrayBuffer: async () => PNG.buffer });
    await assert.rejects(editor.commit(), /simulated upload failure/);
    const retainedPath = [...binary.keys()][0].path;
    assert.equal(binary.size, 1); assert.equal(store.importedReceipts.size, 0); assert.ok(notices[0].includes(retainedPath));
    const retry = await editor.commit();
    assert.equal(binary.size, 2); assert.equal(calls, 3); assert.equal(retry.attachments[0], retainedPath);
    await store.save(fm("multi-retried", { attachments: retry.attachments })); retry.finish(); editor.destroy();
    assert.equal((await store.scan()).records[0].attachments.length, 2); assert.equal(store.importedReceipts.size, 0);
  });
  test("receipt rollback settles its original handle after the data folder changes", async () => {
    const { store, binary, setRoot } = fixture();
    const handle = await store.importReceipt({ name: "原目录.png", data: PNG }, "2026-11-05", "data");
    setRoot("other"); const result = await store.removeImportedReceipt(handle, "data");
    assert.equal(result.path, handle.path); assert.equal(result.removed, false);
    assert.equal(binary.size, 1); assert.equal(store.importedReceipts.size, 0);
  });
  test("receipt editor handles folder switch errors without losing retained paths or tokens", async () => {
    const { v, store, binary, setRoot } = fixture(), { editor, pick, notices } = editorFixture(store, v.app);
    const create = v.app.vault.createBinary;
    v.app.vault.createBinary = async (...args) => { const file = await create(...args); setRoot("other"); return file; };
    pick({ name: "切换目录.pdf", size: PDF.length, arrayBuffer: async () => PDF.buffer });
    await assert.rejects(editor.commit(), /目录/);
    const path = [...binary.keys()][0].path;
    assert.equal(binary.size, 1); assert.equal(store.importedReceipts.size, 0); assert.ok(notices[0].includes(path));
    setRoot("data"); const retry = await editor.commit(); assert.deepEqual(retry.attachments, [path]); assert.equal(binary.size, 1);
    retry.finish(); editor.destroy();
  });
  test("receipt editor finish consumes tokens and subsequent rollback never deletes saved receipt", async () => {
    const { v, store, binary } = fixture(), { editor, pick } = editorFixture(store, v.app);
    pick({ name: "已保存票据.png", size: PNG.length, arrayBuffer: async () => PNG.buffer });
    const committed = await editor.commit(); await store.save(fm("finished", { attachments: committed.attachments })); committed.finish();
    assert.equal(store.importedReceipts.size, 0); await committed.rollback(); editor.destroy();
    assert.equal(binary.size, 1); assert.deepEqual((await store.scan()).records[0].attachments, committed.attachments);
  });
}
module.exports = register;
if (require.main === module) {
  const tests = []; register((name, run) => tests.push({ name, run }));
  (async () => { let failures = 0; for (const { name, run } of tests) { try { await run(); console.log("PASS " + name); } catch (error) { failures++; console.error("FAIL " + name + "\n" + error.stack); } } console.log(`${tests.length - failures}/${tests.length} attachment checks passed; all data stayed in memory.`); if (failures) process.exitCode = 1; })();
}
