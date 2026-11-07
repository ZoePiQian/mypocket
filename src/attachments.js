"use strict";

const MAX_ATTACHMENTS = 10, MAX_BYTES = 10 * 1024 * 1024;
const EXTENSIONS = ["png", "jpg", "jpeg", "webp", "gif", "pdf"];

function normalizePath(value) {
  if (typeof value !== "string") throw new Error("凭证路径须为笔记库内的相对路径");
  const path = value.trim().replace(/\\/g, "/");
  if (!path || path.length > 1000 || /[:*?"<>|\[\]#^%\u0000-\u001f\u007f]/.test(path)
    || path.split("/").some(part => !part || part === "." || part === ".." || part.startsWith(".") || /[. ]$/.test(part)))
    throw new Error("凭证路径须为笔记库内的普通文件路径，不能使用网址或上级目录");
  if (!EXTENSIONS.includes(path.split(".").at(-1).toLowerCase())) throw new Error("凭证仅支持 PNG、JPG、WEBP、GIF 或 PDF");
  return path;
}
function normalizePaths(value) {
  if (value == null) return [];
  if (!Array.isArray(value) || value.length > MAX_ATTACHMENTS) throw new Error(`每笔记录最多关联 ${MAX_ATTACHMENTS} 个凭证`);
  return [...new Set(value.map(normalizePath))];
}
function parseCell(value) {
  if (!value.trim()) return [];
  return normalizePaths(value.split(/<br\s*\/?>|\r?\n/gi).map(link => {
    const match = /^\[\[([^\[\]]+)\]\]$/.exec(link.trim());
    if (!match) throw new Error("凭证列须为 [[库内文件路径]]，多个凭证用 <br> 分隔");
    return match[1];
  }));
}
function bytesOf(data) {
  if (data instanceof Uint8Array || Object.prototype.toString.call(data) === "[object Uint8Array]")
    return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  if (Object.prototype.toString.call(data) === "[object ArrayBuffer]") return new Uint8Array(data);
  throw new Error("无法读取凭证文件，请重新选择");
}
function validateUpload({ name, data }) {
  if (typeof name !== "string" || !name.trim()) throw new Error("凭证文件名不能为空");
  const extension = name.split(".").at(-1).toLowerCase();
  if (!EXTENSIONS.includes(extension)) throw new Error("凭证仅支持 PNG、JPG、WEBP、GIF 或 PDF");
  const bytes = bytesOf(data);
  if (!bytes.length || bytes.length > MAX_BYTES) throw new Error("每个凭证须为非空文件，且不超过 10 MB");
  const starts = values => values.every((value, index) => bytes[index] === value);
  const ascii = (offset, text) => [...text].every((char, index) => bytes[offset + index] === char.charCodeAt(0));
  const valid = extension === "png" ? starts([137, 80, 78, 71, 13, 10, 26, 10])
    : ["jpg", "jpeg"].includes(extension) ? starts([255, 216, 255])
    : extension === "gif" ? ascii(0, "GIF87a") || ascii(0, "GIF89a")
    : extension === "webp" ? bytes.length >= 12 && ascii(0, "RIFF") && ascii(8, "WEBP")
    : ascii(0, "%PDF-");
  if (!valid) throw new Error("凭证内容与文件类型不符，请选择原始图片或 PDF 文件");
  return { extension, bytes };
}
module.exports = { MAX_ATTACHMENTS, MAX_BYTES, EXTENSIONS, normalizePath, normalizePaths, parseCell, bytesOf, validateUpload };
