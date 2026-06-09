import * as fs from "node:fs";
import * as path from "node:path";
import { scanArtifactRegistry } from "./artifacts.js";
import { evaluateDiffApprovalPolicy, formatDiffApprovalPolicy, type DiffApprovalPolicy } from "./diff-approval.js";
import type { BmadPathConfig } from "./paths.js";
import { toProjectRelative } from "./paths.js";
import { classifyPhase4FailureFromStory } from "./phase4.js";
import { evaluateReadinessGate } from "./readiness.js";
import { findFirstStoryWithStatus, validateSprintDocument, type SprintStatusDocument, type SprintStatusEntry } from "./sprint.js";
import type { Phase4FailurePolicy } from "./state.js";

export type Phase4AutomationAction = "create-story" | "dev-story" | "code-review" | "retry" | "complete" | "blocked";

export interface Phase4AutomationRecommendation {
  action: Phase4AutomationAction;
  skill?: string;
  story?: SprintStatusEntry;
  storyContext?: Phase4StoryExecutionContext;
  reason: string;
  prompt?: string;
  requiredChecks?: string[];
  evidenceRequirements?: string[];
  blockers?: string[];
  diffApproval?: DiffApprovalPolicy;
}

export interface Phase4AutomationExecutionPlan {
  recommendation: Phase4AutomationRecommendation;
  loopSteps: string[];
  stopConditions: string[];
  stateUpdates: string[];
  prompt: string;
}

export interface Phase4AutomationContext {
  readinessMayStart?: boolean;
  readinessDecision?: string;
  diffApproval?: DiffApprovalPolicy;
}

export interface Phase4StoryExecutionContext {
  storyKey: string;
  storyPath?: string;
  allowedPaths: string[];
  dependencies: string[];
  dependencyBlockers: string[];
  failurePolicy: Phase4FailurePolicy;
}

function storyPrompt(skill: string, story?: SprintStatusEntry, context?: Phase4StoryExecutionContext): string {
  const storyText = story ? `\n\nTarget story key: ${story.key}` : "";
  const paths = context?.allowedPaths.length ? `\nAllowed paths:\n${context.allowedPaths.map((item) => `- ${item}`).join("\n")}` : "";
  const deps = context?.dependencies.length ? `\nDependencies:\n${context.dependencies.map((item) => `- ${item}`).join("\n")}` : "";
  return `/skill:${skill}${storyText}${paths}${deps}\n\nBMAD Runtime selected the next automatic Phase 4 workflow. Execute the workflow to its completion or halt condition, then return control to BMAD Runtime.`;
}

function checksFor(action: Phase4AutomationAction): string[] {
  if (action === "complete" || action === "blocked") return [];
  return ["npm run typecheck", "npm test", "npm pack --dry-run or npm run smoke when package shape/release behavior changed"];
}

function evidenceFor(action: Phase4AutomationAction): string[] {
  if (action === "complete" || action === "blocked") return [];
  return ["story file Dev Agent Record", "changed file list", "test/check output", "parallel code review evidence", "sprint-status.yaml transition", "runtime state/work-ledger evidence entry"];
}

function attachDiffApprovalEvidence(rec: Phase4AutomationRecommendation, diffApproval: DiffApprovalPolicy | undefined): Phase4AutomationRecommendation {
  if (!diffApproval) return rec;
  if (rec.action === "blocked") return { ...rec, diffApproval };
  const evidence = diffApproval.evidence.map((item) => `diff approval policy: ${item}`);
  return {
    ...rec,
    diffApproval,
    evidenceRequirements: [...(rec.evidenceRequirements ?? []), ...evidence],
  };
}

function readStoryText(cfg: BmadPathConfig, storyKey: string): { text: string; relPath?: string } {
  const file = path.join(cfg.implementation_artifacts, `${storyKey}.md`);
  if (!fs.existsSync(file)) return { text: "" };
  try {
    return { text: fs.readFileSync(file, "utf8"), relPath: toProjectRelative(cfg.projectRoot, file) };
  } catch {
    return { text: "" };
  }
}

