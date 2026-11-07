"use strict";
const templates = require("./templates"), { createId } = require("./identity");
module.exports = {
  async readTemplates() {
    const root = this.folder(), path = `${root}/常用模板.md`, file = this.app.vault.getAbstractFileByPath(path);
    if (file && file.extension !== "md") throw new Error("常用模板.md 的位置已被文件夹占用");
    const text = file ? await this.app.vault.read(file) : templates.create(this.codec);
    this.assertScope(root, path);
    return { root,path,file,text,...templates.parse(text,path,this.codec) };
  },
  listTemplates() {
    return this.queue(async () => { const data = await this.readTemplates(); return {root:data.root,templates:data.templates.map(t => ({...t,root:data.root})),warnings:[]}; }, true);
  },
  saveTemplate(value, previous = null, expectedRoot = null) {
    return this.queue(async () => {
      this.assertScope(expectedRoot || previous?.root, previous?.path);
      const data = await this.readTemplates(), next = templates.validate({...value,id:previous?.id || createId()});
      if (!previous && data.templates.some(t => t.id === next.id)) throw new Error("模板 ID 冲突，请重新保存");
      const old = previous && data.templates.find(t => t.id === previous.id);
      if (previous && (!old || templates.fingerprint(old) !== templates.fingerprint(previous))) throw new Error("此模板已在其他位置修改或删除，请重新打开；本次未覆盖");
      if (data.templates.some(t => t.id !== next.id && t.context === next.context && t.projectId === next.projectId && t.name.toLocaleLowerCase() === next.name.toLocaleLowerCase())) throw new Error("同一范围已存在这个模板名称，请换一个名字");
      if (next.context === "project") { const project = await this.loadProject(next.projectId); if (!project || project.project.status !== "active") throw new Error("请选择一个正在使用的专项"); }
      const items = previous ? data.templates.map(t => t.id === next.id ? next : t) : [...data.templates,next];
      await this.commitProjectEdits([{path:data.path,oldText:data.file ? data.text : null,newText:templates.replace(data.text,items)}]);
      return {...next,path:data.path,root:data.root};
    });
  },
  deleteTemplate(previous, expectedRoot = null) {
    return this.queue(async () => {
      this.assertScope(expectedRoot || previous.root, previous.path);
      const data = await this.readTemplates(), old = data.templates.find(t => t.id === previous.id);
      if (!old || templates.fingerprint(old) !== templates.fingerprint(previous)) throw new Error("此模板已在其他位置修改或删除，请重新打开；本次未删除");
      await this.commitProjectEdits([{path:data.path,oldText:data.text,newText:templates.replace(data.text,data.templates.filter(t => t.id !== previous.id))}]);
    });
  }
};
