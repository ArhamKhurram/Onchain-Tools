/**
 * Trailing-edge commit for inputs that fire continuously.
 *
 * A native `<input type="color">` (and the opacity slider next to it) emits an
 * event for every tick of a drag inside the OS picker. Committing each tick
 * upstream meant a `PUT /api/config` per tick — dozens per gesture — which is
 * what made colour changes lag the console, and what let out-of-order
 * responses re-apply an intermediate colour over the one the user settled on.
 *
 * `push` records the newest value and (re)arms a timer; only the last value
 * pushed before `delayMs` of quiet is committed. `flush` commits a pending
 * value immediately (used on unmount so closing a modal right after picking a
 * colour never drops it). The final value is therefore always committed —
 * this is a trailing debounce, never a sampler.
 */
export interface TrailingCommit<T> {
  push: (value: T) => void;
  flush: () => void;
  cancel: () => void;
}

export function createTrailingCommit<T>(
  commit: (value: T) => void,
  delayMs: number,
): TrailingCommit<T> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let pending: { value: T } | null = null;

  const clear = () => {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
  };

  const fire = () => {
    timer = null;
    if (!pending) return;
    const { value } = pending;
    pending = null;
    commit(value);
  };

  return {
    push(value: T) {
      pending = { value };
      clear();
      timer = setTimeout(fire, delayMs);
    },
    flush() {
      clear();
      fire();
    },
    cancel() {
      clear();
      pending = null;
    },
  };
}
