import { test, expect } from "bun:test";
import {
  detailOpen,
  detailSetDeployments,
  detailSetAvailableModels,
  detailSetError,
  detailSetModelsError,
  detailStartRefresh,
  detailMoveIndex,
  detailStartDeploy,
  detailDeployFilter,
  detailDeployBackspace,
  detailDeployMove,
  detailPickCapacity,
  detailCapacityMove,
  detailConfirmCapacity,
  detailNameEdit,
  detailNameAdvance,
  detailIsNameComplete,
  detailSetSubmitting,
  detailStartDelete,
  detailIsDeleteComplete,
  detailOptimisticRemove,
  detailBack,
  detailSetArmReady,
  type AccountDetailPanel,
} from "../src/ui/panel.ts";
import type { AzureDeploymentInfo } from "../src/accounts/manage.ts";

const mkDep = (id: string): AzureDeploymentInfo => ({
  id, model: "gpt-4o", status: "succeeded", capacityType: "Standard",
});

const base = (): AccountDetailPanel =>
  detailOpen("acc-1", "Azure (my-resource)");

// ── Open ──────────────────────────────────────────────────────────────────────

test("detailSetArmReady records the ARM sign-in probe (undefined while probing)", () => {
  const p = base();
  expect(p.armReady).toBeUndefined(); // probing — no warning yet
  expect(detailSetArmReady(p, false).armReady).toBe(false); // browse footer shows the login hint
  expect(detailSetArmReady(p, true).armReady).toBe(true);
});

test("detailOpen: starts at browse phase, loading state", () => {
  const p = base();
  expect(p.kind).toBe("account-detail");
  expect(p.accountId).toBe("acc-1");
  expect(p.deployments).toBeNull();
  expect(p.availableModels).toBeNull();
  expect(p.submitting).toBe(false);
  expect(p.refreshing).toBe(false);
  expect(p.detailPhase.phase).toBe("browse");
});

// ── Data loading ──────────────────────────────────────────────────────────────

test("detailSetDeployments: stores deployments and clears error", () => {
  const p = detailSetDeployments(base(), [mkDep("d1"), mkDep("d2")]);
  expect(p.deployments).toHaveLength(2);
  expect(p.loadError).toBeUndefined();
});

test("detailSetAvailableModels: stores models", () => {
  const p = detailSetAvailableModels(base(), ["gpt-4o", "gpt-35-turbo"]);
  expect(p.availableModels).toEqual(["gpt-4o", "gpt-35-turbo"]);
});

test("detailSetError on the initial load: deployments stay null, loadError set", () => {
  const p = detailSetError(base(), "HTTP 401");
  expect(p.deployments).toBeNull();
  expect(p.loadError).toBe("HTTP 401");
});

test("detailSetError on a failed REFRESH: keeps the stale list visible", () => {
  const loaded = detailSetDeployments(base(), [mkDep("d1")]);
  const refreshing = detailStartRefresh(loaded);
  expect(refreshing.refreshing).toBe(true);
  expect(refreshing.deployments).toHaveLength(1); // list does NOT vanish during refresh
  const failed = detailSetError(refreshing, "HTTP 500");
  expect(failed.refreshing).toBe(false);
  expect(failed.deployments).toHaveLength(1); // stale data beats a blank screen
  expect(failed.loadError).toBe("HTTP 500");
});

test("detailSetDeployments clears refreshing; detailSetAvailableModels clears modelsError", () => {
  const p = detailSetDeployments(detailStartRefresh(detailSetDeployments(base(), [])), [mkDep("d1")]);
  expect(p.refreshing).toBe(false);
  const m = detailSetAvailableModels(detailSetModelsError(base(), "boom"), ["gpt-4o"]);
  expect(m.modelsError).toBeUndefined();
  expect(m.availableModels).toEqual(["gpt-4o"]);
});

test("detailSetModelsError records the failure so deploy can explain itself", () => {
  const p = detailSetModelsError(base(), "HTTP 403 insufficient role");
  expect(p.modelsError).toBe("HTTP 403 insufficient role");
  expect(p.availableModels).toBeNull(); // deploy stays disabled
});

// ── Browse navigation ─────────────────────────────────────────────────────────

