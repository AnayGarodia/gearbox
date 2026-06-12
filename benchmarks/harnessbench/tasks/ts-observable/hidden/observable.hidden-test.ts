import { expect, test } from "bun:test";
import { Observable, Subscription } from "../src/observable";

test("teardown called on unsubscribe", () => {
  let tornDown = false;
  const obs = new Observable<number>((o) => {
    return () => { tornDown = true; };
  });
  const sub = obs.subscribe({ next: () => {} });
  sub.unsubscribe();
  expect(tornDown).toBe(true);
});

test("next not called after unsubscribe", () => {
  const values: number[] = [];
  let emit!: (v: number) => void;
  const obs = new Observable<number>((o) => {
    emit = (v) => o.next(v);
    return () => {};
  });
  const sub = obs.subscribe({ next: (v) => values.push(v) });
  emit(1);
  sub.unsubscribe();
  emit(2); // should be ignored
  expect(values).toEqual([1]);
});

test("teardown called on complete", () => {
  let tornDown = false;
  const obs = new Observable<number>((o) => {
    o.complete?.();
    return () => { tornDown = true; };
  });
  obs.subscribe({ next: () => {}, complete: () => {} });
  expect(tornDown).toBe(true);
});

test("teardown called on error", () => {
  let tornDown = false;
  const obs = new Observable<number>((o) => {
    o.error?.(new Error("boom"));
    return () => { tornDown = true; };
  });
  obs.subscribe({ next: () => {}, error: () => {} });
  expect(tornDown).toBe(true);
});

test("no callbacks after complete", () => {
  const values: number[] = [];
  let emit!: (v: number) => void;
  const obs = new Observable<number>((o) => {
    emit = (v) => o.next(v);
    return () => {};
  });
  obs.subscribe({
    next: (v) => values.push(v),
    complete: () => { emit(99); }, // attempt to emit inside complete — should be ignored
  });
  expect(values).not.toContain(99);
});
