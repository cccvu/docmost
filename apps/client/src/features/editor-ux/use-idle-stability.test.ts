// cccvu/wiki-v2#810 (final live check L2-2) — `useIdle`'s resetIdle must keep its identity across renders.
// page-editor.tsx lists it in the deps of the effect that reconnects a visible, disconnected editor, so an unstable
// resetIdle re-ran that effect on every status render and reconnected at the round trip's pace (42 attempts in 15 s),
// defeating the provider's backoff and the lost / try-later waits. The fix is in the hook (upstream-owned
// `hooks/use-idle.ts`, UPSTREAM_MODIFICATIONS), so the upstream page-editor that still lists resetIdle keeps working.
import { act, renderHook } from "@testing-library/react";
import { useEffect, useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useIdle } from "@/hooks/use-idle.ts";

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe("useIdle (#810)", () => {
  it("returns the same resetIdle on every render", () => {
    const { result, rerender } = renderHook(() =>
      useIdle(1_000, { initialState: false }),
    );
    const first = result.current.resetIdle;
    rerender();
    rerender();
    rerender();
    expect(result.current.resetIdle).toBe(first);
  });

  it("an effect that lists resetIdle runs once, not once per unrelated render (the page editor's status renders)", () => {
    let runs = 0;
    const { result } = renderHook(() => {
      const { isIdle, resetIdle } = useIdle(1_000, { initialState: false });
      const [status, setStatus] = useState(0);
      useEffect(() => {
        runs += 1;
      }, [isIdle, resetIdle]);
      return { setStatus, status };
    });
    expect(runs).toBe(1);
    for (let i = 1; i <= 20; i += 1) {
      act(() => result.current.setStatus(i));
    }
    expect(result.current.status).toBe(20);
    expect(runs).toBe(1);
  });

  it("still goes idle after the timeout and back on activity (the hook's behaviour is unchanged)", () => {
    const { result } = renderHook(() =>
      useIdle(1_000, { initialState: false }),
    );
    expect(result.current.isIdle).toBe(false);
    act(() => {
      vi.advanceTimersByTime(1_000);
    });
    expect(result.current.isIdle).toBe(true);
    act(() => {
      document.dispatchEvent(new Event("mousemove"));
    });
    expect(result.current.isIdle).toBe(false);
    act(() => {
      result.current.resetIdle();
      vi.advanceTimersByTime(999);
    });
    expect(result.current.isIdle).toBe(false);
    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(result.current.isIdle).toBe(true);
  });
});
