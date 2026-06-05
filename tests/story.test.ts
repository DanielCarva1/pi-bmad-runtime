import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { analyzeStory, deriveStoryKeyFromPath, parseStoryStatus, scanStoryStatusFiles, validateStoryDone } from "../extensions/bmad-runtime/story.js";

let tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs) fs.rmSync(dir, { recursive: true, force: true });
  tempDirs = [];
});

const baseStory = `# Story 1.1: Test

Status: review

## Story

As a user, I want a thing.

## Acceptance Criteria

1. Given X When Y Then Z

## Tasks / Subtasks

- [x] Implement thing

## Dev Agent Record

### Debug Log References

- npm test — passed.

### Completion Notes List

Done.

### File List

- src/thing.ts

## Senior Developer Review (AI)

**Outcome:** Approve

### Findings

Clean review. No decision-needed, patch, or defer findings.
`;

describe("story parser", () => {
  it("parses inline status", () => {
    expect(parseStoryStatus(baseStory)).toBe("review");
  });

  it("allows done when completion evidence exists", () => {
    const issues = validateStoryDone(baseStory.replace("Status: review", "Status: done"));
    expect(issues).toHaveLength(0);
  });

  it("rejects done with unchecked tasks and empty file list", () => {
    const story = baseStory
      .replace("Status: review", "Status: done")
      .replace("- [x] Implement thing", "- [ ] Implement thing")
      .replace("- src/thing.ts", "");
    const issues = validateStoryDone(story);
    expect(issues.map((issue) => issue.message).join("\n")).toContain("unchecked");
    expect(issues.map((issue) => issue.message).join("\n")).toContain("File List");
  });

  it("detects unresolved review findings", () => {
    const story = `${baseStory.replace("Status: review", "Status: done")}\n- [ ] [Review][Patch] Fix edge case\n`;
    expect(analyzeStory(story).unresolvedReviewFindingCount).toBe(1);
    expect(validateStoryDone(story)[0]?.message).toContain("review finding");
  });

  it("derives and scans story file statuses", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-bmad-story-test-"));
    tempDirs.push(root);
    fs.writeFileSync(path.join(root, "1-1-test-story.md"), baseStory, "utf8");
    fs.writeFileSync(path.join(root, "notes.md"), "Status: done", "utf8");

    expect(deriveStoryKeyFromPath(path.join(root, "1-1-test-story.md"))).toBe("1-1-test-story");
    expect(scanStoryStatusFiles(root)).toEqual([
      expect.objectContaining({ key: "1-1-test-story", status: "review" }),
    ]);
  });
});
