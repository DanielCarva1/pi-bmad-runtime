import { describe, expect, it } from "vitest";
import {
  FUTURE_ADAPTER_BOUNDARIES,
  REQUIRED_FUTURE_ADAPTERS,
  validateFutureAdapterBoundaries,
} from "../extensions/bmad-runtime/future-adapters.js";

describe("future adapter boundaries", () => {
  it("covers Codex, OpenCode and Claude Code as future feasibility targets", () => {
    expect(FUTURE_ADAPTER_BOUNDARIES.map((item) => item.id)).toEqual([...REQUIRED_FUTURE_ADAPTERS]);
    expect(FUTURE_ADAPTER_BOUNDARIES.map((item) => item.displayName)).toEqual(["Codex", "OpenCode", "Claude Code"]);
  });

  it("keeps every external adapter future-only and unsupported in v0.2", () => {
    expect(FUTURE_ADAPTER_BOUNDARIES.every((item) => item.supportLevel === "future-feasibility-only")).toBe(true);
    expect(FUTURE_ADAPTER_BOUNDARIES.every((item) => item.v02Supported === false)).toBe(true);
    expect(validateFutureAdapterBoundaries().filter((finding) => finding.severity === "blocked")).toEqual([]);
  });

  it("populates the required boundary fields for each future adapter", () => {
    for (const boundary of FUTURE_ADAPTER_BOUNDARIES) {
      expect(boundary.inputs.length).toBeGreaterThan(0);
      expect(boundary.outputs.length).toBeGreaterThan(0);
      expect(boundary.artifactPaths.length).toBeGreaterThan(0);
      expect(boundary.gateEvents.length).toBeGreaterThan(0);
      expect(boundary.minimumCommandCapabilities.length).toBeGreaterThan(0);
      expect(boundary.responsibilities.length).toBeGreaterThan(0);
      expect(boundary.limitations.length).toBeGreaterThan(0);
      expect(boundary.prototypeSmokeCriteria.length).toBeGreaterThan(0);
    }
  });

  it("preserves Pi-native P0 in every boundary", () => {
    for (const boundary of FUTURE_ADAPTER_BOUNDARIES) {
      expect(boundary.limitations.join("\n")).toContain("Pi-native P0");
      expect(boundary.prototypeSmokeCriteria.join("\n")).not.toContain("full support");
    }
  });
});
