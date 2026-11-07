"use strict";
const { Scope } = require("obsidian");
const { isTouchDevice } = require("./mobile");

// Clicking opens the whole list; only typing narrows the suggestions.
function createSuggestions(input, values, label, app, parentScope) {
  const document = input.ownerDocument;
  const fieldEl = input.parentElement;
  const host = document.createElement("div");
  host.className = "lfn-suggest";
  fieldEl.insertBefore(host, input);
  host.appendChild(input);
  input.maxLength = 120;
  input.autocomplete = "off";
  input.setAttribute("role", "combobox");
  input.setAttribute("aria-label", label);
  input.setAttribute("aria-autocomplete", "list");
  input.setAttribute("aria-expanded", "false");
  const toggle = document.createElement("button");
  toggle.type = "button";
  toggle.className = "lfn-suggest-toggle";
  toggle.textContent = "▾";
  toggle.tabIndex = -1;
  toggle.setAttribute("aria-label", `显示全部${label.replace(/\s*\*$/, "")}`);
  host.appendChild(toggle);
  const menu = document.createElement("div");
  menu.className = "lfn-suggest-menu";
  menu.id = `lfn-suggest-${Math.random().toString(36).slice(2)}`;
  menu.setAttribute("role", "listbox");
  menu.setAttribute("aria-label", label.replace(/\s*\*$/, ""));
  menu.hidden = true;
  host.appendChild(menu);
  input.setAttribute("aria-controls", menu.id);
  let options = [...values], visible = [], active = -1, scopeActive = false, menuPointer = false;
  const win = document.defaultView, touch = isTouchDevice(input);
  const position = () => {
    if (menu.hidden) return;
    const rect = host.getBoundingClientRect();
    const bounds = host.closest(".lfn-modal")?.getBoundingClientRect();
    const viewport = win.visualViewport;
    const top = Math.max(bounds?.top || 0, viewport?.offsetTop || 0);
    const bottom = Math.min(bounds?.bottom || win.innerHeight, (viewport?.offsetTop || 0) + (viewport?.height || win.innerHeight));
    const above = rect.top - top - 8, below = bottom - rect.bottom - 8;
    const flip = below < 150 && above > below;
    menu.style.top = flip ? "auto" : "calc(100% + 4px)";
    menu.style.bottom = flip ? "calc(100% + 4px)" : "auto";
    menu.style.maxHeight = `${Math.max(44, Math.min(touch ? 264 : 180, flip ? above : below))}px`;
  };
  const menuScope = new Scope(parentScope);
  const close = () => {
    if (scopeActive) { app.keymap.popScope(menuScope); scopeActive = false; }
    menu.hidden = true;
    input.setAttribute("aria-expanded", "false");
    input.removeAttribute("aria-activedescendant");
    active = -1;
  };
  // Give the open menu priority over the modal's Escape shortcut.
  menuScope.register([], "Escape", () => { close(); return false; });
  const markActive = index => {
    active = index;
    for (let i = 0; i < menu.children.length; i++) {
      menu.children[i].setAttribute("aria-selected", String(i === active));
    }
    if (active >= 0 && visible[active] !== undefined) {
      const choice = menu.children[active];
      input.setAttribute("aria-activedescendant", choice.id);
      choice.scrollIntoView({ block: "nearest" });
    } else input.removeAttribute("aria-activedescendant");
  };
  const choose = value => {
    input.value = value;
    input.dispatchEvent(new document.defaultView.Event("input", { bubbles: true }));
    input.dispatchEvent(new document.defaultView.Event("change", { bubbles: true }));
    close();
    if (touch) input.blur(); else input.focus();
  };
  const open = (query = "") => {
    visible = options.filter(value => value.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()));
    menu.replaceChildren();
    active = -1;
    input.removeAttribute("aria-activedescendant");
    for (const [index, value] of visible.entries()) {
      const choice = document.createElement("button");
      choice.type = "button";
      choice.className = "lfn-suggest-option";
      choice.id = `${menu.id}-${index}`;
      choice.textContent = value;
      choice.tabIndex = -1;
      choice.setAttribute("role", "option");
      choice.setAttribute("aria-selected", "false");
      choice.addEventListener("mousedown", event => event.preventDefault());
      choice.addEventListener("click", event => { event.preventDefault(); choose(value); });
      menu.appendChild(choice);
    }
    if (!visible.length) {
      const empty = document.createElement("div");
      empty.className = "lfn-help lfn-suggest-empty";
      empty.textContent = "没有匹配选项，可直接输入新名称";
      menu.appendChild(empty);
    }
    menu.hidden = false;
    if (!scopeActive) { app.keymap.pushScope(menuScope); scopeActive = true; }
    input.setAttribute("aria-expanded", "true");
    position();
  };
  input.addEventListener("click", () => open());
  input.addEventListener("input", event => { if (!event.isComposing) open(input.value); });
  input.addEventListener("compositionend", () => open(input.value));
  // Touch scrolling/tapping blurs the input before click on Android. Keep the list
  // alive for that click, and close it on the next tap outside the control instead.
  input.addEventListener("blur", event => { if (!menuPointer && !host.contains(event.relatedTarget)) close(); });
  const outside = event => {
    menuPointer = menu.contains(event.target);
    if (!host.contains(event.target)) close();
  };
  document.addEventListener("pointerdown", outside, true);
  win.addEventListener("resize", position);
  win.visualViewport?.addEventListener("resize", position);
  toggle.addEventListener("mousedown", event => event.preventDefault());
  toggle.addEventListener("click", event => {
    event.preventDefault();
    const wasOpen = !menu.hidden;
    if (!touch) input.focus();
    if (wasOpen) close(); else open();
  });
  input.addEventListener("keydown", event => {
    if (event.isComposing || event.ctrlKey || event.metaKey || event.altKey) return;
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      if (menu.hidden) open();
      if (visible.length) markActive(event.key === "ArrowDown" ? (active + 1) % visible.length : (active <= 0 ? visible.length - 1 : active - 1));
    } else if (event.key === "Enter" && !menu.hidden) {
      event.preventDefault(); event.stopPropagation();
      if (active >= 0) choose(visible[active]); else close();
    } else if (event.key === "Escape" && !menu.hidden) {
      event.preventDefault(); event.stopPropagation(); close();
    } else if (event.key === "Tab") close();
  });
  return {
    input, fieldEl,
    list: { setOptions(next) { options = [...next]; if (!menu.hidden) open(); }, destroy() {
      close();
      document.removeEventListener("pointerdown", outside, true);
      win.removeEventListener("resize", position);
      win.visualViewport?.removeEventListener("resize", position);
    } },
  };
}

module.exports = { createSuggestions };
