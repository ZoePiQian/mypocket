"use strict";
const { Notice, Scope } = require("obsidian"), core = require("./core"), currency = require("./currency");

function createTemplatesUI({ PocketModal,el,button,inputField,selectField,empty }) {
  const scopeKey = t => t?.context === "project" ? t.projectId : "";
  const formValue = (fields, context, projectId) => ({context,projectId:projectId || "",kind:fields.kind.value,category:fields.category.value.trim(),account:fields.account.value.trim(),amount:fields.amount.value.trim(),currency:fields.currency.value,memo:fields.memo.value.trim()});

  class TemplateEditorModal extends PocketModal {
    constructor(plugin, previous = null, seed = {}, afterSave = null) { super(plugin.app); this.plugin=plugin; this.previous=previous; this.seed=seed; this.afterSave=afterSave; }
    onOpen() { this.closed=false; this.contentEl.classList.add("lfn-modal"); this.plugin.run(() => this.draw()); }
    async draw() {
      const p=this.plugin, old=this.previous, value=old || this.seed, data=await p.store.scan();
      if (this.closed) return;
      this.assertDataRoot(); this.contentEl.replaceChildren();
      el(this.contentEl,"h2","",old ? "编辑常用模板" : "保存常用模板");
      el(this.contentEl,"p","lfn-help","模板只预填类型、分类、账户、可选金额、币种和备注；不会生成账目，也不会保存日期、汇率或凭证。");
      const form=el(this.contentEl,"form"), grid=el(form,"div","lfn-form-grid");
      const name=inputField(grid,"模板名称 *","template_name",value.name || ""); name.required=true; name.maxLength=120;
      const projects=(data.projects || []).filter(project => project.status === "active" || project.id === value.projectId);
      const choices=[["","日常记账"],...projects.map(project => [project.id,`专项 · ${project.name}${project.status === "archived" ? "（已归档）" : ""}`])];
      if (value.projectId && !choices.some(([id])=>id===value.projectId)) choices.push([value.projectId,"原专项不可用"]);
      const scope=selectField(grid,"适用范围","template_scope",choices,scopeKey(value));
      const kind=selectField(grid,"类型","template_kind",[],value.kind || "expense");
      const updateKinds=() => { const selected=kind.value || value.kind || "expense"; kind.replaceChildren(); for (const code of scope.value ? ["expense","refund"] : ["expense","income","refund"]) { const option=el(kind,"option","",core.TYPES[code]); option.value=code; } kind.value=Array.from(kind.options).some(o=>o.value===selected) ? selected : "expense"; };
      scope.addEventListener("change",updateKinds); updateKinds();
      const category=inputField(grid,"分类 *","template_category",value.category || ""); category.required=true; category.maxLength=120;
      const account=inputField(grid,"付款方式 / 收款账户","template_account",value.account || ""); account.maxLength=120;
      const amount=inputField(grid,"金额（可留空）","template_amount",old ? (old.amountCents==null ? "" : core.decimal(old.amountCents)) : value.amount || ""); amount.inputMode="decimal"; amount.placeholder="每次金额不同可留空";
      const code=p.settings.multiCurrencyEnabled ? selectField(grid,"币种","template_currency",Object.entries(currency.CURRENCIES),value.currency || p.defaultCurrency()) : {value:value.currency || "CNY"};
      if (!p.settings.multiCurrencyEnabled && code.value !== "CNY") el(form,"p","lfn-help",`此模板使用${currency.CURRENCIES[code.value]}。如需修改，请先在「货币设置」开启多币种记账。`);
      const memoLabel=el(form,"label","lfn-field"); el(memoLabel,"span","lfn-field-label","备注（可留空）");
      const memo=el(memoLabel,"textarea"); memo.name="template_memo"; memo.rows=2; memo.maxLength=2000; memo.value=value.memo || "";
      const error=el(form,"div","lfn-error"); error.setAttribute("role","alert");
      const actions=el(form,"div","lfn-modal-actions"); button(actions,"取消",()=>this.close());
      const save=el(actions,"button","lfn-button lfn-primary","保存模板"); save.type="submit";
      form.addEventListener("submit",async event=>{
        event.preventDefault(); if(save.disabled)return; save.disabled=true; error.textContent="";
        try {
          this.assertDataRoot();
          if (!p.settings.multiCurrencyEnabled && code.value !== "CNY") throw new Error("请先在「个性化设置 → 货币设置」开启多币种记账，再保存外币模板");
          await p.store.saveTemplate({name:name.value,context:scope.value ? "project":"daily",projectId:scope.value,kind:kind.value,category:category.value,account:account.value,amount:amount.value,currency:code.value,memo:memo.value},old,this.dataRoot);
          this.close(); await this.afterSave?.(); new Notice("模板已保存，没有新增账目");
        } catch(e) {error.textContent=e.message;} finally {save.disabled=false;}
      });
    }
    onClose(){this.closed=true;this.contentEl.replaceChildren();}
  }

  class DeleteTemplateModal extends PocketModal {
    constructor(plugin,template,afterDelete){super(plugin.app);this.plugin=plugin;this.template=template;this.afterDelete=afterDelete;}
    onOpen(){
      this.contentEl.classList.add("lfn-modal");el(this.contentEl,"h2","","删除常用模板？");
      el(this.contentEl,"p","",`删除「${this.template.name}」后，已保存的账目不受影响。`);
      const actions=el(this.contentEl,"div","lfn-modal-actions");button(actions,"取消",()=>this.close());
      button(actions,"删除模板",async()=>{this.assertDataRoot();await this.plugin.store.deleteTemplate(this.template,this.dataRoot);this.close();await this.afterDelete?.();},"lfn-danger",this.plugin);
    }
    onClose(){this.contentEl.replaceChildren();}
  }

  function createTemplateManager(parent,p,host,{context=null,projectId="",afterChange=null}={}) {
    const box=el(parent,"div","lfn-template-manager"); let closed=false,generation=0,selected=context===null ? "*" : context==="project" ? projectId : "";
    const redraw=async()=>{
      const turn=++generation;const [result,data]=await Promise.all([p.store.listTemplates(),p.store.scan()]);
      if(closed || turn!==generation || !box.isConnected)return;
      host.assertDataRoot();box.replaceChildren();
      const names=new Map((data.projects||[]).map(project=>[project.id,project.name]));
      const choices=[["*","全部模板"],["","日常记账"],...[...new Set([...(data.projects||[]).map(p=>p.id),...result.templates.map(scopeKey).filter(Boolean)])].map(id=>[id,`专项 · ${names.get(id)||"原专项不可用"}`])];
      const toolbar=el(box,"div","lfn-template-toolbar");const scope=selectField(toolbar,"适用范围","templates_filter",choices,selected);
      scope.addEventListener("change",()=>{selected=scope.value;p.run(redraw);});
      const changed=async()=>{await redraw();await afterChange?.();};
      button(toolbar,"新增模板",()=>new TemplateEditorModal(p,null,{context:selected && selected!=="*" ? "project":"daily",projectId:selected!=="*" ? selected : "",currency:p.defaultCurrency()},changed).open(),"lfn-primary",p);
      const items=result.templates.filter(t=>selected==="*" || scopeKey(t)===selected);
      if(!items.length)empty(box,"还没有常用模板","可以在这里新建，或在记账表单中把当前填写内容存为模板。");
      for(const t of items){
        const row=el(box,"div","lfn-template-row"),text=el(row,"div","lfn-template-copy");
        el(text,"strong","",t.name);el(text,"div","lfn-help",`${t.context==="project" ? names.get(t.projectId)||"原专项不可用" : "日常"} · ${core.TYPES[t.kind]} · ${t.category} · ${t.amountCents==null ? "填写时输入金额" : core.displayMoney(t.amountCents,t.currency)}`);
        const controls=el(row,"div","lfn-actions");button(controls,"编辑",()=>new TemplateEditorModal(p,t,{},changed).open(),"",p);button(controls,"删除",()=>new DeleteTemplateModal(p,t,changed).open(),"lfn-subtle-danger",p);
      }
      el(box,"p","lfn-help",`模板保存在 ${result.root}/常用模板.md，可随流水数据一起同步。`);
    };
    p.run(redraw);return {refresh:redraw,destroy(){closed=true;generation++;}};
  }

  class TemplatesManagerModal extends PocketModal {
    constructor(plugin,options={}){super(plugin.app);this.plugin=plugin;this.options=options;}
    onOpen(){this.contentEl.classList.add("lfn-modal");el(this.contentEl,"h2","","常用模板");el(this.contentEl,"p","lfn-help","把常记的一笔存为模板，下次选中即可填好；核对日期和金额后仍需点击保存。");this.manager=createTemplateManager(this.contentEl,this.plugin,this,this.options);const actions=el(this.contentEl,"div","lfn-modal-actions");button(actions,"完成",()=>this.close());}
    onClose(){this.manager?.destroy();this.contentEl.replaceChildren();}
  }

  function createTemplatePicker(parent,p,host,{fields,context="daily",projectId="",onApply=null}={}){
    const box=el(parent,"div","lfn-template-picker"), disclosure=el(box,"details","lfn-template-toggle");
    const summary=el(disclosure,"summary","lfn-template-summary");
    require("./icons").icon(summary,"template");el(summary,"span","","常用模板");
    const panel=el(disclosure,"div","lfn-template-popover"),row=el(panel,"div","lfn-template-toolbar");
    const select=selectField(row,"常用模板","record_template",[["","选择模板"]],"");
    select.setAttribute("aria-label","选择常用模板");
    const label=select.parentElement.querySelector(".lfn-field-label");if(label)label.hidden=true;
    const status=el(box,"div","lfn-help lfn-template-status");status.setAttribute("role","status");status.setAttribute("aria-live","polite");status.setAttribute("aria-atomic","true");
    let items=[],closed=false,generation=0,scopeActive=false;
    const popupScope=new Scope(host.scope);
    const syncScope=()=>{
      if(!closed&&disclosure.open&&!scopeActive){p.app.keymap.pushScope(popupScope);scopeActive=true;}
      else if((closed||!disclosure.open)&&scopeActive){p.app.keymap.popScope(popupScope);scopeActive=false;}
    };
    const setOpen=open=>{disclosure.open=open;syncScope();};
    const closePopup=()=>{setOpen(false);summary.focus({preventScroll:true});};
    // Activate the modal key scope immediately; native toggle events are deferred.
    summary.addEventListener("click",event=>{event.preventDefault();setOpen(!disclosure.open);});
    popupScope.register([],"Escape",()=>{closePopup();return false;});
    disclosure.addEventListener("toggle",()=>{if(!closed)syncScope();});
    const error=message=>{setOpen(true);panel.appendChild(status);status.classList.add("is-error");status.textContent=message;};
    const refresh=async()=>{const turn=++generation;try {const result=await p.store.listTemplates();if(closed||turn!==generation)return;host.assertDataRoot();items=result.templates.filter(t=>t.context===context&&(t.projectId||"")===projectId&&core.featureEnabled(p.settings,t.kind));select.replaceChildren();const placeholder=el(select,"option","",items.length ? "选择模板":"暂无模板");placeholder.value="";for(const t of items){const option=el(select,"option","",t.name);option.value=t.id;}}catch(e){if(!closed)error(e.message);}};
    const actions=el(panel,"div","lfn-template-picker-actions");
    button(actions,"管理模板",()=>new TemplatesManagerModal(p,{context,projectId,afterChange:refresh}).open(),"lfn-link-button",p);
    button(actions,"存为模板",()=>{host.assertDataRoot();new TemplateEditorModal(p,null,formValue(fields,context,projectId),refresh).open();},"lfn-link-button",p);
    select.addEventListener("change",()=>{
      const t=items.find(t=>t.id===select.value);if(!t)return;
      try {
        host.assertDataRoot();
        if(!p.settings.multiCurrencyEnabled&&t.currency!=="CNY")throw new Error("此模板使用外币，请先在「个性化设置 → 货币设置」开启多币种记账；当前表单未修改");
        if(!core.featureEnabled(p.settings,t.kind))throw new Error("请先开启模板对应的记账功能");
        const EventClass=box.ownerDocument.defaultView.Event;
        fields.kind.value=t.kind;fields.kind.dispatchEvent(new EventClass("change",{bubbles:true}));
        fields.category.value=t.category;fields.account.value=t.account;fields.amount.value=t.amountCents==null ? "":core.decimal(t.amountCents);fields.memo.value=t.memo;fields.currency.value=t.currency;
        fields.currency.dispatchEvent?.(new EventClass("change",{bubbles:true}));
        fields.amount.dispatchEvent(new EventClass("input",{bubbles:true}));onApply?.();
        box.appendChild(status);status.classList.remove("is-error");status.textContent="已套用「"+t.name+"」";closePopup();
      }catch(e){error(e.message);}
      select.value="";
    });
    disclosure.addEventListener("keydown",event=>{if(event.key==="Escape"&&disclosure.open){event.preventDefault();event.stopPropagation();closePopup();}});
    const outside=event=>{if(disclosure.open&&!box.contains(event.target))setOpen(false);};
    box.ownerDocument.addEventListener("pointerdown",outside);
    refresh();return {element:box,refresh,destroy(){closed=true;generation++;syncScope();box.ownerDocument.removeEventListener("pointerdown",outside);}};
  }
  return {TemplatesManagerModal,TemplateEditorModal,createTemplatePicker,createTemplateManager};
}
module.exports={createTemplatesUI};
