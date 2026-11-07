"use strict";
const core = require("./core"), table = require("./monthly");
const currency = require("./currency");
const START = "<!-- local-finance-notes:fixed:start -->";
const END = "<!-- local-finance-notes:fixed:end -->";
const HEADER = "| 项目 | 付费周期 | 每次金额（元） | 本年首次付款日 | 账户 | 状态 | 备注 | ID |";
const SEPARATOR = "| --- | --- | ---: | --- | --- | --- | --- | --- |";
const MULTI_HEADER = "| 项目 | 付费周期 | 每次金额 | 本年首次付款日 | 账户 | 状态 | 备注 | ID | 币种 |";
const MULTI_SEPARATOR = "| --- | --- | ---: | --- | --- | --- | --- | --- | --- |";
const SCOPED_HEADER = "| 项目 | 付费周期 | 每次金额 | 本年首次付款日 | 账户 | 状态 | 备注 | ID | 币种 | 所属专项ID |";
const SCOPED_SEPARATOR = "| --- | --- | ---: | --- | --- | --- | --- | --- | --- | --- |";
const PREFIX = "lfn-fixed-";
const CATEGORY = "固定支出";
function validYear(year) { return /^\d{4}$/.test(String(year)) && Number(year) >= 1900 && Number(year) <= 9999; }
function text(value, label, required = true) {
  if (typeof value !== "string" || value.length > 120 || /[\r\n\u0000-\u001f]/.test(value) || (required && !value.trim())) throw new Error(`${label}须为${required ? "非空" : ""}单行文字，最多 120 字`);
  return value.trim();
}
function validate(value, path = "") {
  if (!validYear(value.year)) throw new Error("年份须在 1900 至 9999 之间");
  const year = String(value.year), id = text(value.id, "ID");
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(id)) throw new Error("固定支出 ID 须为不超过 64 字的字母、数字、短横线或下划线");
  if (!["yearly", "monthly"].includes(value.cycle)) throw new Error("付费周期须为 yearly 或 monthly");
  if (!core.validDate(value.firstDate) || !value.firstDate.startsWith(year + "-")) throw new Error("首次付款日须为本年度内的真实日期");
  if (!["active", "paused"].includes(value.status)) throw new Error("固定支出状态须为 active 或 paused");
  if (typeof value.memo !== "string" || value.memo.length > 1500) throw new Error("备注须为文字，最多 1500 字");
  if (!currency.validCurrency(value.currency || "CNY")) throw new Error("币种须为 CNY、USD 或 JPY");
  const projectId = value.projectId || "";
  if (typeof projectId !== "string" || (projectId && !/^[A-Za-z0-9_-]{1,64}$/.test(projectId))) throw new Error("专项归属 ID 无效");
  return { year, id, name: text(value.name, "项目名称"), cycle: value.cycle, amountCents: core.moneyToCents(value.amount), firstDate: value.firstDate,
    currency: value.currency || "CNY", projectId, account: text(value.account || "", "账户", false), status: value.status, memo: value.memo, path };
}
function signature(entry) { return JSON.stringify([entry.id, entry.year, entry.name, entry.cycle, entry.amountCents, entry.firstDate, entry.account, entry.status, entry.memo, entry.currency || "CNY", entry.projectId || ""]); }
function row(entry, multi = entry.currency !== "CNY", scoped = !!entry.projectId) {
  const cells = [entry.name, entry.cycle === "yearly" ? "按年" : "按月", core.decimal(entry.amountCents), entry.firstDate, entry.account,
    entry.status === "active" ? "启用" : "停用", entry.memo, entry.id];
  if (multi || scoped) cells.push(entry.currency || "CNY");
  if (scoped) cells.push(entry.projectId || "");
  return `| ${cells.map(table.encode).join(" | ")} |`;
}
function parse(content, path, codec) {
  const fm = core.readFrontmatter(content, codec.parseYaml);
  if (fm?.finance_schema !== 2 || fm.finance_kind !== "fixed" || !validYear(fm.year) || fm.currency !== "CNY") throw new Error("年度固定支出属性须为 finance_schema: 2、finance_kind: fixed、有效 year 和 currency: CNY");
  const start = content.indexOf(START), end = content.indexOf(END);
  if (start < 0 || end < start || content.indexOf(START, start + 1) >= 0 || content.indexOf(END, end + 1) >= 0
    || (start && content[start - 1] !== "\n") || !/^\r?\n/.test(content.slice(start + START.length)) || content[end - 1] !== "\n") throw new Error("固定支出表标记缺失、重复或未独占一行，原笔记未覆盖");
  const offset = start + START.length, entries = [], warnings = [];
  let header = false, separator = false, multi = false, scoped = false;
  for (const match of content.slice(offset, end).matchAll(/[^\r\n]+(?:\r?\n|$)|\r?\n/g)) {
    const line = match[0].replace(/\r?\n$/, ""), trimmed = line.trim();
    if (!trimmed) continue;
    if (!header) {
      const titles = JSON.stringify(trimmed.split("|").map(c => c.trim()));
      scoped = titles === JSON.stringify(SCOPED_HEADER.split("|").map(c => c.trim()));
      multi = scoped || titles === JSON.stringify(MULTI_HEADER.split("|").map(c => c.trim()));
      if (!multi && titles !== JSON.stringify(HEADER.split("|").map(c => c.trim()))) throw new Error("固定支出表标题发生变化，请恢复原有标题");
      header = true; continue;
    }
    if (!separator) {
      if (!(new RegExp(`^\\|(?:\\s*:?-+:?\\s*\\|){${scoped ? 10 : multi ? 9 : 8}}$`)).test(trimmed)) throw new Error("固定支出表分隔行不完整");
      separator = true; continue;
    }
    try {
      const cells = trimmed.split("|");
      if (cells.length !== (scoped ? 12 : multi ? 11 : 10) || cells[0] || cells.at(-1)) throw new Error("固定支出行列数不完整，文字中的竖线请写为 &#124;");
      const [name, cycle, amount, firstDate, account, status, memo, id, code, projectId] = cells.slice(1, -1).map(c => table.decode(c.trim()));
      if (multi && !code) throw new Error("币种不能为空");
      const entry = validate({ year: fm.year, id, name, cycle: { "按年": "yearly", "按月": "monthly" }[cycle], amount, firstDate, account, status: { "启用": "active", "停用": "paused" }[status], memo, currency: multi ? code : "CNY", projectId: scoped ? projectId : "" }, path);
      Object.assign(entry, { offset: offset + match.index, length: match[0].length, line }); entries.push(entry);
    } catch (error) { warnings.push({ path, message: `第 ${content.slice(0, offset + match.index).split("\n").length} 行：${error.message}` }); }
  }
  if (!header || !separator) throw new Error("固定支出表缺少标题或分隔行");
  return { year: String(fm.year), entries, warnings, range: { start: offset, end }, multi, scoped, frontmatter: fm };
}
function create(year, codec) {
  return `---\n${codec.stringifyYaml({ finance_schema: 2, finance_kind: "fixed", year: String(year), currency: "CNY", tags: ["财务", "固定支出"] }).trimEnd()}\n---\n\n# ${year} 年固定支出\n\n本表是年度清单。确认付款后写入付款月份的流水，计划金额不重复计入支出。月均金额仅供参考，不生成摊销流水。\n\n${START}\n${HEADER}\n${SEPARATOR}\n${END}\n\n## 续费与使用笔记\n\n可以记录是否值得续费、价格变化、关联笔记及凭证。\n`;
}
function replace(content, current, next) {
  const scoped = current.line.split("|").length === 12, multi = scoped || current.line.split("|").length === 11;
  if (!multi && next.currency !== "CNY") throw new Error("请先升级固定支出币种列");
  const newline = content.slice(current.offset + current.line.length, current.offset + current.length);
  return content.slice(0, current.offset) + row(next, multi, scoped) + newline + content.slice(current.offset + current.length);
}
function write(content, parsed, next, previous = null) {
  if (!parsed.scoped && next.projectId) {
    const entries = previous ? parsed.entries.map(e => e.id === previous.id ? next : e) : [...parsed.entries, next];
    return content.slice(0, parsed.range.start) + `\n${SCOPED_HEADER}\n${SCOPED_SEPARATOR}\n` + entries.map(e => row(e, true, true)).join("\n") + "\n" + content.slice(parsed.range.end);
  }
  if (!parsed.multi && next.currency !== "CNY") {
    const entries = previous ? parsed.entries.map(e => e.id === previous.id ? next : e) : [...parsed.entries, next];
    return content.slice(0, parsed.range.start) + `\n${MULTI_HEADER}\n${MULTI_SEPARATOR}\n` + entries.map(e => row(e, true)).join("\n") + "\n" + content.slice(parsed.range.end);
  }
  if (previous) return replace(content, checked(parsed, previous), next);
  return content.slice(0, parsed.range.end) + row(next, parsed.multi, parsed.scoped) + "\n" + content.slice(parsed.range.end);
}
function checked(parsed, previous) {
  if (parsed.warnings.length) throw new Error("固定支出表存在格式错误，请先修正");
  const same = parsed.entries.filter(e => e.id === previous.id);
  if (same.length !== 1 || signature(same[0]) !== signature(previous)) throw new Error("固定支出记录已修改、删除或 ID 重复，请刷新后重新打开");
  return same[0];
}
function dateIn(year, month, day) {
  const last = new Date(Date.UTC(Number(year), month, 0)).getUTCDate();
  return `${year}-${String(month).padStart(2, "0")}-${String(Math.min(day, last)).padStart(2, "0")}`;
}
function dates(entry) {
  if (entry.cycle === "yearly") return [entry.firstDate];
  const [, month, day] = entry.firstDate.split("-").map(Number);
  return Array.from({ length: 13 - month }, (_, i) => dateIn(entry.year, month + i, day));
}
function paymentId(entry, date) { return `${PREFIX}${entry.id}-${date}`; }
function payments(entry, records) { return dates(entry).map(date => ({ date, record: records.find(r => r.id === paymentId(entry, date)) || null })); }
function summarize(entries, records, year, asOf = core.today(), code = "CNY") {
  const list = entries.filter(e => e.year === String(year)), active = list.filter(e => e.status === "active");
  const sum = values => { const result = values.reduce((a, b) => a + b, 0); if (!Number.isSafeInteger(result)) throw new Error("固定支出合计超出安全范围"); return result; };
  const missingFx = [];
  const amount = r => { try { return currency.amount(r, "amountCents", code); } catch (_) { missingFx.push(r); return 0; } };
  const planned = sum(active.map(e => amount(e) * dates(e).length));
  const paid = records.filter(r => r.kind !== "investment" && r.date.startsWith(String(year) + "-") && r.date <= asOf
    && (r.category === CATEGORY || r.id.startsWith(PREFIX)));
  const actual = sum(paid.map(r => r.kind === "expense" ? amount(r) : r.kind === "refund" ? -amount(r) : 0));
  return { year: String(year), currency: code, missingFx, entries: list, active, planned, actual, monthlyAverage: Math.round(planned / 12) };
}
function carry(entry, year, id) {
  const [, month, day] = entry.firstDate.split("-").map(Number);
  return { year: String(year), id, name: entry.name, cycle: entry.cycle, amount: core.decimal(entry.amountCents),
    firstDate: dateIn(year, entry.cycle === "monthly" ? 1 : month, day), currency: entry.currency || "CNY", projectId: entry.projectId || "", account: entry.account, status: "active", memo: entry.memo };
}
module.exports = { START, END, HEADER, SEPARATOR, MULTI_HEADER, MULTI_SEPARATOR, PREFIX, CATEGORY, validYear, validate, signature, row, parse, create, replace, write, checked, dates, paymentId, payments, summarize, carry };
