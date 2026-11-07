"use strict";
const core = require("./core"), currency = require("./currency"), { encode, decode } = require("./monthly");
const START = "<!-- mypocket:templates:start -->", END = "<!-- mypocket:templates:end -->";
const HEADER = "| 模板名称 | 适用范围 | 专项 ID | 类型 | 分类 | 账户 | 原币金额 | 币种 | 备注 | ID |";
const SEPARATOR = "| --- | --- | --- | --- | --- | --- | ---: | --- | --- | --- |";
function valueText(value, name, required = false, max = 120) {
  if (typeof value !== "string") throw new Error(`${name}须为文字`);
  const result = value.trim();
  if (name !== "备注" && /[\r\n\u0000-\u001f\u007f]/.test(result)) throw new Error(`${name}不能包含换行或控制字符`);
  if ((required && !result) || result.length > max) throw new Error(`${name}${required ? "不能为空，且" : ""}最多 ${max} 字`);
  return result;
}
function validate(value) {
  const context = value.context || "daily", projectId = value.projectId || "";
  if (!["daily", "project"].includes(context) || (context === "project" ? !projectId : !!projectId)) throw new Error("请选择模板的日常或专项归属");
  if (!["expense", "income", "refund"].includes(value.kind) || (context === "project" && value.kind === "income")) throw new Error("模板类型不适用于此范围");
  if (!currency.validCurrency(value.currency)) throw new Error("请选择人民币、美元或日元");
  const amount = value.amount == null ? "" : String(value.amount).trim();
  return { id: valueText(value.id, "ID", true), name: valueText(value.name, "模板名称", true), context, projectId: valueText(projectId, "专项 ID"), kind: value.kind, category: valueText(value.category, "分类", true), account: valueText(value.account || "", "账户"), amountCents: amount === "" ? null : core.moneyToCents(amount), currency: value.currency, memo: valueText(value.memo || "", "备注", false, 2000) };
}
function fingerprint(t) { return JSON.stringify([t.id,t.name,t.context,t.projectId,t.kind,t.category,t.account,t.amountCents,t.currency,t.memo]); }
function range(text) {
  const start = text.indexOf(START), end = text.indexOf(END);
  if (start < 0 || end < start || text.indexOf(START, start + 1) !== -1 || text.indexOf(END, end + 1) !== -1) throw new Error("常用模板表标记缺失或重复，请先修正笔记；本次未覆盖");
  return { start: start + START.length, end };
}
function parse(text, path, codec) {
  const fm = core.readFrontmatter(text, codec.parseYaml);
  if (fm?.finance_kind !== "templates" || fm.finance_schema !== 1) throw new Error("常用模板.md 已存在，但不是有效的模板笔记；原文件保留");
  const bounds = range(text), lines = text.slice(bounds.start, bounds.end).split(/\r?\n/).map(s => s.trim()).filter(Boolean);
  if (lines[0] !== HEADER || !/^\|(?:\s*:?-+:?\s*\|){10}$/.test(lines[1] || "")) throw new Error("常用模板表的标题或分隔行不完整");
  const templates = lines.slice(2).map(line => {
    const cells = line.split("|");
    if (cells.length !== 12 || cells[0] || cells.at(-1)) throw new Error("模板表每行须有 10 列；文字中的竖线请写为 &#124;");
    const [name,scope,projectId,type,category,account,amount,code,memo,id] = cells.slice(1,-1).map(v => decode(v.trim()));
    if (!["日常", "专项"].includes(scope)) throw new Error("模板范围须为日常或专项");
    const kind = Object.keys(core.TYPES).find(key => core.TYPES[key] === type);
    return { ...validate({ name,context:scope === "专项" ? "project" : "daily",projectId,kind,category,account,amount,currency:code,memo,id }),path };
  });
  const ids = new Set(), names = new Set();
  for (const t of templates) {
    const key = `${t.context}:${t.projectId}:${t.name.toLocaleLowerCase()}`;
    if (ids.has(t.id) || names.has(key)) throw new Error("模板 ID 或同一范围的名称重复，请先修正笔记");
    ids.add(t.id); names.add(key);
  }
  return {templates,bounds};
}
function row(t) { return "| " + [t.name,t.context === "project" ? "专项" : "日常",t.projectId,core.TYPES[t.kind],t.category,t.account,t.amountCents == null ? "" : core.decimal(t.amountCents),t.currency,t.memo,t.id].map(encode).join(" | ") + " |"; }
function replace(text, templates) { const b = range(text); return text.slice(0,b.start) + "\n" + [HEADER,SEPARATOR,...templates.map(row)].join("\n") + "\n" + text.slice(b.end); }
function create(codec) { return `---\n${codec.stringifyYaml({finance_schema:1,finance_kind:"templates"}).trimEnd()}\n---\n\n# 常用模板\n\n模板仅预填记账表单，不自动产生账目。日期、汇率和凭证在每次记账时单独确定；金额可留空。\n\n${START}\n${HEADER}\n${SEPARATOR}\n${END}\n\n可在这里补充自己的使用说明。\n`; }
module.exports = { validate,fingerprint,parse,replace,create };
