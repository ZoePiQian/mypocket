"use strict";
const { ItemView, Component, MarkdownRenderer, Modal } = require("obsidian");
const guide = require("./guide-content");
const { brand, decorate } = require("./icons");
const GUIDE_VIEW_TYPE = "local-finance-notes-guide";
function el(parent, tag, cls = "", text = "") {
  const node = parent.ownerDocument.createElement(tag); node.className = cls; node.textContent = text; parent.appendChild(node); return node;
}
function slug(text) { return text.trim().toLowerCase().replace(/[^\p{L}\p{N}\s_-]/gu, "").replace(/\s/g, "-"); }
class GuideImageModal extends Modal {
  constructor(app, source, caption) { super(app); this.source = source; this.caption = caption; }
  onOpen() {
    this.modalEl.classList.add("lfn-guide-image-modal");
    const toolbar = el(this.contentEl, "div", "lfn-guide-image-toolbar");
    el(toolbar, "p", "lfn-help", this.caption);
    const zoom = el(toolbar, "button", "lfn-button", "原始尺寸"); zoom.type = "button"; zoom.setAttribute("aria-pressed", "false");
    const viewport = el(this.contentEl, "div", "lfn-guide-image-viewport"), img = el(viewport, "img"); img.src = this.source; img.alt = this.caption;
    zoom.addEventListener("click", () => { const actual = viewport.classList.toggle("is-actual-size"); zoom.textContent = actual ? "适应窗口" : "原始尺寸"; zoom.setAttribute("aria-pressed", String(actual)); });
  }
  onClose() { this.contentEl.replaceChildren(); }
}
class GuideView extends ItemView {
  constructor(leaf, plugin) { super(leaf); this.plugin = plugin; this.generation = 0; }
  getViewType() { return GUIDE_VIEW_TYPE; }
  getDisplayText() { return "My Pocket · 使用指南"; }
  getIcon() { return "book-open"; }
  async onOpen() {
    const generation = ++this.generation, container = this.contentEl;
    this.renderComponent?.unload(); this.renderComponent = new Component(); this.renderComponent.load();
    container.replaceChildren(); container.classList.add("lfn-dashboard", "lfn-guide-view");
    const shell = el(container, "article", "lfn-guide-shell"), header = el(shell, "div", "lfn-guide-toolbar");
    const identity = el(header, "div", "lfn-brand-identity"); brand(identity); el(identity, "span", "lfn-help", "MY POCKET / 使用指南");
    const back = el(header, "button", "lfn-button", "开始记账"); back.type = "button"; decorate(back, "back");
    back.addEventListener("click", () => this.plugin.run(() => this.plugin.activateView()));
    const body = el(shell, "div", "lfn-guide-body markdown-rendered");
    const parts = guide.markdown.split(/(^!\[[^\]\r\n]*\]\([^\r\n]+\)\s*$)/m);
    for (const part of parts) {
      if (generation !== this.generation) return;
      const match = /^!\[([^\]]*)\]\(([^\r\n]+)\)\s*$/.exec(part);
      if (match && guide.images[match[2]]) {
        const figure = el(body, "figure", "lfn-guide-figure"), img = el(figure, "img");
        img.alt = match[1]; img.src = guide.images[match[2]]; img.loading = "lazy"; img.decoding = "async";
        const size = guide.imageSizes?.[match[2]];
        if (size) { img.width = size.width; img.height = size.height; }
        img.tabIndex = 0; img.setAttribute("role", "button"); img.setAttribute("aria-label", `查看大图：${match[1]}`); img.title = "点击查看大图";
        const open = () => new GuideImageModal(this.plugin.app, img.src, img.alt).open();
        img.addEventListener("click", open);
        img.addEventListener("keydown", event => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); open(); } });
        el(figure, "figcaption", "lfn-help", match[1]);
      } else if (part.trim()) {
        const section = el(body, "div", "lfn-guide-section");
        await MarkdownRenderer.render(this.plugin.app, part, section, "", this.renderComponent);
      }
    }
    if (generation !== this.generation) return;
    const used = new Map();
    for (const heading of body.querySelectorAll("h1,h2,h3,h4")) {
      const key = slug(heading.textContent), count = used.get(key) || 0; used.set(key, count + 1);
      heading.id = key + (count ? `-${count}` : "");
    }
    this.registerDomEvent(body, "click", event => {
      const anchor = event.target.closest?.("a"); if (!anchor) return;
      const href = anchor.getAttribute("href") || anchor.dataset.href || "";
      if (!href.startsWith("#")) return;
      let id; try { id = decodeURIComponent(href.slice(1)); } catch (_) { return; }
      const target = [...body.querySelectorAll("h1,h2,h3,h4")].find(h => h.id === id || slug(h.textContent) === slug(id));
      if (target) { event.preventDefault(); event.stopPropagation(); target.scrollIntoView({ block: "start" }); target.tabIndex = -1; target.focus({ preventScroll: true }); }
    }, { capture: true });
  }
  async onClose() { this.generation++; this.renderComponent?.unload(); this.renderComponent = null; this.contentEl.replaceChildren(); }
}
module.exports = { GUIDE_VIEW_TYPE, GuideView };
