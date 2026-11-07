"use strict";
const core = require("./core"), table = require("./monthly"), projects = require("./projects");
const { periodPaths } = require("./periods");

function key(record) { return JSON.stringify([record.path, record.offset, table.fingerprint(record)]); }
function archiveType(root, path) {
  if (path.startsWith(`${root}/回收站/专项/`) && !path.slice(`${root}/回收站/专项/`.length).includes("/") && path.endsWith(".md")) return "project";
  if (new RegExp(`^\\d{4}\\.md$`).test(path.slice(`${root}/回收站/`.length)) && path.startsWith(`${root}/回收站/`)) return "daily";
  throw new Error("不是可恢复的流水回收站笔记");
}
function parseArchive(store, root, text, path) {
  const type = archiveType(root, path);
  return type === "project" ? projects.parse(text, path, store.codec) : table.parseTable(text, path);
}
function exactRow(parsed, item) {
  if (parsed.warnings.length) throw new Error("笔记有格式问题，请先修正后再恢复或处理重复记录");
  const found = parsed.records.find(record => record.offset === item.offset && key(record) === item.key);
  if (!found) throw new Error("记录版本已经改变，请刷新列表后重新选择");
  return found;
}
function archiveText(year) {
  return `# ${year} 年已删除流水\n\n这些行不参与统计。可在 MyPocket 的「恢复与检查」中选择版本恢复。\n\n${table.START}\n${table.HEADER}\n${table.SEPARATOR}\n${table.END}\n`;
}

