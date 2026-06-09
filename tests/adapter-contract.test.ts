import { describe, expect, it } from "vitest";
import {
  BMAD_ADAPTER_CONTRACT,
  REQUIRED_ADAPTER_RESPONSIBILITIES,
  REQUIRED_CORE_RESPONSIBILITIES,
  classifyBmadResponsibility,
  validateBmadAdapterContract,
} from "../extensions/bmad-runtime/adapter-contract.js";

describe("BMAD core semantics vs Runtime/Agent Adapter contract", () => {
  it("lists the required BMAD core responsibilities", () => {
    const keys = BMAD_ADAPTER_CONTRACT.coreResponsibilities.map((item) => item.key);

    expect(keys).toEqual([...REQUIRED_CORE_RESPONSIBILITIES]);
    expect(BMAD_ADAPTER_CONTRACT.coreResponsibilities.map((item) => item.layer)).toEqual(
      REQUIRED_CORE_RESPONSIBILITIES.map(() => "core"),
    );
  });

  it("lists the required Runtime/Agent Adapter responsibilities", () => {
    const keys = BMAD_ADAPTER_CONTRACT.adapterResponsibilities.map((item) => item.key);

    expect(keys).toEqual([...REQUIRED_ADAPTER_RESPONSIBILITIES]);
    expect(BMAD_ADAPTER_CONTRACT.adapterResponsibilities.map((item) => item.layer)).toEqual(
      REQUIRED_ADAPTER_RESPONSIBILITIES.map(() => "runtime-agent-adapter"),
    );
  });

  it("keeps Pi and host API terms out of core semantics", () => {
    const coreText = BMAD_ADAPTER_CONTRACT.coreResponsibilities
      .map((item) => [item.label, item.summary, ...item.examples].join(" "))
      .join("\n");

    expect(coreText).not.toMatch(/\bpi\b/i);
    expect(coreText).not.toMatch(/\.pi\b/i);
    expect(coreText).not.toMatch(/\b(registerCommand|sendMessage|newSession|slash command)\b/i);
    expect(validateBmadAdapterContract().filter((finding) => finding.severity === "blocked")).toEqual([]);
  });

  it("classifies boundary responsibilities without making external adapters v0.2 scope", () => {
    expect(classifyBmadResponsibility("phase model and readiness gate")).toBe("core");
    expect(classifyBmadResponsibility("slash command, prompt and agent execution")).toBe("runtime-agent-adapter");
    expect(classifyBmadResponsibility("Codex adapter implementation")).toBe("out-of-scope");
    expect(classifyBmadResponsibility("separate automation command")).toBe("out-of-scope");
  });
});
