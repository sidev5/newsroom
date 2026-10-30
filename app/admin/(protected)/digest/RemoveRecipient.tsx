"use client";

import { useRef } from "react";
import { removeRecipientAction } from "./actions";

const btn = "rounded border px-3 py-1.5 text-sm";

/** "Remove" with a confirmation step: taking an address off the list cannot be undone (ADM-05). */
export function RemoveRecipient({ id, email }: { id: string; email: string }) {
  const dialog = useRef<HTMLDialogElement>(null);
  return (
    <>
      <button type="button" onClick={() => dialog.current?.showModal()} className={btn} aria-label={`Remove ${email}`}>
        Remove
      </button>
      <dialog ref={dialog} className="m-auto w-[min(26rem,92vw)] rounded-lg border p-5 shadow-lg backdrop:bg-black/40" aria-labelledby={`remove-${id}`}>
        <form className="flex flex-col gap-4">
          <h2 id={`remove-${id}`} className="text-lg font-semibold">Remove this recipient?</h2>
          <p className="break-all text-sm">
            <strong>{email}</strong> will no longer receive the weekly digest. This cannot be undone: to add the address again you have to paste it in. (To stop sending without losing it, use Deactivate.)
          </p>
          <input type="hidden" name="id" value={id} />
          <input type="hidden" name="confirm" value="yes" />
          <div className="flex justify-end gap-2">
            <button type="button" onClick={() => dialog.current?.close()} className={btn}>Cancel</button>
            <button formAction={removeRecipientAction} className={`${btn} bg-red-700 text-white`}>Remove</button>
          </div>
        </form>
      </dialog>
    </>
  );
}