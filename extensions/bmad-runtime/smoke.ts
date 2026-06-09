export const REQUIRED_RESOLUTION_WORKSPACE_SMOKE_SCENARIOS = [
  "same-cwd",
  "different-cwd-block",
  "moved-workspace-rebind",
  "ambiguous-project-picker",
  "generic-git-intent",
  "local-only-workspace",
] as const;

export type ResolutionWorkspaceSmokeScenario =
  typeof REQUIRED_RESOLUTION_WORKSPACE_SMOKE_SCENARIOS[number];

export interface ResolutionWorkspaceSmokeResult {
  scenario: ResolutionWorkspaceSmokeScenario;
  expectedResult: string;
  confidenceClass: string;
  evidenceUsed: string[];
  duplicateCreationPrevented: boolean;
  writeOccurred: boolean;
  projectCountBefore: number;
  projectCountAfter: number;
  recoveryAction?: string;
}

export interface ResolutionWorkspaceSmokeValidation {
  ok: boolean;
  missingScenarios: ResolutionWorkspaceSmokeScenario[];
  failures: string[];
  scenarioCount: number;
}

export interface ExpansiveSearchGuardEvidence {
  explicitIntentRequired: true;
  explicitIntentProvided: boolean;
  blocked: boolean;
  root: string;
  maxDepth: number;
  bounds: string[];
  reason: string;
  writeOccurred: false;
}

export interface ExpansiveSearchGuardValidation {
  ok: boolean;
  failures: string[];
}

function nonEmpty(value: string | undefined): boolean {
  return !!value && value.trim().length > 0;
}

export function validateResolutionWorkspaceSmokeResults(
  results: ResolutionWorkspaceSmokeResult[],
): ResolutionWorkspaceSmokeValidation {
  const byScenario = new Map(results.map((result) => [result.scenario, result]));
  const missingScenarios = REQUIRED_RESOLUTION_WORKSPACE_SMOKE_SCENARIOS.filter((scenario) => !byScenario.has(scenario));
  const failures: string[] = [];
  const seenScenarios = new Set<ResolutionWorkspaceSmokeScenario>();

  for (const result of results) {
    if (seenScenarios.has(result.scenario)) failures.push(`${result.scenario}: duplicate scenario result`);
    seenScenarios.add(result.scenario);
    if (!nonEmpty(result.expectedResult)) failures.push(`${result.scenario}: expectedResult is required`);
    if (!nonEmpty(result.confidenceClass)) failures.push(`${result.scenario}: confidenceClass is required`);
    if (result.evidenceUsed.length === 0) failures.push(`${result.scenario}: evidenceUsed is required`);
    if (!result.duplicateCreationPrevented) failures.push(`${result.scenario}: duplicate creation was not prevented`);
    if (result.projectCountAfter < result.projectCountBefore) failures.push(`${result.scenario}: project count decreased unexpectedly`);
  }

  return {
    ok: missingScenarios.length === 0 && failures.length === 0,
    missingScenarios,
    failures,
    scenarioCount: results.length,
  };
}

export function buildExpansiveSearchGuardEvidence(input: {
  explicitIntentProvided: boolean;
  root: string;
  maxDepth: number;
  bounds: string[];
  reason: string;
}): ExpansiveSearchGuardEvidence {
  return {
    explicitIntentRequired: true,
    explicitIntentProvided: input.explicitIntentProvided,
    blocked: !input.explicitIntentProvided,
    root: input.root,
    maxDepth: input.maxDepth,
    bounds: input.bounds,
    reason: input.reason,
    writeOccurred: false,
  };
}

export function validateExpansiveSearchGuardEvidence(
  guard: ExpansiveSearchGuardEvidence,
): ExpansiveSearchGuardValidation {
  const failures: string[] = [];
  if (!guard.explicitIntentRequired) failures.push("explicit intent must be required");
  if (!guard.blocked && !guard.explicitIntentProvided) failures.push("search must block when explicit intent is absent");
  if (!nonEmpty(guard.root)) failures.push("root is required");
  if (!Number.isInteger(guard.maxDepth) || guard.maxDepth < 0) failures.push("maxDepth must be a non-negative integer");
  if (guard.bounds.length === 0 || guard.bounds.some((bound) => !nonEmpty(bound))) failures.push("bounds are required");
  if (!nonEmpty(guard.reason)) failures.push("reason is required");
  if (guard.writeOccurred !== false) failures.push("expansive search guard must be read-only");
  return { ok: failures.length === 0, failures };
}

