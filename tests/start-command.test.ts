import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import bmadRuntimeExtension from "../extensions/bmad-runtime/index.js";
import { writeRuntimeHandoff } from "../extensions/bmad-runtime/handoff.js";
import { ensureProjectRegistered } from "../extensions/bmad-runtime/project.js";
import { loadRegistry } from "../extensions/bmad-runtime/registry.js";
import { loadState, saveState } from "../extensions/bmad-runtime/state.js";

type CommandSpec = { handler?: (rawArgs: string, ctx: TestContext) => Promise<void> };
type InputHandler = (event: { text: string }, ctx: TestContext) => Promise<{ action?: string } | void>;

interface TestContext {
  cwd: string;
  hasUI: boolean;
  sessionManager: { getSessionFile: () => string };
  ui: {
    notify(message: string, kind?: string): void;
    setStatus(): void;
    theme: { fg(_kind: string, text: string): string };
  };
}

let tempDirs: string[] = [];

function makeRoot(prefix = "pi-bmad-start-command-"): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(root);
  return root;
}

function makeContext(cwd: string): TestContext {
  return {
    cwd,
    hasUI: true,
    sessionManager: { getSessionFile: () => path.join(cwd, "session.json") },
    ui: {
      notify() { /* noop */ },
      setStatus() { /* noop */ },
      theme: { fg: (_kind: string, text: string) => text },
    },
  };
}

function installExtension(runtimeHome: string) {
  const commands = new Map<string, CommandSpec>();
  const inputHandlers: InputHandler[] = [];
  const messages: string[] = [];
  const userMessages: string[] = [];
  const entries: { type: string; value: unknown }[] = [];

  bmadRuntimeExtension({
    registerCommand(name: string, spec: CommandSpec) {
      commands.set(name, spec);
    },
    on(event: string, handler: InputHandler) {
      if (event === "input") inputHandlers.push(handler);
    },
    appendEntry(type: string, value: unknown) {
      entries.push({ type, value });
    },
    sendMessage(message: { content?: string }) {
      messages.push(message.content ?? "");
    },
    setSessionName() { /* noop */ },
    sendUserMessage(prompt: string) {
      userMessages.push(prompt);
    },
  } as any, { registryOptions: { runtimeHome } });

  return { commands, inputHandlers, messages, userMessages, entries };
}

afterEach(() => {
  for (const dir of tempDirs) fs.rmSync(dir, { recursive: true, force: true });
  tempDirs = [];
});

describe("BMAD start command smoke", () => {
  it("runs the real /bmad-start conversational new-project path in an isolated Runtime Home", async () => {
    const source = makeRoot();
    const runtimeHome = makeRoot();
    const dedicatedRoot = makeRoot("pi-bmad-dedicated-root-");
    const harness = installExtension(runtimeHome);
    const ctx = makeContext(source);

    await harness.commands.get("bmad-start")?.handler?.("", ctx);
    expect(harness.messages.at(-1)).toContain("# BMAD Start");
    expect(harness.userMessages.at(-1)).toContain("/skill:bmad-runtime-for-pi start router");

    const result = await harness.inputHandlers[0]?.(
      { text: `novo Smoke App --root "${dedicatedRoot}" --no-git-init` },
      ctx,
    );

    expect(result?.action).toBe("handled");
    const dedicated = harness.entries.find((entry) => entry.type === "bmad-runtime-dedicated-workspace")?.value as { ok?: boolean; workspacePath?: string; packageSpec?: string } | undefined;
    expect(dedicated?.ok).toBe(true);
    expect(dedicated?.workspacePath).toBeTruthy();
    expect(dedicated?.workspacePath?.startsWith(dedicatedRoot)).toBe(true);
    expect(fs.existsSync(path.join(dedicated!.workspacePath!, ".pi", "settings.json"))).toBe(true);
    expect(fs.existsSync(path.join(dedicated!.workspacePath!, ".bmad-runtime", "project-identity.json"))).toBe(true);

    const registry = await loadRegistry({ runtimeHome });
    expect(registry.ok).toBe(true);
    if (!registry.ok) return;
    expect(registry.value.projects).toHaveLength(1);
    expect(registry.value.projects[0]?.knownRoots).toContain(dedicated!.workspacePath!);
    expect(harness.messages.at(-1)).toContain("Then run `/bmad-start` there");
  });

  it("continues an existing project using the prior latest handoff instead of overwriting it before bootstrap", async () => {
    const root = makeRoot();
    const runtimeHome = makeRoot();
    await ensureProjectRegistered(root, { runtimeHome });
    const state = saveState(root, { ...loadState(root), active: true, phase: "4-implementation", currentWorkflow: "bmad-dev-story", currentStory: "3.3" });
    const prior = writeRuntimeHandoff(root, {
      reason: "agent_end",
      state,
      nextStep: "Resume Story 3.3 from the previous agent handoff.",
      note: "Previous agent preserved this exact next action.",
    });
    const priorText = fs.readFileSync(prior.absolutePath, "utf8");
    const harness = installExtension(runtimeHome);
    const ctx = makeContext(root);

    await harness.commands.get("bmad-start")?.handler?.("", ctx);
    const result = await harness.inputHandlers[0]?.({ text: "1" }, ctx);

    expect(result?.action).toBe("handled");
    const bootstrap = harness.userMessages.at(-1) ?? "";
    expect(bootstrap).toContain("/skill:bmad-runtime-for-pi resume existing-project");
    expect(bootstrap).toContain("Resume Story 3.3 from the previous agent handoff.");
    expect(bootstrap).toContain("Previous agent preserved this exact next action.");
    expect(bootstrap).toContain("Do not mix this project with another BMAD project");
    expect(loadState(root).active).toBe(true);
    expect(fs.readFileSync(prior.absolutePath, "utf8")).toBe(priorText);
  });
});
