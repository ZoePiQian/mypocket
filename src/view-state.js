"use strict";

// Capture immediately before replacing DOM, so typing during an async scan survives.
function captureViewState(root) {
  const doc = root.ownerDocument, active = doc.activeElement;
  const focus = root.contains(active) ? { name: active.getAttribute("name"), label: active.getAttribute("aria-label"), tag: active.tagName, start: active.selectionStart, end: active.selectionEnd } : null;
  const details = [...root.querySelectorAll("details")].map((node, index) => ({ index, cls: node.className, open: node.open }));
  return { scrollTop: root.scrollTop, scrollLeft: root.scrollLeft, focus, details };
}
function restoreViewState(root, state) {
  if (!state) return;
  if (state.focus) {
    const saved = state.focus;
    const control = [...root.querySelectorAll("input,textarea,select,button,summary")].find(node => node.tagName === saved.tag && (saved.name ? node.getAttribute("name") === saved.name : saved.label && node.getAttribute("aria-label") === saved.label));
    if (control && !control.disabled && !control.closest("[hidden]")) {
      control.focus({ preventScroll: true });
      if (typeof saved.start === "number") { try { control.setSelectionRange(saved.start, saved.end); } catch (_) {} }
    }
  }
  const details = [...root.querySelectorAll("details")];
  for (const saved of state.details) if (details[saved.index]?.className === saved.cls) details[saved.index].open = saved.open;
  root.scrollTop = state.scrollTop; root.scrollLeft = state.scrollLeft;
}
module.exports = { captureViewState, restoreViewState };
