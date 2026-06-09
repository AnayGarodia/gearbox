import { test, expect } from "bun:test";
import {
  detailOpen,
  detailSetDeployments,
  detailSetAvailableModels,
  detailSetError,
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
  type AccountDetailPanel,
} from "../src/ui/panel.ts";
import type { AzureDeploymentInfo } from "../src/accounts/manage.ts";

const mkDep = (id: string): AzureDeploymentInfo => ({
  id, model: "gpt-4o", status: "succeeded", capacityType: "Standard",
});

const base = (): AccountDetailPanel =>
  detailOpen("acc-1", "Azure (my-resource)");

// ── Open ──────────────────────────────────────────────────────────────────────

test("detailOpen: starts at browse phase, loading state", () => {
  const p = base();
  expect(p.kind).toBe("account-detail");
  expect(p.accountId).toBe("acc-1");
  expect(p.deployments).toBeNull();
  expect(p.availableModels).toBeNull();
  expect(p.submitting).toBe(false);
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

test("detailSetError: clears deployments, sets loadError", () => {
  const p = detailSetError(base(), "HTTP 401");
  expect(p.deployments).toBeNull();
  expect(p.loadError).toBe("HTTP 401");
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
