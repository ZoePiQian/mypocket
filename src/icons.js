"use strict";

// Local, decorative line icons. All SVG geometry is fixed; labels remain text.
const SHAPES = Object.freeze({
  attachment: [["path", { d: "m8 12 6-6a3.5 3.5 0 0 1 5 5l-8 8a5 5 0 0 1-7-7l8-8m-5 10 7-7a1.5 1.5 0 0 1 2 2l-7 7" }]],
  search: [["circle", { cx: 10, cy: 10, r: 6 }], ["path", { d: "m15 15 6 6" }]],
  template: [["rect", { x: 4, y: 3, width: 16, height: 18, rx: 2 }], ["path", { d: "M8 7h8M8 11h8M8 15h4" }]],
  plus: [["path", { d: "M12 5v14M5 12h14" }]],
  expense: [["path", { d: "M6 18 18 6M7 6h11v11" }]],
  income: [["path", { d: "M18 6 6 18M17 18H6V7" }]],
  investment: [["path", { d: "M4 4v16h16M8 15l4-5 4 2 4-7" }]],
  repeat: [["path", { d: "m17 2 4 4-4 4M21 6H7a4 4 0 0 0-4 4m4 12-4-4 4-4m-4 4h14a4 4 0 0 0 4-4" }]],
  projects: [["path", { d: "M7 7V4a1 1 0 0 1 1-1h5l2 3h6v12M3 7h5l2 3h8a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1V8a1 1 0 0 1 1-1Z" }]],
  settings: [["path", { d: "M4 7h3m4 0h9M4 17h9m4 0h3" }], ["circle", { cx: 9, cy: 7, r: 2 }], ["circle", { cx: 15, cy: 17, r: 2 }]],
  calculator: [["rect", { x: 5, y: 3, width: 14, height: 18, rx: 2 }], ["path", { d: "M8 7h8M8 11h1m6 0h1M8 15h1m6 0h1M8 18h1m6 0h1" }]],
  memo: [["rect", { x: 5, y: 3, width: 15, height: 18, rx: 2 }], ["path", { d: "M3 7h4M3 12h4M3 17h4m4-10h5m-5 5h5m-5 5h3" }]],
  report: [["path", { d: "M14 3H6a1 1 0 0 0-1 1v16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V8l-5-5Zm0 0v5h5M8 17v-3m4 3v-6m4 6v-4" }]],
  refresh: [["path", { d: "M20 4v5h-5M4 20v-5h5M5 9a7.5 7.5 0 0 1 12.4-3.2L20 9M4 15l2.6 3.2A7.5 7.5 0 0 0 19 15" }]],
  note: [["path", { d: "M14 3H6a1 1 0 0 0-1 1v16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V8l-5-5Zm0 0v5h5M8 12h8m-8 4h6" }]],
  back: [["path", { d: "m14 6-6 6 6 6" }]],
  archive: [["rect", { x: 3, y: 3, width: 18, height: 5, rx: 1 }], ["path", { d: "M5 8v12a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V8m-10 4h6" }]],
  edit: [["path", { d: "m15 4 5 5M4 20l5-1L21 7a1.4 1.4 0 0 0 0-2l-2-2a1.4 1.4 0 0 0-2 0L5 15l-1 5Zm10-1h6" }]],
  refund: [["path", { d: "m8 4-5 5 5 5M3 9h10a5.5 5.5 0 0 1 0 11" }]],
  import: [["path", { d: "M14 4h5a1 1 0 0 1 1 1v14a1 1 0 0 1-1 1h-5M3 12h12m-5-5 5 5-5 5" }]]
});

const POCKET = [
  ["path", { d: "M5 4.5h14v9a7 7 0 0 1-14 0v-9Z" }],
  ["path", { d: "M5 7.5 12 11l7-3.5" }],
  ["path", { d: "M8 13.5a4 4 0 0 0 4 4", "stroke-dasharray": "1 2.6", opacity: ".65" }]
];

function draw(parent, shapes, cls) {
  const doc = parent.ownerDocument, svg = doc.createElementNS("http://www.w3.org/2000/svg", "svg");
  for (const [key, value] of Object.entries({ viewBox: "0 0 24 24", width: "18", height: "18", fill: "none", stroke: "currentColor", "stroke-width": "1.7", "stroke-linecap": "round", "stroke-linejoin": "round", "aria-hidden": "true", focusable: "false", class: cls })) svg.setAttribute(key, value);
  for (const [tag, attributes] of shapes) {
    const shape = doc.createElementNS("http://www.w3.org/2000/svg", tag);
    for (const [key, value] of Object.entries(attributes)) shape.setAttribute(key, String(value));
    svg.appendChild(shape);
  }
  parent.appendChild(svg);
  return svg;
}

function icon(parent, name, cls = "") {
  return draw(parent, Object.prototype.hasOwnProperty.call(SHAPES, name) ? SHAPES[name] : SHAPES.plus, `lfn-ui-icon${cls ? ` ${cls}` : ""}`);
}

function decorate(button, name, { label, iconOnly = false, description } = {}) {
  const text = String(label ?? button.querySelector(".lfn-action-label")?.textContent ?? button.textContent ?? "");
  button.replaceChildren();
  button.classList.add("lfn-action-button");
  button.classList.toggle("lfn-action-icon-only", iconOnly);
  icon(button, name);
  const caption = button.ownerDocument.createElement("span");
  caption.className = "lfn-action-label"; caption.textContent = text; button.appendChild(caption);
  const accessibleLabel = String(description || text);
  button.setAttribute("aria-label", accessibleLabel); button.title = accessibleLabel;
  return button;
}

function brand(parent) {
  const mark = parent.ownerDocument.createElement("span");
  mark.className = "lfn-brand-mark"; mark.setAttribute("aria-hidden", "true");
  draw(mark, POCKET, "lfn-ui-icon lfn-brand-icon");
  parent.appendChild(mark);
  return mark;
}

module.exports = { icon, decorate, brand };
