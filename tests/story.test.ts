import { describe, expect, it } from "vitest";
import { analyzeStory, parseStoryStatus, validateStoryDone } from "../extensions/bmad-runtime/story.js";

const baseStory = `# Story 1.1: Test

Status: review

## Story

As a user, I want a thing.

## Acceptance Criteria

1. Given X When Y Then Z

## Tasks / Subtasks

- [x] Implement thing

## Dev Agent Record

### Completion Notes List

Done.

### File List

- src/thing.ts
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
});
