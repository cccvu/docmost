import { describe, it, expect } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useIsTruncated } from "./use-is-truncated";

function attach(
  result: { current: ReturnType<typeof useIsTruncated<HTMLSpanElement>> },
  scrollWidth: number,
  clientWidth: number,
) {
  const el = document.createElement("span");
  Object.defineProperty(el, "scrollWidth", { value: scrollWidth, configurable: true });
  Object.defineProperty(el, "clientWidth", { value: clientWidth, configurable: true });
  // The consumer assigns this ref to its element; emulate that here.
  (result.current.ref as { current: HTMLSpanElement | null }).current = el;
}

describe("useIsTruncated", () => {
  it("starts not-truncated (no measurement yet)", () => {
    const { result } = renderHook(() => useIsTruncated<HTMLSpanElement>());
    expect(result.current.isTruncated).toBe(false);
  });

  it("is truncated only when scrollWidth exceeds clientWidth", () => {
    const { result } = renderHook(() => useIsTruncated<HTMLSpanElement>());
    attach(result, 200, 100);
    act(() => result.current.measure());
    expect(result.current.isTruncated).toBe(true);
  });

  it("is not truncated when the content fits (scrollWidth <= clientWidth)", () => {
    const { result } = renderHook(() => useIsTruncated<HTMLSpanElement>());
    attach(result, 80, 100);
    act(() => result.current.measure());
    expect(result.current.isTruncated).toBe(false);

    // equal widths (fits exactly) must not be treated as truncated
    attach(result, 100, 100);
    act(() => result.current.measure());
    expect(result.current.isTruncated).toBe(false);
  });

  it("measuring with no element attached is a no-op", () => {
    const { result } = renderHook(() => useIsTruncated<HTMLSpanElement>());
    act(() => result.current.measure());
    expect(result.current.isTruncated).toBe(false);
  });
});
