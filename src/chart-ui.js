"use strict";
const core = require("./core");
const { categorySlices, trendLayout } = require("./charts");

function el(parent, tag, cls = "", text = "") {
  const node = parent.ownerDocument.createElement(tag);
  node.className = cls; node.textContent = text; parent.appendChild(node); return node;
}
function svg(parent, tag, attributes = {}, text = "") {
  const node = parent.ownerDocument.createElementNS("http://www.w3.org/2000/svg", tag);
  for (const [key, value] of Object.entries(attributes)) node.setAttribute(key, String(value));
  if (text) node.textContent = text;
  parent.appendChild(node); return node;
}
function percent(share) {
  if (share > 0 && share < .001) return "<0.1%";
  return `${Number((share * 100).toFixed(1))}%`;
}
function legendRow(parent, item, index, code, tag = "div") {
  const row = el(parent, tag, "lfn-chart-legend-row");
  const dot = el(row, "span", "lfn-chart-dot"); dot.style.background = `var(--lfn-chart-${index})`; dot.setAttribute("aria-hidden", "true");
  el(row, "span", "lfn-chart-category", item.name);
  el(row, "strong", "", core.displayMoney(item.amount, code));
  el(row, "span", "lfn-chart-percent", percent(item.share));
  row.title = `${item.name} · ${core.displayMoney(item.amount, code)} · ${percent(item.share)}`;
  return row;
}
function createCategoryFilter(parent, names, selection, onChange) {
  const picker = el(parent, "details", "lfn-chart-filter");
  const trigger = el(picker, "summary", "lfn-chart-filter-trigger");
  const icon = svg(trigger, "svg", { viewBox: "0 0 16 16", width: 14, height: 14, "aria-hidden": "true", fill: "none", stroke: "currentColor", "stroke-width": 1.4 });
  svg(icon, "path", { d: "M2 3h12M4 8h8M6 13h4", "stroke-linecap": "round" });
  const caption = el(trigger, "span");
  const popup = el(picker, "div", "lfn-chart-filter-popup");
  const toolbar = el(popup, "div", "lfn-chart-filter-toolbar");
  el(toolbar, "span", "lfn-chart-filter-title", "消费类别");
  const actions = el(toolbar, "div", "lfn-chart-filter-actions");
  const controls = [];
  const update = () => {
    const count = names.filter(name => selection === null || selection.has(name)).length;
    caption.textContent = selection === null ? "筛选类别" : `类别 ${count}/${names.length}`;
    trigger.setAttribute("aria-label", `筛选类别，已选 ${count} / ${names.length} 类`);
    picker.classList.toggle("is-filtered", selection !== null);
    for (const [name, chip] of controls) chip.setAttribute("aria-pressed", String(selection === null || selection.has(name)));
    status.textContent = `已选 ${count} / ${names.length} 类`;
  };
  const action = (text, handler, parent = actions) => {
    const button = el(parent, "button", "lfn-button", text); button.type = "button";
    button.addEventListener("click", handler); return button;
  };
  const change = value => { selection = value; update(); onChange(value); };
  action("全选", () => change(null));
  action("清空", () => change(new Set()));
  el(popup, "p", "lfn-chart-filter-hint", "可多选 · 占比与趋势同步更新");
  const options = el(popup, "div", "lfn-chart-filter-options");
  options.setAttribute("role", "group"); options.setAttribute("aria-label", "参与统计的消费类别");
  if (!names.length) el(options, "p", "lfn-help", "本年暂无已记录的消费类别");
  for (const name of names) {
    const chip = el(options, "button", "lfn-chart-filter-option"); chip.type = "button";
    el(chip, "span", "lfn-chart-filter-label", name);
    controls.push([name, chip]);
    chip.addEventListener("click", () => {
      const next = new Set(selection === null ? names : selection);
      if (next.has(name)) next.delete(name); else next.add(name);
      change(names.every(item => next.has(item)) ? null : next);
    });
  }
  const footer = el(popup, "div", "lfn-chart-filter-footer");
  const status = el(footer, "span", "lfn-help"); status.setAttribute("aria-live", "polite");
  const close = () => { picker.open = false; trigger.focus(); };
  action("完成", close, footer);
  picker.addEventListener("keydown", event => { if (event.key === "Escape" && picker.open) { event.preventDefault(); event.stopPropagation(); close(); } });
  const outside = event => { if (!picker.contains(event.target)) picker.open = false; };
  const focusOutside = event => { if (!picker.contains(event.target)) picker.open = false; };
  const doc = parent.ownerDocument;
  doc.addEventListener("pointerdown", outside);
  doc.addEventListener("focusin", focusOutside);
  update();
  return { destroy() { doc.removeEventListener("pointerdown", outside); doc.removeEventListener("focusin", focusOutside); } };
}
function renderCategoryChart(parent, period, label, code, filtered = false, selectionEmpty = false) {
  parent.replaceChildren();
  parent.classList.add("lfn-chart-body");
  const money = value => core.displayMoney(value, code);
  const summary = el(parent, "div", "lfn-chart-summary");
  el(summary, "span", "lfn-help", `${label} · ${filtered ? "所选类别净支出" : "净支出"}`);
  el(summary, "strong", "", period.missingFx.length ? "待补全" : money(period.net));
  const visual = el(parent, "div", "lfn-chart-visual");
  const footer = el(parent, "div", "lfn-chart-footer");
  if (period.missingFx.length) { el(visual, "p", "lfn-chart-empty lfn-help", `本期有 ${period.missingFx.length} 笔所选支出或退款暂无法换算，补全汇率后显示占比。`); return; }
  const data = categorySlices(period.categories);
  if (!data.slices.length) el(visual, "p", "lfn-chart-empty lfn-help", selectionEmpty ? "请选择至少一个类别查看统计。" : period.count ? "本期支出已被退款抵扣，没有可显示的正额占比。" : filtered ? "所选类别在本期还没有已记录的支出。" : "本期还没有已记录的支出。");
  else {
    const layout = el(visual, "div", "lfn-donut-layout");
    const graphic = el(layout, "div", "lfn-donut");
    const ring = svg(graphic, "svg", { viewBox: "0 0 180 180", role: "img", "aria-label": `${label}类别占比，占比金额 ${money(data.total)}，${data.slices.map(item => `${item.name} ${percent(item.share)}`).join("，")}` });
    svg(ring, "circle", { cx: 90, cy: 90, r: 70, fill: "none", stroke: "var(--background-secondary)", "stroke-width": 22 });
    const circumference = Math.PI * 140; let offset = 0;
    data.slices.forEach((item, index) => {
      const length = item.share * circumference;
      const arc = svg(ring, "circle", { cx: 90, cy: 90, r: 70, fill: "none", stroke: `var(--lfn-chart-${index})`, "stroke-width": 22, "stroke-dasharray": `${length} ${circumference - length}`, "stroke-dashoffset": -offset, transform: "rotate(-90 90 90)" });
      svg(arc, "title", {}, `${item.name} · ${money(item.amount)} · ${percent(item.share)}`); offset += length;
    });
    const center = el(graphic, "div", "lfn-donut-center"); center.setAttribute("aria-hidden", "true");
    el(center, "strong", "", String(period.categories.filter(([, value]) => value > 0).length));
    el(center, "span", "lfn-help", "个支出类别");
    const legend = el(layout, "div", "lfn-chart-legend");
    data.slices.forEach((item, index) => {
      if (!item.children) legendRow(legend, item, index, code);
      else {
        const details = el(legend, "details", "lfn-chart-more");
        legendRow(details, item, index, code, "summary");
        const children = el(details, "div", "lfn-chart-subcategories");
        for (const child of item.children) legendRow(children, child, index, code);
      }
    });
    el(footer, "p", "lfn-help lfn-chart-note", data.negative.length ? "占比按所选类别抵扣退款后的正额计算；超出的退款已单列。" : filtered ? "已扣除退款 · 占比以所选类别合计为基数" : "已扣除退款 · 悬停可查看金额和比例");
  }
  if (data.negative.length) {
    const refunds = el(visual, "div", "lfn-chart-refunds");
    el(refunds, "div", "lfn-help", "退款超出本期消费");
    for (const item of data.negative) {
      const row = el(refunds, "div", "lfn-line"); el(row, "span", "", item.name); el(row, "strong", "", money(item.amount));
    }
  }
}
function renderTrendChart(parent, summary, selectedMonth, code, { filtered = false, selectionEmpty = false, onSelect = null } = {}) {
  const expanded = parent.querySelector(".lfn-chart-data")?.open || false;
  parent.replaceChildren(); parent.classList.add("lfn-chart-body");
  const body = parent;
  const money = value => core.displayMoney(value, code);
  const rangeTitle = summary.rangeLabel || `${summary.year}年`;
  const monthLabel = key => `${summary.rangeLabel ? key.slice(0, 4) + "年" : ""}${Number(key.slice(5))}月`;
  const readout = el(body, "div", "lfn-chart-readout"); readout.setAttribute("aria-live", "polite");
  const visual = el(body, "div", "lfn-chart-visual");
  const footer = el(body, "div", "lfn-chart-footer");
  let chart;
  const show = point => {
    readout.replaceChildren();
    el(readout, "span", "lfn-help", `${monthLabel(point.month)}${point.month === summary.asOf.slice(0, 7) ? ` · 截至 ${summary.asOf.slice(5).replace("-", "/")}` : ""}`);
    el(readout, "strong", "", point.future ? "未到" : point.incomplete ? "待补全" : money(point.value));
    for (const group of chart?.querySelectorAll(".lfn-chart-point") || []) {
      const selected = group.getAttribute("data-month") === point.month;
      group.classList.toggle("is-selected", selected);
      group.setAttribute("aria-pressed", String(selected));
    }
    onSelect?.(point.month);
  };
  if (!summary.months.length) { el(visual, "p", "lfn-chart-empty lfn-help", "本范围暂无已记录支出。"); return; }
  show(summary.months.find(point => point.month === selectedMonth) || summary.months.at(-1));
  if (!summary.months.some(point => point.count || point.incomplete)) {
    el(visual, "p", "lfn-chart-empty lfn-help", selectionEmpty ? "请选择至少一个类别查看趋势。" : summary.rangeLabel ? "本范围还没有已记录的支出。" : filtered ? "所选类别在本年还没有已记录的支出。" : "这一年还没有已记录的支出，记账后会自动显示趋势。"); return;
  }
  const geometry = trendLayout(summary.months);
  chart = svg(visual, "svg", { viewBox: `0 0 ${geometry.width} ${geometry.height}`, class: "lfn-trend-chart", role: "group", "aria-label": `${rangeTitle}${filtered ? "所选类别" : ""}每月净支出趋势，扣除退款` });
  // A tap anywhere in a month's column selects it; no tiny dot target is needed.
  chart.addEventListener("click", event => {
    const bounds = chart.getBoundingClientRect();
    if (!bounds.width) return;
    const x = (event.clientX - bounds.left) * geometry.width / bounds.width;
    const point = geometry.points.reduce((best, item) => Math.abs(item.x - x) < Math.abs(best.x - x) ? item : best);
    show(point);
  });
  svg(chart, "title", {}, `${rangeTitle}支出趋势`);
  const table = el(footer, "details", "lfn-chart-data");
  table.open = expanded;
  el(table, "summary", "", "查看各月金额");
  const values = el(table, "div", "lfn-chart-month-values");
  for (const point of geometry.points) {
    const row = el(values, "div", "lfn-line");
    el(row, "span", "", monthLabel(point.month)); el(row, "strong", "", point.future ? "未到" : point.incomplete ? "待补全" : money(point.value));
  }
  for (const tick of geometry.ticks) {
    svg(chart, "line", { x1: geometry.plot.left, x2: geometry.plot.right, y1: tick.y, y2: tick.y, class: tick.value === 0 ? "lfn-chart-zero" : "lfn-chart-grid" });
    svg(chart, "text", { x: geometry.plot.left - 9, y: tick.y + 4, "text-anchor": "end", class: "lfn-chart-axis" }, money(tick.value));
  }
  for (const points of geometry.segments) {
    if (points.length < 2) continue;
    const path = points.map((point, index) => `${index ? "L" : "M"}${point.x},${point.y}`).join(" ");
    svg(chart, "path", { d: `${path} L${points.at(-1).x},${geometry.zeroY} L${points[0].x},${geometry.zeroY} Z`, class: "lfn-chart-area" });
    svg(chart, "path", { d: path, class: "lfn-chart-line", fill: "none" });
  }
  for (const [index, point] of geometry.points.entries()) {
    if (index % Math.ceil(geometry.points.length / 12) === 0 || index === geometry.points.length - 1) svg(chart, "text", { x: point.x, y: geometry.height - 14, "text-anchor": "middle", class: `lfn-chart-axis${point.future ? " lfn-chart-future" : ""}` }, summary.longLabels ? point.month.slice(2) : String(Number(point.month.slice(5))));
    if (point.y === null) continue;
    const title = `${monthLabel(point.month)}净支出 ${money(point.value)}${point.month === summary.asOf.slice(0, 7) ? "，本月尚未结束" : point.count ? "" : "，未记支出"}`;
    const group = svg(chart, "g", { tabindex: "0", role: "button", "aria-label": title, "data-month": point.month, "aria-pressed": String(point.month === selectedMonth), class: `lfn-chart-point${point.month === selectedMonth ? " is-selected" : ""}` });
    svg(group, "title", {}, title);
    svg(group, "circle", { cx: point.x, cy: point.y, r: 12, fill: "transparent" });
    svg(group, "circle", { cx: point.x, cy: point.y, r: point.month === selectedMonth ? 4.5 : 3, class: "lfn-chart-point-dot" });
    for (const event of ["mouseenter", "focus", "click"]) group.addEventListener(event, e => { if (event === "click") e.stopPropagation(); show(point); });
    group.addEventListener("keydown", event => { if (["Enter", " "].includes(event.key)) { event.preventDefault(); show(point); } });
  }
  el(footer, "p", "lfn-help lfn-chart-note", `${filtered ? "与左侧类别筛选同步 · " : ""}横轴为月份 · 悬停或点选查看金额${summary.rangeLabel ? " · 仅统计本专项" : summary.year === summary.asOf.slice(0, 4) ? " · 本月尚未结束，后续月份留空" : ""}`);
  if (summary.yearly.missingFx.length) el(footer, "p", "lfn-warning", "部分月份缺少汇率，已留空，补全后自动显示。");
}
module.exports = { createCategoryFilter, renderCategoryChart, renderTrendChart };
