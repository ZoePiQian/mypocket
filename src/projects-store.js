"use strict";
const core = require("./core"), table = require("./monthly"), projects = require("./projects"), { periodPaths } = require("./periods");

module.exports = {
  async projectDestination(project, ownFile = null) {
    const root = this.folder(), path = `${root}/专项/${projects.fileName(project.name)}`;
    const entries = (await this.readAll()).projects;
    if (entries.some(p => p.path !== ownFile?.path && projects.nameKey(p.name) === projects.nameKey(project.name))) {
      throw new Error(`已存在名为「${project.name}」的专项，请使用不同名称；已归档专项也不能重名`);
    }
    const directory = this.app.vault.getAbstractFileByPath(`${root}/专项`);
    const occupants = [this.app.vault.getAbstractFileByPath(path), ...(directory?.children || [])];
    if (occupants.some(file => file && file !== ownFile && projects.nameKey(file.path) === projects.nameKey(path))) {
      throw new Error(`笔记「${project.name}.md」已存在或路径被占用，未覆盖文件，请使用其他名称`);
    }
    if (this.folder() !== root) throw new Error("数据目录已改变，请重新打开专项后再操作");
    return path;
  },
  async renameProjectFile(file, path, expected) {
    if (file.path === path) return file;
    const root = this.folder(), oldPath = file.path;
    if (!oldPath.startsWith(root + "/") || await this.projectDestination(expected, file) !== path) throw new Error("专项目录已改变，请刷新后再试");
    const parsed = projects.parse(await this.app.vault.read(file), oldPath, this.codec);
    if (parsed.warnings.length || projects.signature(parsed.project) !== projects.signature(expected)) throw new Error("专项笔记已经改变，请刷新后再整理文件名");
    if (this.folder() !== root || file.path !== oldPath || this.app.vault.getAbstractFileByPath(oldPath) !== file) throw new Error("专项笔记已移动，未覆盖文件");
    // Obsidian updates incoming and relative links according to the vault's settings.
    await this.app.fileManager.renameFile(file, path);
    if (file.path !== path || this.app.vault.getAbstractFileByPath(path) !== file) throw new Error("专项文件名整理尚未完成，请刷新检查");
    return file;
  },
  async migrateProjectNames(snapshot = null) {
    const root = this.folder(), data = snapshot || await this.readAll(), warnings = [], names = new Map(), ids = new Map();
    for (const p of data.projects) {
      const key = projects.nameKey(p.name);
      names.set(key, (names.get(key) || 0) + 1); ids.set(p.id, (ids.get(p.id) || 0) + 1);
    }
    for (const p of data.projects) {
      if (names.get(projects.nameKey(p.name)) > 1) {
        warnings.push({ path: p.path, message: `专项名称「${p.name}」重复，两份均保留，请编辑其中一个专项并使用不同名称（含已归档专项）` });
        continue;
      }
      if (ids.get(p.id) > 1) continue;
      // Only migrate the exact old generated filename; respect manually chosen paths.
      if (p.path !== `${root}/专项/${core.safeName(p.name)}-${p.id.slice(0, 8)}.md`) continue;
      const file = this.app.vault.getAbstractFileByPath(p.path);
      try {
        if (this.folder() !== root) throw new Error("数据目录已改变，请刷新后重试");
        const destination = await this.projectDestination(p, file);
        await this.renameProjectFile(file, destination, p);
      } catch (error) { warnings.push({ path: file?.path || p.path, message: `专项文件名整理未完成：${error.message}` }); }
    }
    return warnings;
  },
  async loadProject(id) {
    projects.projectId(id);
    const matches = (await this.readAll()).projects.filter(p => p.id === id);
    if (matches.length !== 1) throw new Error("专项已移动、删除或 ID 重复，请刷新后检查");
    const file = this.app.vault.getAbstractFileByPath(matches[0].path);
    if (!file || file.extension !== "md") throw new Error("专项笔记不存在");
    const text = await this.app.vault.read(file), parsed = projects.parse(text, file.path, this.codec);
    if (parsed.warnings.length) throw new Error("专项表格有格式问题，请先修正后再保存");
    return { file, text, parsed, project: parsed.project };
  },
  async commitProjectEdits(edits) {
    const root = this.folder(), completed = [];
    this.invalidate();
    if (new Set(edits.map(e => e.path)).size !== edits.length) throw new Error("重复的写入目标");
    for (const edit of edits) {
      if (!edit.path.startsWith(root + "/")) throw new Error("写入目标不属于当前数据目录");
      edit.file = this.app.vault.getAbstractFileByPath(edit.path);
      if (edit.oldText === null ? !!edit.file : !edit.file || await this.app.vault.read(edit.file) !== edit.oldText) throw new Error("笔记已被其他位置修改，请刷新后重试；本次未移动");
    }
    try {
      for (const edit of edits) {
        if (this.folder() !== root) throw new Error("数据目录已改变，移动已停止");
        if (edit.oldText === null) {
          await this.ensureFolder(edit.path.slice(0, edit.path.lastIndexOf("/")));
          this.assertScope(root, edit.path);
          edit.file = await this.app.vault.create(edit.path, edit.newText);
        } else {
          if (this.app.vault.getAbstractFileByPath(edit.path) !== edit.file) throw new Error("笔记路径已改变，请刷新重试");
          await this.app.vault.process(edit.file, current => {
            this.assertScope(root, edit.path);
            if (current !== edit.oldText) throw new Error("笔记在移动时被修改，本次停止");
            return edit.newText;
          });
        }
        completed.push(edit);
      }
    } catch (error) {
      let conflict = false;
      for (const edit of completed.reverse()) {
        try {
          if (this.app.vault.getAbstractFileByPath(edit.path) !== edit.file) throw new Error("路径改变");
          if (edit.oldText === null) {
            if (await this.app.vault.read(edit.file) !== edit.newText) throw new Error("内容改变");
            await this.app.vault.delete(edit.file);
          } else await this.app.vault.process(edit.file, current => { if (current !== edit.newText) throw new Error("内容改变"); return edit.oldText; });
        } catch (_) { conflict = true; }
      }
      if (conflict) throw new Error("移动中遇到同步修改，相关笔记均保留。请刷新检查重复 ID 提示后再操作，勿再次批量迁移。");
      throw error;
    }
  },
  saveProject(value, previous = null) {
    return this.queue(async () => {
      this.assertScope(undefined, previous?.path);
      const next = projects.validate(value);
      if (previous) {
        if (next.id !== previous.id) throw new Error("编辑时不能改变专项 ID");
        const current = await this.loadProject(previous.id);
        if (projects.signature(current.project) !== projects.signature(previous)) throw new Error("专项设置已经改变，请重新打开编辑");
        const path = await this.projectDestination(next, current.file), oldPath = current.file.path;
        const newText = projects.updateMetadata(current.text, next, this.codec);
        await this.commitProjectEdits([{ path: oldPath, oldText: current.text, newText }]);
        try { await this.renameProjectFile(current.file, path, next); }
        catch (error) {
          let restored = false;
          if (current.file.path === oldPath && this.app.vault.getAbstractFileByPath(oldPath) === current.file) {
            try {
              await this.app.vault.process(current.file, text => {
                if (projects.signature(projects.parse(text, oldPath, this.codec).project) !== projects.signature(next)) throw new Error("专项设置已在其他位置修改");
                return text === newText ? current.text : projects.updateMetadata(text, current.project, this.codec);
              });
              restored = true;
            } catch (_) { /* Preserve concurrent edits if a safe rollback is impossible. */ }
          }
          throw new Error(restored ? `文件重命名未完成，本次设置未保存：${error.message}` : `专项设置已保存，文件名整理未能完整完成；笔记已保留，请刷新检查：${error.message}`);
        }
        return current.file;
      }
      if ((await this.readAll()).projects.some(p => p.id === next.id)) throw new Error("专项 ID 已存在");
      const path = await this.projectDestination(next);
      await this.commitProjectEdits([{ path, oldText: null, newText: projects.create(next, this.codec) }]);
      return this.app.vault.getAbstractFileByPath(path);
    });
  },
  async appendProject(id, record) {
    const current = await this.loadProject(id);
    if (current.project.status !== "active") throw new Error("专项已归档，请先重新启用再记账");
    if (!["expense", "refund"].includes(record.kind)) throw new Error("专项仅记录支出和退款");
    const data = await this.readAll();
    if ([...data.records, ...data.projectRecords].some(r => r.id === record.id)) throw new Error("记录 ID 已存在，未重复记账");
    let text = table.append(current.text, record, current.parsed);
    if (!current.project.categories.includes(record.category)) {
      if (current.project.categories.length >= 100) throw new Error("专项分类最多 100 个，请先整理分类");
      text = projects.updateMetadata(text, { ...current.project, categories: [...current.project.categories, record.category] }, this.codec);
    }
    await this.commitProjectEdits([{ path: current.file.path, oldText: current.text, newText: text }]);
    return current.file;
  },
  saveProjectRecord(id, fm, previous = null) {
    return this.queue(async () => {
      this.assertScope(undefined, previous?.path);
      const record = core.validateRecord({ ...fm, attachments: fm.attachments === undefined ? previous?.attachments || [] : fm.attachments });
      if (!["expense", "refund"].includes(record.kind)) throw new Error("专项仅记录支出和退款");
      if (!previous) return this.appendProject(id, record);
      if (previous.projectId !== id || previous.id !== record.id) throw new Error("不能改变所属专项或记录 ID");
      const current = await this.loadProject(id);
      const actual = table.checked(current.parsed, previous);
      let text = table.replace(current.text, actual, record);
      if (!current.project.categories.includes(record.category)) {
        if (current.project.categories.length >= 100) throw new Error("专项分类最多 100 个，请先整理分类");
        text = projects.updateMetadata(text, { ...current.project, categories: [...current.project.categories, record.category] }, this.codec);
      }
      await this.commitProjectEdits([{ path: current.file.path, oldText: current.text, newText: text }]);
      return current.file;
    });
  },
  moveToProject(id, previousRecords) {
    return this.queue(async () => {
      for (const record of previousRecords) this.assertScope(undefined, record.path);
      if (!previousRecords.length || new Set(previousRecords.map(r => r.id)).size !== previousRecords.length) throw new Error("请选择不重复的日常记录");
      const target = await this.loadProject(id), data = await this.readAll();
      if (target.project.status !== "active") throw new Error("专项已归档，请先重新启用");
      const edits = new Map(), months = new Set(); let targetText = target.text;
      for (const r of previousRecords) {
        if (r.storage !== "monthly" || !["expense", "refund"].includes(r.kind)) throw new Error("仅可移入日常流水中的支出与退款");
        if ([...data.records, ...data.projectRecords].filter(other => other.id === r.id).length !== 1) throw new Error("记录 ID 重复或已移动，请刷新后重新选择");
        if (!edits.has(r.path)) { const file = this.app.vault.getAbstractFileByPath(r.path); if (!file) throw new Error("原月笔记已移动"); const text = await this.app.vault.read(file); edits.set(r.path, { path: r.path, oldText: text, newText: text }); }
        const source = edits.get(r.path), parsed = table.parse(source.newText, r.path, this.codec);
        const current = table.checked(parsed, r);
        source.newText = table.replace(source.newText, current);
        targetText = table.append(targetText, current, projects.parse(targetText, target.file.path, this.codec));
        months.add(r.date.slice(0, 7));
        const marker = `<!-- local-finance-notes:source:${encodeURIComponent(r.path)} -->`;
        if (!targetText.includes(marker)) targetText += `\n${marker}\n原月的补充说明与凭证：${core.noteLink(r.path, r.date.slice(0, 7) + " 日常笔记")}。\n`;
      }
      const categories = [...new Set([...target.project.categories, ...previousRecords.map(r => r.category)])];
      if (categories.length > 100) throw new Error("移入后专项分类超过 100 个，请先整理分类");
      targetText = projects.updateMetadata(targetText, { ...target.project, categories }, this.codec);
      await this.commitProjectEdits([{ path: target.file.path, oldText: target.text, newText: targetText }, ...edits.values()]);
      return { count: previousRecords.length, months: [...months].sort(), path: target.file.path };
    });
  },
  moveProjectRecordToDaily(previous) {
    return this.queue(async () => {
      this.assertScope(undefined, previous.path);
      const current = await this.loadProject(previous.projectId), actual = table.checked(current.parsed, previous);
      const month = previous.date.slice(0, 7), destination = await this.preparePeriod("流水", month);
      const path = periodPaths(this.folder(), "流水", month).current, text = destination ? await this.app.vault.read(destination) : table.create(month, this.codec);
      const parsed = table.parse(text, path, this.codec), data = await this.readAll();
      if (parsed.month !== month) throw new Error("目标流水的月份属性与记录日期不一致，请修正后再移动；原记录保留");
      if (parsed.warnings.length || [...data.records, ...data.projectRecords].filter(r => r.id === previous.id).length !== 1) throw new Error("笔记有格式问题或记录 ID 重复，请刷新检查");
      await this.commitProjectEdits([{ path, oldText: destination ? text : null, newText: table.append(text, actual, parsed) }, { path: current.file.path, oldText: current.text, newText: table.replace(current.text, actual) }]);
      return { count: 1, months: [month], path };
    });
  },
  trashProjectRecord(previous) {
    return this.queue(async () => {
      this.assertScope(undefined, previous.path);
      const current = await this.loadProject(previous.projectId), actual = table.checked(current.parsed, previous);
      const path = `${this.folder()}/回收站/专项/${previous.projectId}.md`, file = this.app.vault.getAbstractFileByPath(path);
      const text = file ? await this.app.vault.read(file) : projects.create({ ...current.project, status: "archived" }, this.codec), parsed = projects.parse(text, path, this.codec);
      if (parsed.warnings.length || parsed.project.id !== previous.projectId) throw new Error("回收站格式或专项 ID 有误，请先检查");
      const archived = parsed.records.some(r => table.fingerprint(r) === table.fingerprint(actual));
      await this.commitProjectEdits([{ path, oldText: file ? text : null, newText: archived ? text : table.append(text, actual, parsed) }, { path: current.file.path, oldText: current.text, newText: table.replace(current.text, actual) }]);
    });
  }
};
