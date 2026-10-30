"use client";

import { useEffect, useId, useRef, useState } from "react";
import { cannotAdd, MENU, type EditorBlock, type MenuChoice } from "@/lib/stories/editor";

/**
 * The "+" between blocks (and at the very start): opens a menu of block types. Keyboard: Enter or Space opens it and puts the
 * focus on the first choice, the arrow keys move, Escape closes it and gives the focus back to the "+".
 */
export function AddBlock({ index, blocks, onAdd, first }: { index: number; blocks: readonly EditorBlock[]; onAdd: (choice: MenuChoice, index: number) => void; first?: boolean }) {
  const [open, setOpen] = useState(false);
  const button = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLUListElement>(null);
  const menuId = useId();

  useEffect(() => {
    if (open) menu.current?.querySelector<HTMLButtonElement>("button:not([disabled])")?.focus();
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const away = (e: MouseEvent) => {
      if (!menu.current?.contains(e.target as Node) && !button.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", away);
    return () => document.removeEventListener("mousedown", away);
  }, [open]);

  const choices = MENU.map((choice) => ({ choice, why: cannotAdd(blocks, choice) }));
  const full = choices.every((c) => c.why);

  function onMenuKey(e: React.KeyboardEvent) {
    if (e.key === "Escape") {
      e.preventDefault();
      setOpen(false);
      button.current?.focus();
      return;
    }
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
    e.preventDefault();
    const items = [...(menu.current?.querySelectorAll<HTMLButtonElement>("button:not([disabled])") ?? [])];
    const at = items.indexOf(document.activeElement as HTMLButtonElement);
    items[(at + (e.key === "ArrowDown" ? 1 : -1) + items.length) % items.length]?.focus();
  }

  return (
    <div className="relative flex items-center gap-3 py-1" onKeyDown={onMenuKey}>
      <span aria-hidden="true" className="h-px flex-1 bg-line" />
      <button
        ref={button}
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        aria-label={first ? "Add a block at the start" : `Add a block after block ${index}`}
        disabled={full}
        onClick={() => setOpen((v) => !v)}
        className="inline-flex size-9 items-center justify-center rounded-full border border-input bg-paper text-[20px] font-medium leading-none text-deep-sage hover:bg-mint disabled:opacity-40"
      >
        <span aria-hidden="true">+</span>
      </button>
      <span aria-hidden="true" className="h-px flex-1 bg-line" />
      {open && (
        <ul id={menuId} ref={menu} role="menu" aria-label="Block types" className="absolute left-1/2 top-full z-30 mt-1 grid w-[min(20rem,calc(100vw-2rem))] -translate-x-1/2 grid-cols-2 gap-1 rounded-lg border border-line bg-paper p-2 shadow-lg">
          {choices.map(({ choice, why }) => (
            <li key={choice.key} role="none">
              <button
                type="button"
                role="menuitem"
                disabled={Boolean(why)}
                title={why ?? undefined}
                onClick={() => {
                  setOpen(false);
                  onAdd(choice, index);
                }}
                className="min-h-11 w-full rounded-md px-3 text-left text-[15px] text-ink hover:bg-mint disabled:opacity-40"
              >
                {choice.label}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