export function formatResolutionWorkspaceSmokeReport(
  results: ResolutionWorkspaceSmokeResult[],
  guard?: ExpansiveSearchGuardEvidence,
): string {
  const validation = validateResolutionWorkspaceSmokeResults(results);
  const lines = [
    `Smoke suite: ${validation.ok ? "pass" : "fail"}`,
    `Scenario count: ${validation.scenarioCount}`,
    `Missing scenarios: ${validation.missingScenarios.length > 0 ? validation.missingScenarios.join(", ") : "none"}`,
  ];
  for (const result of results) {
    lines.push(
      "",
      `## ${result.scenario}`,
      `Expected result: ${result.expectedResult}`,
      `Confidence class: ${result.confidenceClass}`,
      `Evidence used: ${result.evidenceUsed.join("; ")}`,
      `Duplicate creation prevented: ${result.duplicateCreationPrevented ? "yes" : "no"}`,
      `Write occurred: ${result.writeOccurred ? "true" : "false"}`,
      `Project count: ${result.projectCountBefore} -> ${result.projectCountAfter}`,
    );
    if (result.recoveryAction) lines.push(`Recovery action: ${result.recoveryAction}`);
  }
  if (guard) {
    lines.push(
      "",
      "## expansive-search-guard",
      `Explicit intent required: ${guard.explicitIntentRequired ? "yes" : "no"}`,
      `Explicit intent provided: ${guard.explicitIntentProvided ? "yes" : "no"}`,
      `Blocked: ${guard.blocked ? "yes" : "no"}`,
      `Root: ${guard.root}`,
      `Max depth: ${guard.maxDepth}`,
      `Bounds: ${guard.bounds.join(", ")}`,
      `Reason: ${guard.reason}`,
      "Write occurred: false",
    );
  }
  if (validation.failures.length > 0) lines.push("", "Failures:", ...validation.failures.map((failure) => `- ${failure}`));
  return lines.join("\n");
}

export const REQUIRED_SAFETY_GATE_SMOKE_SCENARIOS = [
  "boundary-write-block",
  "ambiguous-identity-write-block",
  "phase3-readiness-gate",
  "phase4-completion-gate",
  "diff-approval-policy",
] as const;

export type SafetyGateSmokeScenario =
  typeof REQUIRED_SAFETY_GATE_SMOKE_SCENARIOS[number];

export interface SafetyGateSmokeResult {
  scenario: SafetyGateSmokeScenario;
  expectedResult: string;
  evidenceUsed: string[];
  blocked: boolean;
  writeOccurred: boolean;
  artifactPath?: string;
  checkResult?: "pass" | "fail" | "blocked";
  validationResult?: "pass" | "fail" | "blocked";
  reviewOutcome?: string;
  gateOutcome?: string;
  timestamp?: string;
  stateUpdatePersisted?: boolean;
  diffApprovalMode?: string;
  blockerBeforeLoop?: boolean;
}

export interface SafetyGateSmokeValidation {
  ok: boolean;
  missingScenarios: SafetyGateSmokeScenario[];
  failures: string[];
  scenarioCount: number;
}

function hasDuplicateSafetyScenario(results: SafetyGateSmokeResult[], scenario: SafetyGateSmokeScenario): boolean {
  return results.filter((result) => result.scenario === scenario).length > 1;
}

function isTimestamp(value: string | undefined): boolean {
  return !!value && !Number.isNaN(Date.parse(value));
}