function sectionBody(text: string, headingPattern: RegExp): string {
  const lines = text.split(/\r?\n/);
  const start = lines.findIndex((line) => headingPattern.test(line));
  if (start === -1) return "";
  const level = lines[start]?.match(/^(#+)\s/)?.[1]?.length ?? 2;
  const body: string[] = [];
  for (let index = start + 1; index < lines.length; index++) {
    const line = lines[index] ?? "";
    const heading = line.match(/^(#+)\s/);
    if (heading?.[1] && heading[1].length <= level) break;
    body.push(line);
  }
  return body.join("\n");
}

function cleanListLine(line: string): string {
  return line
    .trim()
    .replace(/^[-*]\s*/, "")
    .replace(/^`|`$/g, "")
    .replace(/^["']|["']$/g, "")
    .trim();
}

function listItems(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map(cleanListLine)
    .filter((line) => line.length > 0 && !line.startsWith("#"));
}

function pathLike(value: string): boolean {
  return /^(?:\.\.\/|\.\/|[A-Za-z0-9_.-]+\/|[A-Za-z]:\\|_[A-Za-z0-9_-]+\/)/.test(value);
}

function extractAllowedPaths(text: string, storyRelPath: string | undefined, cfg: BmadPathConfig): string[] {
  const sections = [
    sectionBody(text, /^##+\s+Allowed Paths\s*$/i),
    sectionBody(text, /^##+\s+Dev Notes\s*$/i),
    sectionBody(text, /^###+\s+Owner, allowed paths/i),
  ].filter(Boolean);
  const paths = new Set<string>();
  for (const section of sections) {
    for (const item of listItems(section)) {
      const normalized = item.replace(/^Allowed paths(?: principais)?:\s*/i, "").trim();
      const codeMatches = [...normalized.matchAll(/`([^`]+)`/g)].map((match) => match[1] ?? "");
      for (const candidate of codeMatches.length ? codeMatches : [normalized]) {
        if (pathLike(candidate)) paths.add(candidate);
      }
    }
  }
  if (storyRelPath) paths.add(storyRelPath);
  paths.add(toProjectRelative(cfg.projectRoot, path.join(cfg.implementation_artifacts, "sprint-status.yaml")));
  paths.add(toProjectRelative(cfg.projectRoot, path.join(cfg.output_folder, "evidence")));
  return [...paths].slice(0, 40);
}

function normalizeDependency(value: string): string | undefined {
  const clean = value.replace(/^Story\s+/i, "").trim();
  const dotted = clean.match(/^(\d+)\.(\d+)\b/);
  if (dotted?.[1] && dotted?.[2]) return `${dotted[1]}-${dotted[2]}-`;
  const keyed = clean.match(/^(\d+-\d+-[A-Za-z0-9_.-]+)/);
  return keyed?.[1] ?? undefined;
}

function extractDependencies(text: string): string[] {
  const sections = [
    sectionBody(text, /^##+\s+Dependencies\s*$/i),
    sectionBody(text, /^##+\s+Depend[eê]ncias\s*$/i),
    sectionBody(text, /^###+\s+Requirements traceability/i),
  ].filter(Boolean);
  const dependencies = new Set<string>();
  for (const section of sections) {
    for (const item of listItems(section)) {
      const dep = normalizeDependency(item);
      if (dep) dependencies.add(dep);
    }
  }
  for (const line of text.split(/\r?\n/)) {
    if (!/Depend[eê]ncias?|Dependencies/i.test(line)) continue;
    const dep = normalizeDependency(line.replace(/^.*?:\s*/, ""));
    if (dep) dependencies.add(dep);
  }
  return [...dependencies].slice(0, 20);
}

function dependencyBlockers(doc: SprintStatusDocument, dependencies: string[]): string[] {
  const blockers: string[] = [];
  for (const dependency of dependencies) {
    const entry = doc.entries.find((item) => item.kind === "story" && (item.key === dependency || (dependency.endsWith("-") && item.key.startsWith(dependency))));
    if (!entry) blockers.push(`Dependency ${dependency} is not listed in sprint-status.yaml.`);
    else if (entry.status !== "done") blockers.push(`Dependency ${entry.key} is ${entry.status}, not done.`);
  }
  return blockers;
}

function buildStoryExecutionContext(entry: SprintStatusEntry, cfg: BmadPathConfig, doc: SprintStatusDocument): Phase4StoryExecutionContext {
  const story = readStoryText(cfg, entry.key);
  const dependencies = extractDependencies(story.text);
  return {
    storyKey: entry.key,
    storyPath: story.relPath,
    allowedPaths: extractAllowedPaths(story.text, story.relPath, cfg),
    dependencies,
    dependencyBlockers: dependencyBlockers(doc, dependencies),
    failurePolicy: classifyPhase4FailureFromStory(entry.status, story.text),
  };
}

function firstEligibleStoryWithStatus(doc: SprintStatusDocument, cfg: BmadPathConfig, status: "review" | "in-progress" | "ready-for-dev" | "backlog"): { entry?: SprintStatusEntry; context?: Phase4StoryExecutionContext; blockers: string[] } {
  const entries = doc.entries.filter((entry) => entry.kind === "story" && entry.status === status);
  const blockers: string[] = [];
  for (const entry of entries) {
    const context = buildStoryExecutionContext(entry, cfg, doc);
    if (context.dependencyBlockers.length === 0) return { entry, context, blockers };
    blockers.push(...context.dependencyBlockers.map((blocker) => `${entry.key}: ${blocker}`));
  }
  return { blockers };
}

export function buildPhase4AutomationContext(cwd: string, cfg: BmadPathConfig): Phase4AutomationContext {
  const readiness = evaluateReadinessGate(cfg, scanArtifactRegistry(cfg));
  return {
    readinessMayStart: readiness.implementationMayStart,
    readinessDecision: readiness.decision,
    diffApproval: evaluateDiffApprovalPolicy(cwd),
  };
}

export function recommendPhase4Automation(doc: SprintStatusDocument | undefined, cfg: BmadPathConfig, context: Phase4AutomationContext = {}): Phase4AutomationRecommendation {
  const finish = (rec: Phase4AutomationRecommendation) => attachDiffApprovalEvidence(rec, context.diffApproval);
  if (!doc) return finish({ action: "blocked", reason: `Sprint status not found at ${cfg.implementation_artifacts}/sprint-status.yaml. Run bmad-sprint-planning first.` });
  if (context.readinessMayStart === false) return finish({ action: "blocked", reason: `Phase 4 automation blocked by readiness decision ${context.readinessDecision ?? "unknown"}.`, blockers: ["readiness pass or scoped waiver is required before story implementation"] });
  if (context.diffApproval?.blocking) {
    return finish({
      action: "blocked",
      reason: `Phase 4 automation blocked by diff approval policy ${context.diffApproval.mode}.`,
      blockers: context.diffApproval.blockers,
    });
  }
  const sprintErrors = validateSprintDocument(doc).filter((issue) => issue.severity === "error");
  if (sprintErrors.length > 0) return finish({ action: "blocked", reason: "Sprint status has validation errors.", blockers: sprintErrors.slice(0, 5).map((issue) => issue.message) });

  const review = firstEligibleStoryWithStatus(doc, cfg, "review");
  if (review.entry) {
    if (review.context?.failurePolicy.classification === "retryable") {
      return finish({ action: "retry", skill: "bmad-dev-story", story: review.entry, storyContext: review.context, reason: "First eligible story has retryable review/check/evidence failure; reopen work before completion.", prompt: storyPrompt("bmad-dev-story", review.entry, review.context), requiredChecks: checksFor("retry"), evidenceRequirements: evidenceFor("retry"), blockers: review.context.failurePolicy.reasons });
    }
    if (review.context && review.context.failurePolicy.classification !== "none") {
      return finish({ action: "blocked", reason: `Story in review requires ${review.context.failurePolicy.classification} handling before completion.`, story: review.entry, storyContext: review.context, blockers: review.context.failurePolicy.reasons });
    }
    return finish({ action: "code-review", skill: "bmad-code-review", story: review.entry, storyContext: review.context, reason: "First eligible story in review requires code review before completion.", prompt: storyPrompt("bmad-code-review", review.entry, review.context), requiredChecks: checksFor("code-review"), evidenceRequirements: evidenceFor("code-review") });
  }
  if (review.blockers.length > 0) return finish({ action: "blocked", reason: "A story in review is blocked by dependencies.", blockers: review.blockers.slice(0, 12) });
  const inProgress = firstEligibleStoryWithStatus(doc, cfg, "in-progress");
  if (inProgress.entry) {
    if (inProgress.context?.failurePolicy.classification === "retryable") {
      return finish({ action: "retry", skill: "bmad-dev-story", story: inProgress.entry, storyContext: inProgress.context, reason: "First eligible in-progress story has retryable failure; continue patch/check/review loop.", prompt: storyPrompt("bmad-dev-story", inProgress.entry, inProgress.context), requiredChecks: checksFor("retry"), evidenceRequirements: evidenceFor("retry"), blockers: inProgress.context.failurePolicy.reasons });
    }
    if (inProgress.context && inProgress.context.failurePolicy.classification !== "none") {
      return finish({ action: "blocked", reason: `In-progress story requires ${inProgress.context.failurePolicy.classification} handling before automation can continue.`, story: inProgress.entry, storyContext: inProgress.context, blockers: inProgress.context.failurePolicy.reasons });
    }
    return finish({ action: "dev-story", skill: "bmad-dev-story", story: inProgress.entry, storyContext: inProgress.context, reason: "First eligible in-progress story should resume development.", prompt: storyPrompt("bmad-dev-story", inProgress.entry, inProgress.context), requiredChecks: checksFor("dev-story"), evidenceRequirements: evidenceFor("dev-story") });
  }
  if (inProgress.blockers.length > 0) return finish({ action: "blocked", reason: "An in-progress story is blocked by dependencies.", blockers: inProgress.blockers.slice(0, 12) });
  const ready = firstEligibleStoryWithStatus(doc, cfg, "ready-for-dev");
  if (ready.entry) return finish({ action: "dev-story", skill: "bmad-dev-story", story: ready.entry, storyContext: ready.context, reason: "First eligible ready story should be implemented.", prompt: storyPrompt("bmad-dev-story", ready.entry, ready.context), requiredChecks: checksFor("dev-story"), evidenceRequirements: evidenceFor("dev-story") });
  if (ready.blockers.length > 0) return finish({ action: "blocked", reason: "No ready story can start until dependencies are done.", blockers: ready.blockers.slice(0, 12) });
  const backlog = firstEligibleStoryWithStatus(doc, cfg, "backlog");
  if (backlog.entry) return finish({ action: "create-story", skill: "bmad-create-story", story: backlog.entry, storyContext: backlog.context, reason: "No active eligible story exists; create the next backlog story context before development.", prompt: storyPrompt("bmad-create-story", backlog.entry, backlog.context), requiredChecks: checksFor("create-story"), evidenceRequirements: evidenceFor("create-story") });
  const dependencyBlockers = [...review.blockers, ...inProgress.blockers, ...ready.blockers, ...backlog.blockers];
  if (dependencyBlockers.length > 0) return finish({ action: "blocked", reason: "No eligible story can start until dependencies are done.", blockers: dependencyBlockers.slice(0, 12) });
  return finish({ action: "complete", reason: "All non-retrospective sprint stories are done or no planned stories remain." });
}

export function buildPhase4AutomationExecutionPlan(rec: Phase4AutomationRecommendation): Phase4AutomationExecutionPlan {
  const story = rec.story?.key ?? "no-story";
  const context = rec.storyContext;
  const blockers = [...(rec.blockers ?? []), ...(context?.dependencyBlockers ?? [])];
  const loopSteps = rec.action === "create-story"
    ? ["Create the story file from canonical epics with concrete ACs", "Run dev-story implementation", "Run local checks", "Run parallel code review roles", "Patch or stop on findings", "Record evidence and update sprint/state/ledger"]
    : rec.action === "dev-story"
      ? ["Resume or start dev-story", "Implement scoped changes", "Run local checks", "Move to review", "Run parallel code review roles", "Patch or stop on findings", "Record evidence and update sprint/state/ledger"]
      : rec.action === "retry"
        ? ["Keep the story active or reopen it from false done", "Patch retryable check/review/evidence failures", "Increment or preserve retry evidence", "Rerun local checks", "Rerun code review", "Only mark done if failure policy clears and evidence is recorded"]
        : rec.action === "code-review"
          ? ["Run Blind Hunter, Edge Case Hunter, and Acceptance Auditor with bounded context", "Deduplicate and classify findings", "Patch required issues or stop for decision-needed findings", "Only mark done if done gate passes", "Record evidence and update sprint/state/ledger"]
          : [];
  const stopConditions = ["readiness missing or waived scope expired", "no eligible story", "retry limit reached", "failed local check that cannot be fixed safely", "patch-required review finding remains", "decision-needed finding or artifact contradiction", "accepted-risk candidate without Owner/scope/evidence", "credentials/paid/destructive/external-action/reference-project/baseline blocker"];
  const stateUpdates = ["current workflow/story", "story Dev Agent Record", "sprint-status.yaml", "work ledger/evidence path", "runtime command evidence when launched"];
  const compactArtifactRules = [
    "Use docs/agent-artifact-contract.md before creating or updating story/sprint/evidence artifacts",
    "Keep story context compact: Acceptance Criteria, Agent Scope, Tasks / Subtasks, Dev Agent Record, File List, Senior Developer Review",
    "Use sprint-status.yaml as the compact index; update last_updated and the story state when the loop advances",
    "Delete/archive ephemeral consumer task packets only after result, files, checks, evidence and next status are captured",
  ];
  const executionLines = rec.action === "blocked"
    ? ["Do not execute the loop. Resolve blockers or record required evidence before continuing."]
    : ["Execute the loop, not just a recommendation:", ...loopSteps.map((step, index) => `${index + 1}. ${step}`)];
  const prompt = [
    `/skill:${rec.skill ?? "bmad-runtime-for-pi"}`, "", `BMAD Phase 4 automatic execution plan for ${story}.`, `Action: ${rec.action}`, `Reason: ${rec.reason}`, "", ...executionLines, "", "Required checks:", ...(rec.requiredChecks?.length ? rec.requiredChecks.map((check) => `- ${check}`) : ["- none"]),
    "Compact artifact rules:", ...compactArtifactRules.map((item) => `- ${item}`),
    "Evidence requirements:", ...(rec.evidenceRequirements?.length ? rec.evidenceRequirements.map((item) => `- ${item}`) : ["- none"]),
    "Allowed paths:", ...(context?.allowedPaths.length ? context.allowedPaths.map((item) => `- ${item}`) : ["- none declared; infer only from story scope and Project Workspace evidence paths"]),
    "Dependencies:", ...(context?.dependencies.length ? context.dependencies.map((item) => `- ${item}`) : ["- none declared"]),
    "Diff approval policy:", ...(rec.diffApproval ? formatDiffApprovalPolicy(rec.diffApproval).split(/\r?\n/).map((line) => `- ${line}`) : ["- not evaluated"]),
    "Failure policy:", context ? `- classification: ${context.failurePolicy.classification}` : "- none",
    ...(context?.failurePolicy.retryScheduled ? [`- retry scheduled: yes`, `- retry remaining: ${context.failurePolicy.retryRemaining}/${context.failurePolicy.retryLimit}`] : []),
    ...(context?.failurePolicy.acceptedRisk ? [`- accepted risk owner: ${context.failurePolicy.acceptedRisk.owner}`, `- accepted risk scope: ${context.failurePolicy.acceptedRisk.scope}`, ...context.failurePolicy.acceptedRisk.evidence.map((item) => `- accepted risk evidence: ${item}`)] : []),
    "Blockers:", ...(blockers.length ? blockers.map((item) => `- ${item}`) : ["- none"]),
    "Stop conditions:", ...stopConditions.map((item) => `- ${item}`), "", "Do not mark the story done until implementation, checks, review synthesis, and evidence all pass. Continue through `/bmad-start`/resume after a successful iteration.",
  ].join("\n");
  return { recommendation: rec, loopSteps, stopConditions, stateUpdates, prompt };
}

export function formatPhase4AutomationRecommendation(rec: Phase4AutomationRecommendation): string {
  const story = rec.story ? `\nStory: ${rec.story.key} (${rec.story.status})` : "";
  const skill = rec.skill ? `\nSkill: ${rec.skill}` : "";
  const checks = rec.requiredChecks?.length ? `\nRequired checks: ${rec.requiredChecks.join(", ")}` : "";
  const evidence = rec.evidenceRequirements?.length ? `\nEvidence: ${rec.evidenceRequirements.join(", ")}` : "";
  const blockers = rec.blockers?.length ? `\nBlockers: ${rec.blockers.join("; ")}` : "";
  const diffApproval = rec.diffApproval ? `\nDiff approval: ${rec.diffApproval.mode} (${rec.diffApproval.blocking ? "blocking" : "non-blocking"})` : "";
  return [`BMAD automatic next step: ${rec.action}`, `Reason: ${rec.reason}`, story, skill, checks, evidence, blockers, diffApproval].filter(Boolean).join("\n");
}
