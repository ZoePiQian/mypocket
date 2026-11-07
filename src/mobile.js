"use strict";

function isTouchDevice(element) {
  const doc = element?.ownerDocument || element;
  return Boolean(doc?.body?.classList?.contains("is-mobile") || doc?.defaultView?.matchMedia?.("(pointer: coarse)").matches);
}

// VisualViewport follows Android's soft keyboard even when the layout viewport does not.
// Keep listeners local to the open modal; nested settings dialogs have their own lifecycle.
function adaptModal(modal) {
  const content = modal.contentEl, shell = modal.modalEl, win = content.ownerDocument?.defaultView;
  if (!win || !isTouchDevice(content)) return () => {};
  shell.classList.add("lfn-responsive-modal", "lfn-touch");
  const container = shell.parentElement?.classList.contains("modal-container") ? shell.parentElement : null;
  container?.classList.add("lfn-mobile-container");
  const viewport = win.visualViewport;
  let frame = 0;
  const reveal = () => {
    frame = 0;
    const active = content.ownerDocument.activeElement;
    if (!content.contains(active) || !active.matches("input, textarea, select")) return;
    const bounds = content.getBoundingClientRect(), rect = active.getBoundingClientRect();
    const footer = content.querySelector(".lfn-modal-actions");
    const bottom = Math.min(bounds.bottom, (viewport?.offsetTop || 0) + (viewport?.height || win.innerHeight)) - (footer?.offsetHeight || 0) - 12;
    const top = bounds.top + 12;
    if (rect.bottom > bottom) content.scrollTop += Math.min(rect.bottom - bottom, rect.top - top);
    else if (rect.top < top) content.scrollTop -= top - rect.top;
  };
  const update = () => {
    const height = `${Math.round(viewport?.height || win.innerHeight)}px`;
    shell.style.setProperty("--lfn-viewport-height", height);
    if (container) {
      container.style.setProperty("--lfn-viewport-height", height);
      container.style.setProperty("--lfn-viewport-top", `${Math.round(viewport?.offsetTop || 0)}px`);
    }
    win.cancelAnimationFrame(frame);
    frame = win.requestAnimationFrame(reveal);
  };
  win.addEventListener("resize", update);
  viewport?.addEventListener("resize", update);
  viewport?.addEventListener("scroll", update);
  content.addEventListener("focusin", update);
  update();
  return () => {
    win.cancelAnimationFrame(frame);
    win.removeEventListener("resize", update);
    viewport?.removeEventListener("resize", update);
    viewport?.removeEventListener("scroll", update);
    content.removeEventListener("focusin", update);
    container?.classList.remove("lfn-mobile-container");
    container?.style.removeProperty("--lfn-viewport-height");
    container?.style.removeProperty("--lfn-viewport-top");
  };
}

module.exports = { isTouchDevice, adaptModal };
