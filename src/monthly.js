"use strict";
const core = require("./core");
const currency = require("./currency");
const attachments = require("./attachments");

const START = "<!-- local-finance-notes:transactions:start -->";
const END = "<!-- local-finance-notes:transactions:end -->";
const HEADER = "| 日期 | 类型 | 分类 | 账户 | 金额（元） | 备注 | ID |";
const SEPARATOR = "| --- | --- | --- | --- | ---: | --- | --- |";
const MULTI_HEADER = "| 日期 | 类型 | 分类 | 账户 | 金额（元） | 备注 | ID | 原币金额 | 币种 | 汇率日期 | 1元兑美元 | 1元兑日元 | 汇率来源 |";
const MULTI_SEPARATOR = "| --- | --- | --- | --- | ---: | --- | --- | ---: | --- | --- | ---: | ---: | --- |";
const ATTACHMENT_HEADER = HEADER + " 凭证 |";
const ATTACHMENT_SEPARATOR = SEPARATOR + " --- |";
const MULTI_ATTACHMENT_HEADER = MULTI_HEADER + " 凭证 |";
const MULTI_ATTACHMENT_SEPARATOR = MULTI_SEPARATOR + " --- |";
const KINDS = { "支出": "expense", "收入": "income", "退款": "refund" };

function encode(value) {
  return String(value ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/\\/g, "&#92;").replace(/\|/g, "&#124;").replace(/\r/g, "&#13;").replace(/\n/g, "<br>")
    .replace(/^ +| +$/g, spaces => "&#32;".repeat(spaces.length));
}
function decode(value) {
  // Decode once: a literal '&lt;' or '<br>' entered in a form must round-trip unchanged.
  return value.replace(/<br\s*\/?>|&(?:amp|lt|gt|quot|#(?:\d+|x[\da-f]+));/gi, entity => {
    if (/^<br/i.test(entity)) return "\n";
    const token = entity.slice(1, -1).toLowerCase();
    if (token.startsWith("#")) {
      const n = token[1] === "x" ? parseInt(token.slice(2), 16) : Number(token.slice(1));
      return n <= 0x10ffff ? String.fromCodePoint(n) : entity;
    }
    return { amp: "&", lt: "<", gt: ">", quot: '"' }[token];
  });
}
function row(record, multi = !!record.fx || record.currency !== "CNY", receipts = !!record.attachments?.length) {
  const cells = [record.date, core.TYPES[record.kind], record.category, record.account, core.decimal(currency.amount(record, "amountCents", "CNY")), record.memo, record.id];
  if (multi) cells.push(core.decimal(record.amountCents), record.currency, record.fx?.date || "", record.fx?.rates.USD || "", record.fx?.rates.JPY || "", record.fx?.source || "");
  const encoded = cells.map(encode);
  // Paths already forbid table/markup delimiters. Preserve literal ampersands:
  // HTML-escaping a wikilink target can point Obsidian at a different filename.
  if (receipts) encoded.push(attachments.normalizePaths(record.attachments).map(path => `[[${path}]]`).join("<br>"));
  return `| ${encoded.join(" | ")} |`;
}
function fingerprint(record) {
  return JSON.stringify([record.id, record.kind, record.date, record.category, record.account, record.amountCents, record.memo, record.currency || "CNY", record.fx || null, attachments.normalizePaths(record.attachments)]);
}
function bounds(text) {
  const start = text.indexOf(START), end = text.indexOf(END);
  if (start < 0 || end < start || text.indexOf(START, start + 1) >= 0 || text.indexOf(END, end + 1) >= 0)
    throw new Error("流水表标记缺失或重复。为保留正文，本次未写入；请恢复 transactions 标记。");
  if ((start && text[start - 1] !== "\n") || !/^\r?\n/.test(text.slice(start + START.length)) || (end && text[end - 1] !== "\n"))
    throw new Error("流水表标记须各占一行");
  return { start: start + START.length, end };
}
function parseTable(text, path, month = null) {
  const range = bounds(text), records = [], warnings = [];
  const lines = [...text.slice(range.start, range.end).matchAll(/[^\r\n]+(?:\r?\n|$)|\r?\n/g)];
  let header = false, separator = false, multi = false, receipts = false;
  for (const match of lines) {
    const line = match[0].replace(/\r?\n$/, ""), trimmed = line.trim();
    if (!trimmed) continue;
    if (!header) {
      const titles = trimmed.split("|").map(cell => cell.trim());
      receipts = titles.at(-2) === "凭证";
      if (receipts) titles.splice(-2, 1);
      multi = JSON.stringify(titles) === JSON.stringify(MULTI_HEADER.split("|").map(cell => cell.trim()));
      if (!multi && JSON.stringify(titles) !== JSON.stringify(HEADER.split("|").map(cell => cell.trim()))) throw new Error("流水表的列标题已改变，请恢复原有流水表标题");
      header = true; continue;
    }
    if (!separator) {
      if (!(new RegExp(`^\\|(?:\\s*:?-+:?\\s*\\|){${(multi ? 13 : 7) + Number(receipts)}}$`)).test(trimmed)) throw new Error("流水表的分隔行不完整");
      separator = true; continue;
    }
    try {
      const cells = trimmed.split("|");
      const count = (multi ? 13 : 7) + Number(receipts);
      if (cells.length !== count + 2 || cells[0] || cells.at(-1)) throw new Error(`每行须有 ${count} 列；文字中的竖线请写为 &#124;`);
      const rawValues = cells.slice(1, -1).map(cell => cell.trim());
      const receiptPaths = receipts ? attachments.parseCell(rawValues.pop()) : [];
      const values = rawValues.map(decode);
      const [date, type, category, account, cnyAmount, memo, id, originalAmount, code, fxDate, usd, jpy, source] = values;
      if (!Object.hasOwn(KINDS, type)) throw new Error("类型须为 支出、收入 或 退款");
      if (month && !date.startsWith(month + "-")) throw new Error("记录日期须属于本篇笔记的月份；跨月修改请使用面板的编辑按钮");
      const fx = multi && fxDate ? { date: fxDate, source, rates: { CNY: 1, USD: Number(usd), JPY: Number(jpy) } } : null;
      if (multi && !fxDate && (usd || jpy || source)) throw new Error("汇率数据不完整");
      const record = core.validateRecord({ finance_schema: 1, finance_kind: KINDS[type], id, date, currency: multi ? code : "CNY", fx, category, account, amount: multi ? originalAmount : cnyAmount, memo, attachments: receiptPaths }, path);
      if (multi && (!/^\d+(?:\.\d{1,2})?$/.test(cnyAmount) || Math.round(Number(cnyAmount) * 100) !== currency.amount(record, "amountCents", "CNY"))) throw new Error("人民币金额与原币金额及汇率不一致，请通过面板重新保存");
      record.storage = "monthly";
      record.offset = range.start + match.index;
      record.length = match[0].length;
      record.line = line;
      records.push(record);
    } catch (error) {
      const lineNumber = text.slice(0, range.start + match.index).split("\n").length;
      warnings.push({ path, message: `第 ${lineNumber} 行：${error.message}` });
    }
  }
  if (!header || !separator) throw new Error("流水表缺少标题或分隔行");
  return { records, warnings, range, multi, receipts };
}
function parse(text, path, codec) {
  const fm = core.readFrontmatter(text, codec.parseYaml);
  if (!fm || fm.finance_schema !== 2 || fm.finance_kind !== "monthly") throw new Error("不是有效的月度流水笔记");
  if (!core.validMonth(fm.month)) throw new Error("月度笔记的 month 须为 YYYY-MM");
  if (fm.currency !== "CNY") throw new Error("当前仅统计人民币；currency 须为 CNY");
  return { ...parseTable(text, path, fm.month), month: fm.month, frontmatter: fm };
}
function create(month, codec) {
  const fm = { finance_schema: 2, finance_kind: "monthly", month, currency: "CNY", tags: ["财务", "流水"] };
  return `---\n${codec.stringifyYaml(fm).trimEnd()}\n---\n\n# ${month} 收支流水\n\n一行是一笔收支，同月的支出、收入和退款保存在这篇笔记中。金额单位：元。\n\n${START}\n${HEADER}\n${SEPARATOR}\n${END}\n\n## 本月的笔记与凭证\n\n可以在这里写消费原因、添加 [[关联笔记]] 或粘贴收据。插件只修改上面的流水行，保留这里的文字。\n`;
}
function rewrite(text, parsed, records, multi, receipts) {
  if (parsed.warnings.length) throw new Error("流水表存在格式错误，未升级币种或凭证列");
  const header = multi ? (receipts ? MULTI_ATTACHMENT_HEADER : MULTI_HEADER) : (receipts ? ATTACHMENT_HEADER : HEADER);
  const separator = multi ? (receipts ? MULTI_ATTACHMENT_SEPARATOR : MULTI_SEPARATOR) : (receipts ? ATTACHMENT_SEPARATOR : SEPARATOR);
  return text.slice(0, parsed.range.start) + `\n${header}\n${separator}\n` + records.map(r => row(r, multi, receipts)).join("\n") + "\n" + text.slice(parsed.range.end);
}
function append(text, record, parsed) {
  const multi = parsed.multi || !!record.fx || record.currency !== "CNY", receipts = parsed.receipts || !!record.attachments?.length;
  if (multi !== parsed.multi || receipts !== !!parsed.receipts) return rewrite(text, parsed, [...parsed.records, record], multi, receipts);
  return text.slice(0, parsed.range.end) + row(record, multi, receipts) + "\n" + text.slice(parsed.range.end);
}
function replace(text, record, replacement = null) {
  const parsed = parseTable(text, record.path);
  if (replacement) {
    const multi = parsed.multi || !!replacement.fx || replacement.currency !== "CNY", receipts = parsed.receipts || !!replacement.attachments?.length;
    if (multi !== parsed.multi || receipts !== parsed.receipts) return rewrite(text, parsed, parsed.records.map(r => r.offset === record.offset ? replacement : r), multi, receipts);
  }
  const newline = record.line.length < record.length ? text.slice(record.offset + record.line.length, record.offset + record.length) : "";
  return text.slice(0, record.offset) + (replacement ? row(replacement, parsed.multi, parsed.receipts) + newline : "") + text.slice(record.offset + record.length);
}
function checked(parsed, previous) {
  if (parsed.warnings.length) throw new Error("流水表存在格式错误，请先修正面板提示的行；原笔记未覆盖");
  const matching = parsed.records.filter(r => r.id === previous.id);
  if (matching.length !== 1) throw new Error("原记录已删除或 ID 重复，请刷新后重新打开");
  if (fingerprint(matching[0]) !== fingerprint(previous)) throw new Error("这条记录在打开表单后已被修改。请重新打开编辑，避免覆盖新数据。");
  return matching[0];
}

module.exports = { START, END, HEADER, SEPARATOR, MULTI_HEADER, MULTI_SEPARATOR, ATTACHMENT_HEADER, ATTACHMENT_SEPARATOR, MULTI_ATTACHMENT_HEADER, MULTI_ATTACHMENT_SEPARATOR, encode, decode, row, fingerprint, bounds, parseTable, parse, create, append, replace, checked };