test("detailMoveIndex: clamps into [0, count-1]", () => {
  const p = detailSetDeployments(base(), [mkDep("a"), mkDep("b"), mkDep("c")]);
  expect(detailMoveIndex(p, 1, 3).index).toBe(1);
  expect(detailMoveIndex(p, -1, 3).index).toBe(0); // clamp at 0
  expect(detailMoveIndex({ ...p, index: 2 }, 1, 3).index).toBe(2); // clamp at top
});

// ── Deploy flow ───────────────────────────────────────────────────────────────

test("detailStartDeploy: enters deploy-pick phase", () => {
  const p = detailSetAvailableModels(base(), ["gpt-4o"]);
  const d = detailStartDeploy(p);
  expect(d.detailPhase.phase).toBe("deploy-pick");
});

test("detailStartDeploy: no-op when availableModels is null", () => {
  const p = base(); // availableModels = null
  expect(detailStartDeploy(p).detailPhase.phase).toBe("browse");
});

test("detailDeployFilter/Backspace: filter and reset selection", () => {
  const p = detailSetAvailableModels(detailSetDeployments(base(), []), ["gpt-4o"]);
  const d1 = detailDeployFilter(detailStartDeploy(p), "gpt");
  expect((d1.detailPhase as any).filter).toBe("gpt");
  expect((d1.detailPhase as any).index).toBe(0);
  const d2 = detailDeployBackspace(d1);
  expect((d2.detailPhase as any).filter).toBe("gp");
});

test("detailDeployMove: moves selection in deploy-pick", () => {
  const p = detailStartDeploy(detailSetAvailableModels(base(), ["a", "b", "c"]));
  const moved = detailDeployMove(p, 2, 3);
  expect((moved.detailPhase as any).index).toBe(2);
});

test("detailPickCapacity: enters capacity-type phase with selected model", () => {
  const p = detailStartDeploy(detailSetAvailableModels(base(), ["gpt-4o"]));
  const c = detailPickCapacity(p, "gpt-4o");
  expect(c.detailPhase.phase).toBe("capacity-type");
  expect((c.detailPhase as any).selectedModel).toBe("gpt-4o");
  expect((c.detailPhase as any).index).toBe(0);
});

test("detailCapacityMove: clamps to 3 options", () => {
  const p = detailPickCapacity(detailStartDeploy(detailSetAvailableModels(base(), ["m"])), "m");
  expect(detailCapacityMove(p, 1).detailPhase).toMatchObject({ index: 1 });
  expect(detailCapacityMove(p, 5).detailPhase).toMatchObject({ index: 2 }); // clamped
});

test("detailConfirmCapacity: enters deploy-name phase", () => {
  const p = detailPickCapacity(detailStartDeploy(detailSetAvailableModels(base(), ["m"])), "m");
  const n = detailConfirmCapacity(p, "Standard");
  expect(n.detailPhase.phase).toBe("deploy-name");
  expect((n.detailPhase as any).capacityType).toBe("Standard");
  expect((n.detailPhase as any).fieldEdit.value).toBe("");
});

// ── Deploy name validation ────────────────────────────────────────────────────

function makeName(name: string): AccountDetailPanel {
  const p = detailConfirmCapacity(
    detailPickCapacity(detailStartDeploy(detailSetAvailableModels(base(), ["m"])), "m"),
    "Standard",
  );
  return detailNameEdit(p, { value: name, cursor: name.length });
}

test("detailIsNameComplete: accepts valid names", () => {
  expect(detailIsNameComplete(makeName("my-dep"))).toBe(true);
  expect(detailIsNameComplete(makeName("gpt4o"))).toBe(true);
  expect(detailIsNameComplete(makeName("ab"))).toBe(true); // 2-char min
});

test("detailIsNameComplete: rejects invalid names", () => {
  expect(detailIsNameComplete(makeName(""))).toBe(false);
  expect(detailIsNameComplete(makeName("-starts-with-hyphen"))).toBe(false);
  expect(detailIsNameComplete(makeName("ends-with-hyphen-"))).toBe(false);
});

test("detailNameAdvance: sets fieldError for invalid name", () => {
  const p = makeName("bad-");
  const next = detailNameAdvance(p);
  expect((next.detailPhase as any).fieldError).toBeTruthy();
});

test("detailNameAdvance: no transition on valid name (App checks detailIsNameComplete)", () => {
  const p = makeName("valid-dep");
  const next = detailNameAdvance(p);
  // No phase change — App reads detailIsNameComplete and triggers createDeployment.
  expect(next.detailPhase.phase).toBe("deploy-name");
  expect((next.detailPhase as any).fieldError).toBeNull();
});

