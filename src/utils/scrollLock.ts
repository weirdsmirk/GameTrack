/**
 * Reference-counted body scroll lock.
 *
 * Six components each set `document.body.style.overflow = "hidden"` on open and
 * reset it to `""` on unmount. That works until two of them are open at once —
 * which the app does by design (the details modal and the active-playing conflict
 * dialog are nested; Settings can be opened over the details modal). The child
 * then owns the flag *and* the reset, so dismissing it released the lock while
 * its parent was still on screen: the page behind a live dialog became
 * scrollable for the rest of the session, with no way to notice and no way back
 * short of opening another dialog.
 *
 * Counting holders instead of toggling a boolean fixes it: the lock is only
 * released when the last holder lets go.
 */

let holders = 0;

export function lockBodyScroll(): () => void {
  holders += 1;
  // Re-assert on every acquire. A holder that mounted while another dialog had
  // already released the flag would otherwise start life unlocked.
  document.body.style.overflow = "hidden";

  let released = false;
  return () => {
    // Idempotent: React can run a cleanup twice under StrictMode, and a second
    // decrement would wrongly unlock the page while another dialog is still up.
    if (released) return;
    released = true;
    holders = Math.max(0, holders - 1);
    if (holders === 0) document.body.style.overflow = "";
  };
}
