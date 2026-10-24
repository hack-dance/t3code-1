// @effect-diagnostics nodeBuiltinImport:off -- Action fingerprints use the same SHA-256 on fleet hosts.
import * as NodeCrypto from "node:crypto";
import type { OrchestrationV2RuntimeRequest } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

/** Bind a decision to the immutable native request, including the adapter's exact action. */
export function approvalActionDigest(request: OrchestrationV2RuntimeRequest): string {
  return actionDigest({
    requestId: request.id,
    nodeId: request.nodeId,
    providerTurnId: request.providerTurnId,
    nativeRequestRef: request.nativeRequestRef,
    kind: request.kind,
    createdAt: DateTime.formatIso(request.createdAt),
    action: request.action ?? null,
  });
}

export function actionDigest(action: unknown): string {
  return NodeCrypto.createHash("sha256").update(canonical(action)).digest("hex");
}