export function validateSafetyGateSmokeResults(
  results: SafetyGateSmokeResult[],
): SafetyGateSmokeValidation {
  const byScenario = new Map(results.map((result) => [result.scenario, result]));
  const missingScenarios = REQUIRED_SAFETY_GATE_SMOKE_SCENARIOS.filter((scenario) => !byScenario.has(scenario));
  const failures: string[] = [];

  for (const scenario of REQUIRED_SAFETY_GATE_SMOKE_SCENARIOS) {
    if (hasDuplicateSafetyScenario(results, scenario)) failures.push(`${scenario}: duplicate scenario result`);
  }

  for (const result of results) {
    if (!nonEmpty(result.expectedResult)) failures.push(`${result.scenario}: expectedResult is required`);
    if (result.evidenceUsed.length === 0) failures.push(`${result.scenario}: evidenceUsed is required`);

    if (result.scenario === "boundary-write-block" || result.scenario === "ambiguous-identity-write-block") {
      if (!result.blocked) failures.push(`${result.scenario}: expected blocked safety outcome`);
      if (result.writeOccurred) failures.push(`${result.scenario}: safety block must be read-only`);
    }

    if (result.scenario === "phase3-readiness-gate" || result.scenario === "phase4-completion-gate") {
      if (!nonEmpty(result.artifactPath)) failures.push(`${result.scenario}: artifact path is required`);
      if (!result.validationResult) failures.push(`${result.scenario}: validation result is required`);
      if (!result.gateOutcome) failures.push(`${result.scenario}: gate outcome is required`);
      if (!isTimestamp(result.timestamp)) failures.push(`${result.scenario}: timestamp is required`);
      if (!result.stateUpdatePersisted) failures.push(`${result.scenario}: persisted state update evidence is required`);
    }

    if (result.scenario === "phase4-completion-gate") {
      if (!result.checkResult) failures.push("phase4-completion-gate: check result is required");
      if (!result.reviewOutcome) failures.push("phase4-completion-gate: review outcome is required");
    }

    if (result.scenario === "diff-approval-policy") {
      if (!result.diffApprovalMode) failures.push("diff-approval-policy: diff approval mode is required");
      if (result.blocked && !result.blockerBeforeLoop) failures.push("diff-approval-policy: blocker must be reported before automation loop");
      if (result.writeOccurred) failures.push("diff-approval-policy: diff approval smoke must be read-only");
    }
  }

  return {
    ok: missingScenarios.length === 0 && failures.length === 0,
    missingScenarios,
    failures,
    scenarioCount: results.length,
  };
}

export function formatSafetyGateSmokeReport(results: SafetyGateSmokeResult[]): string {
  const validation = validateSafetyGateSmokeResults(results);
  const lines = [
    `Safety smoke suite: ${validation.ok ? "pass" : "fail"}`,
    `Scenario count: ${validation.scenarioCount}`,
    `Missing scenarios: ${validation.missingScenarios.length > 0 ? validation.missingScenarios.join(", ") : "none"}`,
  ];
  for (const result of results) {
    lines.push(
      "",
      `## ${result.scenario}`,
      `Expected result: ${result.expectedResult}`,
      `Blocked: ${result.blocked ? "yes" : "no"}`,
      `Write occurred: ${result.writeOccurred ? "true" : "false"}`,
      `Evidence used: ${result.evidenceUsed.join("; ")}`,
    );
    if (result.artifactPath) lines.push(`Artifact path: ${result.artifactPath}`);
    if (result.checkResult) lines.push(`Check result: ${result.checkResult}`);
    if (result.validationResult) lines.push(`Validation result: ${result.validationResult}`);
    if (result.reviewOutcome) lines.push(`Review outcome: ${result.reviewOutcome}`);
    if (result.gateOutcome) lines.push(`Gate outcome: ${result.gateOutcome}`);
    if (result.timestamp) lines.push(`Timestamp: ${result.timestamp}`);
    if (result.stateUpdatePersisted !== undefined) lines.push(`State update persisted: ${result.stateUpdatePersisted ? "yes" : "no"}`);
    if (result.diffApprovalMode) lines.push(`Diff approval mode: ${result.diffApprovalMode}`);
    if (result.blockerBeforeLoop !== undefined) lines.push(`Blocker before loop: ${result.blockerBeforeLoop ? "yes" : "no"}`);
  }
  if (validation.failures.length > 0) lines.push("", "Failures:", ...validation.failures.map((failure) => `- ${failure}`));
  return lines.join("\n");
}
