import { useCallback, useEffect, useState } from "react";

// wiki-v2 #815 — NOT upstream Docmost code. A countdown after a code was emailed, so "Resend email" is not pressed
// again before the first message had a chance to arrive (each resend supersedes the code already on its way).
// Held as a deadline rather than a decrementing counter: a background tab's throttled timer cannot stretch it.
// `start(seconds)` takes a longer wait when the server asked for one (a 429's Retry-After).
export function useResendCooldown(defaultSeconds: number) {
  const [until, setUntil] = useState<number | null>(null);
  const [now, setNow] = useState(() => Date.now());

  const start = useCallback(
    (seconds: number = defaultSeconds) => {
      const at = Date.now();
      setNow(at);
      setUntil(at + seconds * 1000);
    },
    [defaultSeconds],
  );

  const reset = useCallback(() => setUntil(null), []);

  const remaining =
    until === null ? 0 : Math.max(0, Math.ceil((until - now) / 1000));

  useEffect(() => {
    if (remaining <= 0) return;
    const timer = setTimeout(() => setNow(Date.now()), 1000);
    return () => clearTimeout(timer);
  }, [remaining, now]);

  return { remaining, start, reset };
}
