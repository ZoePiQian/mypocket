"use strict";
const core = require("./core");

function periodPaths(folder, section, month) {
  if (!["流水", "月报"].includes(section) || !core.validMonth(month)) throw new Error("请选择有效的月份和笔记类型");
  const root = core.normalizeFolder(folder);
  return { current: `${root}/${section}/${month.slice(0, 4)}/${month}.md`, legacy: `${root}/${section}/${month}.md` };
}

function isMonthlyPath(path, folder) {
  const month = String(path).split("/").at(-1)?.replace(/\.md$/, "");
  if (!core.validMonth(month)) return false;
  const paths = periodPaths(folder, "流水", month);
  return path === paths.current || path === paths.legacy;
}

module.exports = { periodPaths, isMonthlyPath };