// ── Delete flow ───────────────────────────────────────────────────────────────

test("detailStartDelete: enters confirm-delete phase", () => {
  const p = detailSetDeployments(base(), [mkDep("d1")]);
  const d = detailStartDelete(p, "d1");
  expect(d.detailPhase.phase).toBe("confirm-delete");
  expect((d.detailPhase as any).deploymentId).toBe("d1");
});

test("detailIsDeleteComplete: true only in confirm-delete phase", () => {
  const p = detailSetDeployments(base(), [mkDep("d1")]);
  expect(detailIsDeleteComplete(p)).toBe(false); // browse
  const d = detailStartDelete(p, "d1");
  expect(detailIsDeleteComplete(d)).toBe(true);
});

test("detailOptimisticRemove: filters deployment from the list", () => {
  const p = detailSetDeployments(base(), [mkDep("d1"), mkDep("d2")]);
  const r = detailOptimisticRemove(p, "d1");
  expect(r.deployments).toHaveLength(1);
  expect(r.deployments![0]!.id).toBe("d2");
});

test("detailOptimisticRemove: no-op when deployments is null", () => {
  const p = base(); // deployments = null
  const r = detailOptimisticRemove(p, "d1");
  expect(r.deployments).toBeNull();
});

// ── Submitting flag ───────────────────────────────────────────────────────────

test("detailSetSubmitting: toggles the in-flight flag", () => {
  expect(detailSetSubmitting(base(), true).submitting).toBe(true);
  expect(detailSetSubmitting(base(), false).submitting).toBe(false);
});

// ── Back navigation ───────────────────────────────────────────────────────────

test("detailBack: confirm-delete → browse", () => {
  const p = detailStartDelete(detailSetDeployments(base(), [mkDep("d1")]), "d1");
  expect(detailBack(p).detailPhase.phase).toBe("browse");
});

test("detailBack: deploy-name → capacity-type", () => {
  const p = makeName("my-dep");
  expect(detailBack(p).detailPhase.phase).toBe("capacity-type");
});

test("detailBack: capacity-type → deploy-pick", () => {
  const p = detailPickCapacity(detailStartDeploy(detailSetAvailableModels(base(), ["m"])), "m");
  expect(detailBack(p).detailPhase.phase).toBe("deploy-pick");
});

test("detailBack: deploy-pick → browse", () => {
  const p = detailStartDeploy(detailSetAvailableModels(base(), ["m"]));
  expect(detailBack(p).detailPhase.phase).toBe("browse");
});

test("detailBack: browse → no-op (App closes panel)", () => {
  const p = base();
  expect(detailBack(p).detailPhase.phase).toBe("browse"); // unchanged
});

// ── Shared panel helpers ──────────────────────────────────────────────────────

import { truncate, fieldWindow } from "../src/ui/panel.ts";

test("truncate: one rule, one glyph", () => {
  expect(truncate("short", 10)).toBe("short");
  expect(truncate("exactly-ten", 11)).toBe("exactly-ten");
  expect(truncate("a-very-long-deployment-name", 10)).toBe("a-very-lo…");
  expect(truncate("a-very-long-deployment-name", 10).length).toBe(10); // never exceeds n
});

test("fieldWindow: short value shows whole string, caret at end", () => {
  const w = fieldWindow("abc", 3, 20);
  expect(w.pre).toBe("abc");
  expect(w.at).toBe(" "); // caret past the end renders as an inverse space
  expect(w.post).toBe("");
});

test("fieldWindow: long value slides so the caret stays visible", () => {
  const long = "a".repeat(50) + "XYZ"; // 53 chars
  const atEnd = fieldWindow(long, 53, 20);
  expect((atEnd.pre + atEnd.at + atEnd.post).length).toBeLessThanOrEqual(20);
  expect(atEnd.pre.endsWith("XYZ")).toBe(true); // the tail (with the caret) is in view

  const atStart = fieldWindow(long, 0, 20);
  expect(atStart.at).toBe("a"); // caret char visible at the window head
  expect(atStart.pre).toBe("");
});

test("fieldWindow: mid-string caret is inside the window", () => {
  const v = "0123456789".repeat(5); // 50 chars
  const w = fieldWindow(v, 25, 16);
  const visible = w.pre + w.at + w.post;
  expect(visible.length).toBeLessThanOrEqual(16);
  expect(w.at).toBe(v[25]!);
});
