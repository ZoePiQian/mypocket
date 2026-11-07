"use strict";
const core = require("./core");
const monthly = require("./monthly");
const fixed = require("./fixed");
const projects = require("./projects");
const { createId } = require("./identity");
const { periodPaths } = require("./periods");

class FinanceStore {
  constructor(app, codec, getFolder) {
    this.app = app; this.codec = codec; this.getFolder = getFolder;
    this.pending = Promise.resolve();
    this.parseCache = new Map(); this.cacheEpoch = 0;
  }
  queue(action, readOnly = false) {
    const root = this.folder();
    const next = this.pending.then(async () => {
      this.assertScope(root); this.operationRoot = root;
      try { return await action(); } finally { this.operationRoot = null; if (!readOnly) this.invalidate(); }
    });
    this.pending = next.catch(() => {}); return next;
  }
  folder() {
    const root = core.normalizeFolder(this.getFolder());
    if (this.operationRoot && root !== this.operationRoot) throw new Error("数据目录已改变，请重新打开后再操作；本次输入仍保留");
    return root;
  }
  assertScope(expectedRoot = this.operationRoot, sourcePath = null) {
    const root = core.normalizeFolder(this.getFolder());
    if ((expectedRoot && root !== expectedRoot) || (sourcePath && !sourcePath.startsWith(root + "/")))
      throw new Error("数据目录已改变或记录不属于当前目录，请重新打开后再操作");
    return root;
  }
  invalidate(file = null, oldPath = "") {
    this.cacheEpoch++;
    if (!file) { this.parseCache.clear(); return; }
    for (const path of [file.path, oldPath].filter(Boolean)) {
      for (const cachedPath of this.parseCache.keys()) if (cachedPath === path || cachedPath.startsWith(path + "/")) this.parseCache.delete(cachedPath);
    }
  }
  memoPath() { return `${this.folder()}/备忘录.md`; }
  periodFile(section, month) {
    const paths = periodPaths(this.folder(), section, month);
    const files = [paths.current, paths.legacy].map(path => this.app.vault.getAbstractFileByPath(path)).filter(Boolean);
    if (files.length > 1) throw new Error(`「${section}」${month} 同时存在年份目录和旧目录笔记。两份均保留，请合并后再操作`);
    if (files[0] && files[0].extension !== "md") throw new Error(`「${section}」${month} 的笔记路径被文件夹或其他文件占用`);
    return files[0] || null;
  }
  monthlyFile(month) {
    // The warning list exposes conflicting files; do not make the whole view fail.
    try { return this.periodFile("流水", month); } catch (_) { return null; }
  }
  async preparePeriod(section, month) {
    const root = this.folder(), paths = periodPaths(root, section, month);
    const file = this.periodFile(section, month);
    if (!file || file.path === paths.current) return file;
    const original = await this.app.vault.read(file);
    if (section === "流水") {
      const parsed = monthly.parse(original, file.path, this.codec);
      if (parsed.month !== month || parsed.warnings.length) throw new Error("旧月份流水的属性或表格有误，原笔记已保留，请修正后再迁移");
    } else {
      const fm = core.readFrontmatter(original, this.codec.parseYaml);
      if (fm?.finance_report !== true || fm.month !== month) throw new Error("旧月报的月份属性有误，原笔记已保留");
    }
    await this.ensureFolder(paths.current.slice(0, paths.current.lastIndexOf("/")));
    if (this.folder() !== root || this.app.vault.getAbstractFileByPath(paths.legacy) !== file
      || file.path !== paths.legacy || await this.app.vault.read(file) !== original) throw new Error("迁移时目录或笔记发生改动，未覆盖文件，请刷新重试");
    if (this.app.vault.getAbstractFileByPath(paths.current)) throw new Error("目标月份笔记已经存在，未覆盖，请检查新旧目录");
    // FileManager also updates incoming links and relative links inside the note.
    await this.app.fileManager.renameFile(file, paths.current);
    if (this.app.vault.getAbstractFileByPath(paths.current) !== file || file.path !== paths.current) throw new Error("月份笔记移动尚未完成，请刷新后检查");
    return file;
  }
  async migrateYearFolders() {
    const root = this.folder(), warnings = [];
    // Move ledgers first so reports receive updated source links before they move.
    for (const section of ["流水", "月报"]) {
      const prefix = `${root}/${section}/`;
      const files = this.app.vault.getMarkdownFiles().filter(file => file.path.startsWith(prefix)
        && !file.path.slice(prefix.length).includes("/") && core.validMonth(file.path.slice(prefix.length, -3)));
      for (const file of files) {
        const originalPath = file.path, month = originalPath.slice(prefix.length, -3);
        try {
          if (this.folder() !== root) throw new Error("数据目录已经改变，请刷新后重试");
          await this.preparePeriod(section, month);
        } catch (error) { warnings.push({ path: originalPath, message: `按年整理未完成：${error.message}` }); }
      }
    }
    return warnings;
  }
  activeFiles() {
    const root = this.folder();
    return this.app.vault.getMarkdownFiles().filter(f => f.path.startsWith(root + "/")
      && f.path !== this.memoPath()
      && !f.path.startsWith(`${root}/回收站/`) && !f.path.startsWith(`${root}/旧版备份/`));
  }
  readMemo() {
    return this.queue(async () => {
      const path = this.memoPath();
      await this.ensureFolder(path.slice(0, path.lastIndexOf("/")));
      this.assertScope(undefined, path);
      let file = this.app.vault.getAbstractFileByPath(path);
      if (!file) {
        try { file = await this.app.vault.create(path, ""); }
        catch (error) {
          file = this.app.vault.getAbstractFileByPath(path);
          if (!file) throw error;
        }
      }
      if (file.extension !== "md") throw new Error("备忘录路径已被其他文件或文件夹占用");
      return { path, file, text: await this.app.vault.read(file) };
    });
  }
  saveMemo(previous, text) {
    return this.queue(async () => {
      if (typeof text !== "string") throw new Error("备忘录内容必须是文本");
      const checkFile = () => {
        if (previous.path !== this.memoPath()) throw new Error("账本目录已更改，请先复制当前内容，再重新打开备忘录");
        const file = this.app.vault.getAbstractFileByPath(previous.path);
        if (file !== previous.file || file?.path !== previous.path || file.extension !== "md")
          throw new Error("备忘录已移动或删除，请先复制当前内容，再重新打开备忘录");
        return file;
      };
      const file = checkFile();
      await this.app.vault.process(file, current => {
        checkFile();
        if (current !== previous.text) throw new Error("备忘录已在其他位置修改，未覆盖文件。请先复制当前内容，再重新打开备忘录合并");
        return text;
      });
      return { path: previous.path, file, text };
    });
  }
  async ensureFolder(path) {
    let current = "";
    for (const part of path.split("/")) {
      this.assertScope();
      current = current ? `${current}/${part}` : part;
      if (!this.app.vault.getAbstractFileByPath(current)) {
        try { await this.app.vault.createFolder(current); }
        catch (error) { if (!this.app.vault.getAbstractFileByPath(current)) throw error; }
      }
    }
  }
  parseFile(text, path) {
    const result = { records: [], fixedEntries: [], projects: [], projectRecords: [], warnings: [] };
    try {
      let fm;
      try { fm = core.readFrontmatter(text, this.codec.parseYaml); }
      catch (_) { core.parseRecord(text, path, this.codec.parseYaml); return result; }
      if (fm?.finance_kind === "templates") {
        // Templates are independently validated presets, never financial rows.
        return result;
      } else if (fm?.finance_kind === "project") {
        const parsed = projects.parse(text, path, this.codec);
        result.projects.push(parsed.project); result.projectRecords.push(...parsed.records); result.warnings.push(...parsed.warnings);
      } else if (fm?.finance_kind === "fixed") {
        const parsed = fixed.parse(text, path, this.codec);
        result.fixedEntries.push(...parsed.entries); result.warnings.push(...parsed.warnings);
      } else if (fm?.finance_kind === "monthly") {
        const parsed = monthly.parse(text, path, this.codec);
        result.records.push(...parsed.records); result.warnings.push(...parsed.warnings);
      } else {
        const record = core.parseRecord(text, path, this.codec.parseYaml); if (record) result.records.push(record);
      }
    } catch (error) { result.warnings.push({ path, message: error.message }); }
    return result;
  }
  async readAll({ cached = false } = {}) {
    const root = this.folder(), files = this.activeFiles(), result = { records: [], fixedEntries: [], projects: [], projectRecords: [], warnings: [] };
    const paths = new Set(files.map(f => f.path));
    for (const path of this.parseCache.keys()) if (!paths.has(path)) this.parseCache.delete(path);
    for (let i = 0; i < files.length; i += 20) {
      const batch = await Promise.all(files.slice(i, i + 20).map(async file => {
        const path = file.path, stamp = JSON.stringify([file.stat?.mtime, file.stat?.size]), old = this.parseCache.get(path);
        if (cached && old?.file === file && old.stamp === stamp) return old.parsed;
        const epoch = this.cacheEpoch;
        try {
          const text = await this.app.vault.read(file), parsed = this.parseFile(text, path);
          this.assertScope(root);
          if (epoch === this.cacheEpoch && file.path === path && this.app.vault.getAbstractFileByPath(path) === file) this.parseCache.set(path, { file, stamp, parsed });
          return parsed;
        } catch (error) { return { warnings: [{ path, message: error.message }] }; }
      }));
      for (const parsed of batch) for (const key of Object.keys(result)) result[key].push(...JSON.parse(JSON.stringify(parsed[key] || [])));
    }
    this.assertScope(root); return result;
  }
  async scanData() {
    const warnings = await this.migrateYearFolders();
    let data = await this.readAll({ cached: true });
    const names = data.projects.some(p => p.path === this.folder() + "/专项/" + core.safeName(p.name) + "-" + p.id.slice(0, 8) + ".md");
    warnings.push(...await this.migrateProjectNames(data));
    if (names) { this.invalidate(); data = await this.readAll({ cached: true }); }
    if (data.records.some(r => r.kind !== "investment" && r.storage !== "monthly")) {
      warnings.push(...await this.migrateLegacy(data)); this.invalidate(); data = await this.readAll({ cached: true });
    }
    data.warnings.push(...warnings); return data;
  }
  scan() {
    return this.queue(async () => {
      const data = await this.scanData();
      const uniqueProjects = core.deduplicate(data.projects, data.warnings), validIds = new Set(uniqueProjects.map(p => p.id));
      const uniqueRecords = core.deduplicate([...data.records, ...data.projectRecords], data.warnings);
      return { ...data, records: uniqueRecords.filter(r => r.storage !== "project"), projectRecords: uniqueRecords.filter(r => r.storage === "project" && validIds.has(r.projectId)), projects: uniqueProjects, fixedEntries: core.deduplicate(data.fixedEntries, data.warnings) };
    }, true);
  }
  async appendMonthly(record, suffix = null, allowExisting = false) {
    const month = record.date.slice(0, 7);
    const path = periodPaths(this.folder(), "流水", month).current;
    let file = await this.preparePeriod("流水", month);
    await this.ensureFolder(path.slice(0, path.lastIndexOf("/")));
    const transform = text => {
      this.assertScope();
      const parsed = monthly.parse(text, path, this.codec);
      if (parsed.month !== month) throw new Error("月度流水文件名与 month 属性不一致，请先修正");
      if (parsed.warnings.length) throw new Error("目标月的流水表存在格式错误，请先修正；原笔记未覆盖");
      const same = parsed.records.filter(r => r.id === record.id);
      if (same.length && !(allowExisting && same.length === 1 && monthly.fingerprint(same[0]) === monthly.fingerprint(record)))
        throw new Error("目标月已有相同 ID 的不同记录，未覆盖金额，请检查重复记录");
      let next = same.length ? text : monthly.append(text, record, parsed);
      if (suffix && !next.includes(suffix.marker)) next += suffix.text;
      return next;
    };
    if (file) {
      if (file.extension !== "md") throw new Error("月度流水路径已被其他文件占用");
      await this.app.vault.process(file, transform);
    } else file = await this.app.vault.create(path, transform(monthly.create(month, this.codec)));
    return file;
  }
  async migrateLegacy(data = null) {
    data ||= await this.readAll(); const warnings = [];
    for (const r of data.records.filter(r => r.kind !== "investment" && r.storage !== "monthly")) {
      const copies = data.records.filter(other => other.id === r.id);
      // Retry safely if a previous migration wrote a row before archiving the old note.
      if (copies.length > 1 && !(copies.length === 2 && copies.some(other => other.storage === "monthly" && monthly.fingerprint(other) === monthly.fingerprint(r)))) continue;
      try {
        const file = this.app.vault.getAbstractFileByPath(r.path);
        const original = await this.app.vault.read(file);
        const latest = core.parseRecord(original, r.path, this.codec.parseYaml);
        if (!latest || core.signature(latest.frontmatter) !== core.signature(r.frontmatter)) throw new Error("旧记录在迁移时发生改动，保留原文件，请刷新重试");
        const body = original.replace(/^\uFEFF?---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/, "").trim();
        const marker = `<!-- local-finance-notes:legacy:${encodeURIComponent(r.id)} -->`;
        const suffix = { marker, text: `\n${marker}\n### 旧记录补充说明 · ${r.date} · ${monthly.encode(r.category)}\n\n${body}\n` };
        const destination = await this.appendMonthly(r, suffix, true);
        const verified = monthly.parse(await this.app.vault.read(destination), destination.path, this.codec);
        if (!verified.records.some(other => monthly.fingerprint(other) === monthly.fingerprint(r))) throw new Error("迁移后核对失败，原文件已保留");
        if (await this.app.vault.read(file) !== original) throw new Error("迁移中旧笔记被修改，原文件已保留，请检查重复记录");
        const backup = `${this.folder()}/旧版备份/${r.path.slice(this.folder().length + 1)}.bak`;
        await this.ensureFolder(backup.slice(0, backup.lastIndexOf("/")));
        if (this.app.vault.getAbstractFileByPath(backup)) throw new Error("旧版备份路径已存在，原文件已保留，请检查");
        // Preserve the exact original YAML, custom properties and body without duplicate indexing.
        await this.app.vault.rename(file, backup);
      } catch (error) { warnings.push({ path: r.path, message: `旧版记录迁移未完成：${error.message}` }); }
    }
    return warnings;
  }
  async save(fm, previous = null, body = "") {
    return this.queue(async () => {
      this.assertScope(undefined, previous?.path);
      fm = { ...fm, attachments: fm.attachments === undefined ? previous?.attachments || [] : fm.attachments };
      const record = core.validateRecord(fm);
      fm.attachments = record.attachments;
      if (previous && previous.id !== record.id) throw new Error("编辑时不能改变记录 ID");
      if (record.kind !== "investment") {
        await this.migrateLegacy();
        if (!previous) return this.appendMonthly(record, body ? { marker: `<!-- local-finance-notes:body:${encodeURIComponent(record.id)} -->`, text: `\n<!-- local-finance-notes:body:${encodeURIComponent(record.id)} -->\n${body}\n` } : null);
        const file = this.app.vault.getAbstractFileByPath(previous.path);
        if (!file || file.extension !== "md") throw new Error("原始笔记已移动或删除，请刷新面板后重新打开");
        if (previous.storage !== "monthly") throw new Error("旧记录已迁移，请刷新面板后重新打开编辑");
        const source = monthly.parse(await this.app.vault.read(file), file.path, this.codec);
        this.assertScope(undefined, file.path);
        monthly.checked(source, previous);
        if (record.date.slice(0, 7) === source.month) {
          await this.app.vault.process(file, text => { this.assertScope(undefined, file.path); return monthly.replace(text, monthly.checked(monthly.parse(text, file.path, this.codec), previous), record); });
          return file;
        }
        const destination = await this.appendMonthly(record);
        try {
          await this.app.vault.process(file, text => { this.assertScope(undefined, file.path); return monthly.replace(text, monthly.checked(monthly.parse(text, file.path, this.codec), previous)); });
        } catch (error) {
          try {
            await this.app.vault.process(destination, text => monthly.replace(text, monthly.checked(monthly.parse(text, destination.path, this.codec), record)));
          } catch (_) { throw new Error("跨月移动未完成，两个笔记均已保留，请检查重复 ID 后再编辑"); }
          throw error;
        }
        return destination;
      }
      if (previous) {
        const file = this.app.vault.getAbstractFileByPath(previous.path);
        if (!file || file.extension !== "md") throw new Error("原始笔记已移动或删除，请刷新面板后重新打开");
        await this.app.fileManager.processFrontMatter(file, current => {
          this.assertScope(undefined, file.path);
          if (core.signature(current) !== core.signature(previous.frontmatter)) throw new Error("这篇笔记在打开表单后已被修改。请重新打开编辑，避免覆盖新数据。");
          for (const key of core.MANAGED_FIELDS) delete current[key];
          Object.assign(current, fm);
        });
        return file;
      }
      const folder = `${this.folder()}/理财`;
      await this.ensureFolder(folder);
      const path = `${folder}/${core.safeName(record.name)}-${core.safeName(record.id)}.md`;
      this.assertScope(undefined, path);
      return this.app.vault.create(path, `---\n${this.codec.stringifyYaml(fm).trimEnd()}\n---\n\n# 理财记录\n\n${body || "## 补充说明\n\n可以写下投资原因、关联笔记，或粘贴凭证。"}\n`);
    });
  }
  async trash(record) {
    if (record.storage === "project") return this.trashProjectRecord(record);
    return this.queue(async () => {
      this.assertScope(undefined, record.path);
      const file = this.app.vault.getAbstractFileByPath(record.path);
      if (!file || file.extension !== "md") throw new Error("笔记已经移动或删除");
      if (record.storage === "monthly") {
        const parsed = monthly.parse(await this.app.vault.read(file), file.path, this.codec);
        const current = monthly.checked(parsed, record);
        const folder = `${this.folder()}/回收站`, path = `${folder}/${record.date.slice(0, 4)}.md`;
        await this.ensureFolder(folder);
        const archive = this.app.vault.getAbstractFileByPath(path);
        const append = text => {
          this.assertScope();
          const table = monthly.parseTable(text, path);
          if (table.warnings.length) throw new Error("回收站流水表存在格式错误，本次未删除");
          return table.records.some(r => monthly.fingerprint(r) === monthly.fingerprint(current)) ? text : monthly.append(text, current, table);
        };
        if (archive) await this.app.vault.process(archive, append);
        else await this.app.vault.create(path, append(`# ${record.date.slice(0, 4)} 年已删除流水\n\n这些行不参与统计。恢复时将整行复制回对应月份的流水表，保留 ID。原月笔记的正文仍在原位置。\n\n${monthly.START}\n${monthly.HEADER}\n${monthly.SEPARATOR}\n${monthly.END}\n`));
        await this.app.vault.process(file, text => { this.assertScope(undefined, file.path); return monthly.replace(text, monthly.checked(monthly.parse(text, file.path, this.codec), record)); });
      } else {
        const fm = core.readFrontmatter(await this.app.vault.read(file), this.codec.parseYaml);
        if (!fm || core.signature(fm) !== core.signature(record.frontmatter)) throw new Error("笔记已修改，请刷新后再操作");
        this.assertScope(undefined, file.path);
        await this.app.vault.trash(file, false);
      }
    });
  }
  saveFixed(value, previous = null) {
    return this.queue(async () => {
      this.assertScope(undefined, previous?.path);
      const entry = fixed.validate(value);
      if (entry.projectId) await this.loadProject(entry.projectId);
      if (previous && (entry.id !== previous.id || entry.year !== previous.year)) throw new Error("编辑时不能改变 ID 或所属年份");
      if (previous && (entry.cycle !== previous.cycle || entry.firstDate !== previous.firstDate)) {
        const data = await this.readAll();
        if (data.warnings.length) throw new Error("账本有格式问题，请先修正后再修改付款安排");
        if ([...data.records, ...data.projectRecords].some(r => r.id.startsWith(`${fixed.PREFIX}${entry.id}-`))) throw new Error("已有付款记录，不能修改周期或首次付款日。可停用原项目，再新增一项；历史付款保留。");
      }
      const folder = `${this.folder()}/固定支出`, path = previous?.path || `${folder}/${entry.year}.md`;
      await this.ensureFolder(folder);
      let file = this.app.vault.getAbstractFileByPath(path);
      if (previous && !file) throw new Error("原年度笔记已移动或删除，请刷新后重新打开");
      const transform = text => {
        this.assertScope(undefined, path);
        const parsed = fixed.parse(text, path, this.codec);
        if (parsed.year !== entry.year || parsed.warnings.length) throw new Error("年度固定支出属性或表格有误，原笔记未覆盖");
        if (previous) { fixed.checked(parsed, previous); return fixed.write(text, parsed, entry, previous); }
        if (parsed.entries.some(e => e.id === entry.id)) throw new Error("这个固定支出 ID 已存在");
        return fixed.write(text, parsed, entry);
      };
      if (file) await this.app.vault.process(file, transform);
      else file = await this.app.vault.create(path, transform(fixed.create(entry.year, this.codec)));
      return file;
    });
  }
  copyFixedYear(year, makeId = createId) {
    return this.queue(async () => {
      if (!fixed.validYear(year) || Number(year) === 1900) throw new Error("无法读取上年度，请选择有效年份");
      const data = await this.readAll();
      if (data.warnings.length) throw new Error("账本有格式问题，请先修正后再沿用清单");
      if (data.fixedEntries.some(e => e.year === String(year))) throw new Error("本年已有固定支出清单，未重复复制");
      const source = data.fixedEntries.filter(e => e.year === String(Number(year) - 1) && e.status === "active");
      if (!source.length) throw new Error("上年度没有启用的固定支出项目");
      if (source.some(e => data.fixedEntries.filter(other => other.id === e.id).length !== 1)) throw new Error("上年清单存在重复 ID，请先修正");
      const entries = source.map(e => fixed.validate(fixed.carry(e, year, makeId())));
      if (new Set(entries.map(e => e.id)).size !== entries.length || entries.some(e => data.fixedEntries.some(other => other.id === e.id))) throw new Error("新清单 ID 重复，未写入");
      const folder = `${this.folder()}/固定支出`, path = `${folder}/${year}.md`;
      await this.ensureFolder(folder);
      const transform = text => {
        this.assertScope(undefined, path);
        const parsed = fixed.parse(text, path, this.codec);
        if (parsed.year !== String(year) || parsed.warnings.length || parsed.entries.length) throw new Error("目标年笔记有问题或已有项目，未覆盖");
        let next = text;
        for (const entry of entries) next = fixed.write(next, fixed.parse(next, path, this.codec), entry);
        return next;
      };
      const file = this.app.vault.getAbstractFileByPath(path);
      if (file) { await this.app.vault.process(file, transform); return file; }
      return this.app.vault.create(path, transform(fixed.create(year, this.codec)));
    });
  }
  payFixed(previous, scheduledDate, values, asOf = core.today()) {
    return this.queue(async () => {
      this.assertScope(undefined, previous.path);
      const data = await this.readAll();
      if (data.warnings.length) throw new Error("账本有格式问题，请先修正后再确认付款，避免重复记账");
      const candidates = data.fixedEntries.filter(e => e.id === previous.id);
      if (candidates.length !== 1 || fixed.signature(candidates[0]) !== fixed.signature(previous)) throw new Error("固定支出清单已修改，请刷新后重新确认");
      const entry = candidates[0];
      if (entry.status !== "active") throw new Error("此项目已停用，请先在清单中启用");
      if (!fixed.dates(entry).includes(scheduledDate)) throw new Error("所选期次不属于本年清单");
      if (!core.validDate(values.date) || !values.date.startsWith(entry.year + "-") || values.date > asOf) throw new Error("实际付款日须在所属年份内，且不晚于今天");
      const id = fixed.paymentId(entry, scheduledDate);
      if ([...data.records, ...data.projectRecords].some(r => r.id === id)) throw new Error("这期付款已经记录，未重复添加支出");
      const memo = values.memo ?? entry.memo;
      if (typeof memo !== "string" || memo.length > 1500) throw new Error("付款备注最多 1500 字");
      const record = core.validateRecord({ finance_schema: 1, finance_kind: "expense", id, currency: values.currency || entry.currency || "CNY", fx: values.fx || null, date: values.date,
        amount: values.amount, category: fixed.CATEGORY, account: values.account ?? entry.account, attachments: values.attachments,
        memo: `${entry.name}（${entry.cycle === "yearly" ? "年付" : "月付"} · ${scheduledDate}）${memo ? " · " + memo : ""}` });
      return entry.projectId ? this.appendProject(entry.projectId, record) : this.appendMonthly(record);
    });
  }
  async report(month, code = "CNY", prepare = async data => data) {
    return this.queue(async () => {
      // A saved report must reread its sources even if a sync provider missed an event.
      this.invalidate();
      const data = await this.scanData();
      const unique = core.deduplicate([...data.records, ...data.projectRecords], data.warnings);
      const prepared = await prepare({ ...data, records: unique.filter(r => r.storage !== "project") });
      const summary = core.summarize(prepared.records, month, core.today(), code);
      if (summary.missingFx.length) throw new Error("月报所需汇率不完整，请联网刷新面板后再生成；原月报已保留");
      const section = core.reportSection(summary, data.warnings);
      const path = periodPaths(this.folder(), "月报", month).current;
      const file = await this.preparePeriod("月报", month);
      await this.ensureFolder(path.slice(0, path.lastIndexOf("/")));
      if (file) {
        if (file.extension !== "md") throw new Error("月报路径被其他文件占用");
        await this.app.vault.process(file, text => {
          this.assertScope(undefined, file.path);
          const fm = core.readFrontmatter(text, this.codec.parseYaml);
          if (fm?.finance_report !== true || fm.month !== month) throw new Error("月报属性或月份不匹配，原笔记未覆盖");
          return core.replaceReport(text, section);
        }); return file;
      }
      this.assertScope(undefined, path);
      return this.app.vault.create(path, `---\nfinance_report: true\nmonth: "${month}"\ntags: [财务, 月报]\n---\n\n# ${month} 财务月报\n\n${section}\n\n## 我的月度复盘\n\n- 本月哪类消费最值得？\n- 下个月想调整什么？\n- 理财记录与实际账户是否一致？\n`);
    });
  }
}
Object.assign(FinanceStore.prototype, require("./projects-store"), require("./recovery-store"), require("./attachments-store"), require("./templates-store"));
module.exports = { FinanceStore };
