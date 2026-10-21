import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TimerGroup } from "./timers";

describe("TimerGroup", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("fires after the time has passed", () => {
    const g = new TimerGroup();
    const fn = vi.fn();
    g.add(1000, fn);
    vi.advanceTimersByTime(999);
    expect(fn).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("does not count the time spent while held", () => {
    const g = new TimerGroup();
    const fn = vi.fn();
    g.add(1000, fn);
    vi.advanceTimersByTime(600);
    const release = g.hold();
    vi.advanceTimersByTime(60_000);
    expect(fn).not.toHaveBeenCalled();
    release();
    vi.advanceTimersByTime(399);
    expect(fn).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("holds nest and a timer added during a hold starts when it ends", () => {
    const g = new TimerGroup();
    const fn = vi.fn();
    const a = g.hold();
    const b = g.hold();
    g.add(100, fn);
    vi.advanceTimersByTime(10_000);
    a();
    vi.advanceTimersByTime(10_000);
    expect(fn).not.toHaveBeenCalled();
    b();
    b(); // releasing twice does nothing
    vi.advanceTimersByTime(100);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("can be cancelled and cleared", () => {
    const g = new TimerGroup();
    const x = vi.fn();
    const y = vi.fn();
    g.add(10, x)();
    g.add(10, y);
    g.clear();
    vi.advanceTimersByTime(100);
    expect(x).not.toHaveBeenCalled();
    expect(y).not.toHaveBeenCalled();
  });
});
