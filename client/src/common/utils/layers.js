// Popups and modals are portaled to document.body, so they sit outside the DOM subtree of whatever
// opened them. Outside-click handlers use these markers to tell "clicked a popup/modal that belongs
// on top of me" apart from a genuine click outside.
//
// - Popovers (dropdowns, context menus, tooltips, ...): spread POPOVER_LAYER onto the portaled root.
// - Modals (dialogs, full-screen overlays): spread MODAL_LAYER onto the portaled root.

export const POPOVER_LAYER = { "data-popover-layer": "" };
export const MODAL_LAYER = { "data-modal-layer": "" };

const asElement = (target) => (target instanceof Element ? target : target?.parentElement ?? null);

export const isInPopoverLayer = (target) => !!asElement(target)?.closest("[data-popover-layer]");

export const isInModalLayer = (target) => !!asElement(target)?.closest("[data-modal-layer]");

// Modals are appended to document.body as they open, so the last one in document order is on top.
export const isTopmostModal = (element) => {
    if (!element) return false;
    const modals = document.querySelectorAll("[data-modal-layer]");
    return modals[modals.length - 1] === element;
};
