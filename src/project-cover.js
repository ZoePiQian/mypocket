"use strict";
const { ICONS, COLORS, normalize } = require("./project-appearance");
const { decorate } = require("./icons");

function el(parent, tag, cls = "", text = "") {
  const node = parent.ownerDocument.createElement(tag);
  node.className = cls; node.textContent = text; parent.appendChild(node); return node;
}
function mark(parent, name, cls = "") {
  const doc = parent.ownerDocument, icon = ICONS[normalize({ coverIcon: name }).coverIcon];
  const svg = doc.createElementNS("http://www.w3.org/2000/svg", "svg");
  for (const [key, value] of Object.entries({ viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", "stroke-width": 1.65, "stroke-linecap": "round", "stroke-linejoin": "round", "aria-hidden": "true", focusable: "false", class: cls })) svg.setAttribute(key, value);
  for (const [tag, attributes] of icon.shapes) {
    const shape = doc.createElementNS("http://www.w3.org/2000/svg", tag);
    for (const [key, value] of Object.entries(attributes)) shape.setAttribute(key, value);
    svg.appendChild(shape);
  }
  parent.appendChild(svg); return svg;
}
function applyTheme(element, project, scope = false) {
  const appearance = normalize(project), color = COLORS[appearance.coverColor];
  element.classList.add("lfn-project-themed"); element.classList.toggle("lfn-project-scope", scope);
  element.dataset.lfnCoverColor = appearance.coverColor;
  for (const [key, value] of Object.entries({ light: color.light, dark: color.dark, "light-rgb": color.lightRgb, "dark-rgb": color.darkRgb })) element.style.setProperty(`--lfn-cover-${key}`, value);
}
function renderCover(parent, project, { compact = false, preview = false, onEdit = null } = {}) {
  const appearance = normalize(project);
  const cover = el(parent, "div", `lfn-project-cover${compact ? " lfn-project-cover-compact" : ""}${preview ? " lfn-project-cover-preview" : ""}`); applyTheme(cover, appearance);
  const art = el(cover, "div", "lfn-cover-art"); art.setAttribute("aria-hidden", "true"); mark(art, appearance.coverIcon, "lfn-cover-watermark");
  const identity = el(cover, "div", "lfn-cover-identity"), emblem = el(identity, "span", "lfn-cover-emblem"); mark(emblem, appearance.coverIcon);
  const copy = el(identity, "div", "lfn-cover-copy"), heading = el(copy, "div", "lfn-cover-heading");
  el(heading, compact ? "h3" : preview ? "h3" : "h1", "", project.name || "专项名称");
  const status = el(heading, "span", "lfn-cover-status", project.status === "archived" ? "已归档" : "专项账本");
  if (project.status === "archived") status.classList.add("is-archived");
  el(copy, "p", "lfn-cover-caption", compact ? "为这件事，留一份清楚的记录。" : "独立记录这件事的每一笔花费。");
  if (onEdit) {
    const edit = el(cover, "button", "lfn-button lfn-cover-edit", "编辑封面"); edit.type = "button";
    decorate(edit, "edit");
    edit.addEventListener("click", onEdit);
  }
  return cover;
}
function createCoverEditor(parent, project, { open = false } = {}) {
  let value = normalize(project), name = project.name || "", status = project.status || "active";
  const root = el(parent, "div", "lfn-cover-editor"), preview = el(root, "div", "lfn-cover-editor-preview");
  const details = el(root, "details", "lfn-cover-settings"); details.open = open;
  const summary = el(details, "summary", "lfn-cover-settings-summary"); el(summary, "span", "", "自定义封面"); const caption = el(summary, "span", "lfn-cover-selection");
  const body = el(details, "div", "lfn-cover-settings-body");
  el(body, "p", "lfn-help", "图标与色彩会同时用于专项卡片和详情封面。");
  el(body, "div", "lfn-field-label", "封面图标");
  const icons = el(body, "div", "lfn-cover-icon-options"); icons.setAttribute("role", "group"); icons.setAttribute("aria-label", "封面图标");
  const iconButtons = [], colorButtons = [];
  const update = () => {
    applyTheme(root, value); preview.replaceChildren(); renderCover(preview, { ...value, name, status }, { preview: true });
    caption.textContent = `${ICONS[value.coverIcon].label} · ${COLORS[value.coverColor].label}`;
    for (const [key, button] of iconButtons) button.setAttribute("aria-pressed", String(value.coverIcon === key));
    for (const [key, button] of colorButtons) button.setAttribute("aria-pressed", String(value.coverColor === key));
  };
  for (const [key, icon] of Object.entries(ICONS)) {
    const button = el(icons, "button", "lfn-cover-icon-option"); button.type = "button"; button.setAttribute("aria-label", icon.label);
    mark(button, key); el(button, "span", "", icon.label);
    button.addEventListener("click", () => { value = { ...value, coverIcon: key }; update(); }); iconButtons.push([key, button]);
  }
  el(body, "div", "lfn-field-label", "主题色");
  const colors = el(body, "div", "lfn-cover-color-options"); colors.setAttribute("role", "group"); colors.setAttribute("aria-label", "封面主题色");
  for (const [key, color] of Object.entries(COLORS)) {
    const button = el(colors, "button", "lfn-cover-color-option"); button.type = "button"; button.setAttribute("aria-label", color.label);
    const dot = el(button, "span", "lfn-cover-color-dot"); applyTheme(dot, { coverColor: key });
    el(button, "span", "", color.label);
    button.addEventListener("click", () => { value = { ...value, coverColor: key }; update(); }); colorButtons.push([key, button]);
  }
  update();
  return { element: root, getValue: () => ({ ...value }), setName(next) { name = next; update(); }, setStatus(next) { status = next; update(); } };
}
module.exports = { mark, applyTheme, renderCover, createCoverEditor };