module.exports = {
  listRecovery() {
    return this.queue(async () => {
      const root = this.folder(), items = [], warnings = [];
      const files = this.app.vault.getMarkdownFiles().filter(file => file.path.startsWith(`${root}/回收站/`));
      for (const file of files) {
        try {
          const text = await this.app.vault.read(file), parsed = parseArchive(this, root, text, file.path);
          warnings.push(...parsed.warnings);
          if (parsed.warnings.length) continue;
          for (const record of parsed.records) items.push({ key: key(record), root, path: file.path, text, record, offset: record.offset,
            projectId: parsed.project?.id || "", projectName: parsed.project?.name || "",
            destination: parsed.project ? `专项：${parsed.project.name}` : periodPaths(root, "流水", record.date.slice(0, 7)).current });
        } catch (error) { warnings.push({ path: file.path, message: error.message }); }
      }
      this.assertScope(root);
      items.sort((a, b) => b.record.date.localeCompare(a.record.date) || b.offset - a.offset);
      return { items, warnings };
    }, true);
  },
  restoreRecovery(item) {
    return this.queue(async () => {
      const root = this.assertScope(item.root, item.path), file = this.app.vault.getAbstractFileByPath(item.path);
      if (!file || file.extension !== "md") throw new Error("回收站笔记已移动或删除，请刷新");
      const text = await this.app.vault.read(file);
      if (text !== item.text) throw new Error("回收站已改变，请刷新后再恢复");
      const parsed = parseArchive(this, root, text, item.path), record = exactRow(parsed, item);
      const data = await this.readAll();
      if (data.warnings.length) throw new Error("账本有格式问题，请先修正后再恢复，避免重复记账");
      if ([...data.records, ...data.projectRecords].some(r => r.id === record.id)) throw new Error("此 ID 的记录已经存在于账本中，未重复恢复；如有冲突请先处理重复记录");
      let destination, oldText, next;
      if (parsed.project) {
        const target = await this.loadProject(parsed.project.id);
        if (target.project.status !== "active") throw new Error("原专项已归档，请先在编辑专项中重新启用后恢复");
        destination = target.file.path; oldText = target.text;
        next = table.append(oldText, record, target.parsed);
        if (!target.project.categories.includes(record.category)) {
          if (target.project.categories.length >= 100) throw new Error("专项分类已达上限，请先整理分类");
          next = projects.updateMetadata(next, { ...target.project, categories: [...target.project.categories, record.category] }, this.codec);
        }
      } else {
        const month = record.date.slice(0, 7), target = await this.preparePeriod("流水", month);
        destination = periodPaths(root, "流水", month).current;
        oldText = target ? await this.app.vault.read(target) : null;
        const content = oldText ?? table.create(month, this.codec), targetParsed = table.parse(content, destination, this.codec);
        if (targetParsed.month !== month || targetParsed.warnings.length) throw new Error("目标月笔记的月份或表格有误，未恢复；回收站记录保留");
        next = table.append(content, record, targetParsed);
      }
      this.assertScope(root);
      await this.commitProjectEdits([{ path: destination, oldText, newText: next }, { path: item.path, oldText: text, newText: table.replace(text, record) }]);
      return { path: destination, count: 1, months: parsed.project ? [] : [record.date.slice(0, 7)] };
    });
  },
  listDuplicates() {
    return this.queue(async () => {
      const root = this.folder(), data = await this.readAll(), groups = [], byId = new Map(), texts = new Map();
      for (const record of [...data.records, ...data.projectRecords]) {
        if (!byId.has(record.id)) byId.set(record.id, []);
        byId.get(record.id).push(record);
      }
      const warnings = [...data.warnings];
      core.deduplicate(data.projects, warnings);
      core.deduplicate(data.fixedEntries, warnings);
      for (const [id, records] of byId) {
        if (records.length < 2) continue;
        if (records.some(r => !["monthly", "project"].includes(r.storage))) {
          warnings.push({ path: records[0].path, message: "旧单笔笔记或理财存在重复 ID，请打开笔记核对；此处仅处理日常与专项流水行" }); continue;
        }
        const items = [];
        for (const record of records) {
          if (!texts.has(record.path)) {
            const file = this.app.vault.getAbstractFileByPath(record.path);
            if (!file) throw new Error("笔记已移动，请刷新后重新检查");
            texts.set(record.path, await this.app.vault.read(file));
          }
          const text = texts.get(record.path), parsed = record.storage === "project" ? projects.parse(text, record.path, this.codec) : table.parse(text, record.path, this.codec);
          const item = { key: key(record), path: record.path, text, offset: record.offset, record, projectName: parsed.project?.name || "" };
          exactRow(parsed, item); items.push(item);
        }
        groups.push({ id, root, items });
      }
      this.assertScope(root); return { groups, warnings };
    }, true);
  },
  resolveDuplicate(group, keepItem) {
    return this.queue(async () => {
      const root = this.assertScope(group.root), selected = group.items.find(item => item.key === keepItem.key);
      if (!selected || selected.record.id !== group.id || group.items.length < 2) throw new Error("请选择需要保留的一个版本");
      const data = await this.readAll();
      if (data.warnings.length) throw new Error("账本有格式问题，请先修正后再处理重复记录");
      if (data.projects.some(p => data.projects.filter(other => other.id === p.id).length > 1)) throw new Error("专项本身的 ID 重复，请先打开专项笔记核对；此处只处理流水记录的重复版本");
      const current = [...data.records, ...data.projectRecords].filter(record => record.id === group.id);
      if (current.length !== group.items.length || current.some(record => !group.items.some(item => item.key === key(record)))) throw new Error("重复记录已发生变化，请刷新后重新核对");
      const sources = new Map(), archives = new Map(), months = new Set();
      for (const item of group.items) {
        this.assertScope(root, item.path);
        if (!sources.has(item.path)) {
          const file = this.app.vault.getAbstractFileByPath(item.path), text = file && await this.app.vault.read(file);
          if (!file || text !== item.text) throw new Error("笔记已在其他位置修改，请刷新；本次未移除记录");
          const parsed = item.record.storage === "project" ? projects.parse(text, item.path, this.codec) : table.parse(text, item.path, this.codec);
          sources.set(item.path, { path: item.path, oldText: text, newText: text, parsed, remove: [] });
        }
        const source = sources.get(item.path), record = exactRow(source.parsed, item);
        if (item.key === selected.key) continue;
        const project = source.parsed.project, year = record.date.slice(0, 4);
        const path = project ? `${root}/回收站/专项/${project.id}.md` : `${root}/回收站/${year}.md`;
        if (!archives.has(path)) {
          const file = this.app.vault.getAbstractFileByPath(path), oldText = file ? await this.app.vault.read(file) : null;
          archives.set(path, { path, oldText, newText: oldText ?? (project ? projects.create({ ...project, status: "archived" }, this.codec) : archiveText(year)) });
        }
        const archive = archives.get(path), parsed = parseArchive(this, root, archive.newText, path);
        if (parsed.warnings.length || (project && parsed.project?.id !== project.id)) throw new Error("回收站格式或所属专项有误，未处理重复记录");
        if (!parsed.records.some(r => table.fingerprint(r) === table.fingerprint(record))) archive.newText = table.append(archive.newText, record, parsed);
        source.remove.push(record);
        if (!project) months.add(record.date.slice(0, 7));
      }
      for (const source of sources.values()) for (const record of source.remove.sort((a, b) => b.offset - a.offset)) source.newText = table.replace(source.newText, record);
      // Include unchanged survivor files in the transaction for a final compare-and-swap.
      await this.commitProjectEdits([...archives.values(), ...sources.values()]);
      return { path: selected.path, count: group.items.length - 1, months: [...months].sort() };
    });
  }
};
