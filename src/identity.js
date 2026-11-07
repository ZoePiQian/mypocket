"use strict";

// randomUUID requires a secure context in some Android WebViews. getRandomValues does not.
function createId(provider = globalThis.crypto) {
  if (typeof provider?.randomUUID === "function") return provider.randomUUID();
  if (typeof provider?.getRandomValues !== "function") throw new Error("当前环境无法生成记录 ID，请更新 Obsidian 后重试");
  const bytes = provider.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 15) | 64;
  bytes[8] = (bytes[8] & 63) | 128;
  const hex = [...bytes].map(byte => byte.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

module.exports = { createId };
