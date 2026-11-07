"use strict";

// Small, local vector marks share a 24px grid and the same outline weight.
const ICONS = {
  folder: { label: "通用", shapes: [["path", { d: "M3 7V5.5A1.5 1.5 0 0 1 4.5 4H9l3 3h7.5A1.5 1.5 0 0 1 21 8.5v10a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 18.5V7Z" }], ["path", { d: "M3 9h18" }]] },
  home: { label: "装修", shapes: [["path", { d: "m3 10 9-7 9 7M5 9v11h14V9M9 20v-7h6v7" }]] },
  compass: { label: "旅行", shapes: [["circle", { cx: 12, cy: 12, r: 9 }], ["path", { d: "m16 8-2.5 5.5L8 16l2.5-5.5L16 8Z" }]] },
  dumbbell: { label: "健身", shapes: [["path", { d: "m8 8 8 8M5 5l4-2 3 3-6 6-3-3 2-4Zm14 14-4 2-3-3 6-6 3 3-2 4Z" }], ["path", { d: "m2 6 4-4m12 20 4-4" }]] },
  book: { label: "学习", shapes: [["path", { d: "M12 6v15M3 4h5a4 4 0 0 1 4 4 4 4 0 0 1 4-4h5v14h-5a4 4 0 0 0-4 3 4 4 0 0 0-4-3H3V4Z" }]] },
  heart: { label: "健康", shapes: [["path", { d: "M12 20 4 12a5 5 0 0 1 7-7l1 1 1-1a5 5 0 0 1 7 7l-8 8Z" }]] },
  car: { label: "出行", shapes: [["path", { d: "m5 9 2-5h10l2 5M3 10h18v8H3v-8ZM5 18v3m14-3v3M6 13h2m8 0h2" }]] },
  briefcase: { label: "工作", shapes: [["rect", { x: 3, y: 7, width: 18, height: 14, rx: 2 }], ["path", { d: "M8 7V3h8v4M3 12a24 24 0 0 0 18 0M10 13v3h4v-3" }]] },
  ball: { label: "运动", shapes: [["circle", { cx: 12, cy: 12, r: 9 }], ["path", { d: "M3 12h18M12 3v18M5.6 5.6c6 2 6 10.8 0 12.8M18.4 5.6c-6 2-6 10.8 0 12.8" }]] },
  paw: { label: "宠物", shapes: [["ellipse", { cx: 5, cy: 10, rx: 2, ry: 2.5 }], ["ellipse", { cx: 9.5, cy: 5.5, rx: 2, ry: 2.5 }], ["ellipse", { cx: 15.5, cy: 5.5, rx: 2, ry: 2.5 }], ["ellipse", { cx: 20, cy: 10, rx: 2, ry: 2.5 }], ["path", { d: "M8 15c1-4 7-4 8 0 1 1 3 2 2 4-1 3-4 1-6 1s-5 2-6-1c-1-2 1-3 2-4Z" }]] }
};
const COLORS = {
  sage: { label: "松绿", light: "#267d70", dark: "#69baa7", lightRgb: "38,125,112", darkRgb: "105,186,167" },
  mist: { label: "雾蓝", light: "#486e9b", dark: "#8ba8d3", lightRgb: "72,110,155", darkRgb: "139,168,211" },
  sand: { label: "暖砂", light: "#8c682e", dark: "#d3ae70", lightRgb: "140,104,46", darkRgb: "211,174,112" },
  rose: { label: "陶粉", light: "#965e5e", dark: "#d1a09c", lightRgb: "150,94,94", darkRgb: "209,160,156" },
  slate: { label: "岩灰", light: "#656a80", dark: "#adb3c9", lightRgb: "101,106,128", darkRgb: "173,179,201" }
};
function normalize(value = {}) {
  const input = value && typeof value === "object" ? value : {};
  return {
    coverIcon: typeof input.coverIcon === "string" && Object.hasOwn(ICONS, input.coverIcon) ? input.coverIcon : "folder",
    coverColor: typeof input.coverColor === "string" && Object.hasOwn(COLORS, input.coverColor) ? input.coverColor : "sage"
  };
}
module.exports = { ICONS, COLORS, normalize };
