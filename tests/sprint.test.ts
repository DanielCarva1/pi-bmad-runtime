import { describe, expect, it } from "vitest";
import {
  findFirstStoryWithStatus,
  parseSprintStatusText,
  summarizeSprint,
  validateSprintDocument,
  validateSprintTransition,
} from "../extensions/bmad-runtime/sprint.js";

const yaml = `# generated: 2026-05-18
generated: 2026-05-18
last_updated: 2026-05-18
project: Example

development_status:
  epic-1: in-progress
  1-1-first-story: done
  1-2-second-story: ready-for-dev
  epic-1-retrospective: optional
`;

describe("sprint status parser", () => {
  it("parses ordered development_status entries", () => {
    const doc = parseSprintStatusText(yaml, "sprint-status.yaml");
    expect(doc.entries).toHaveLength(4);
    expect(doc.entries[0]).toMatchObject({ key: "epic-1", kind: "epic", status: "in-progress", epic: 1 });
    expect(doc.entries[2]).toMatchObject({ key: "1-2-second-story", kind: "story", story: 2, status: "ready-for-dev" });
    expect(doc.project).toBe("Example");
  });

  it("summarizes and finds stories by status", () => {
    const doc = parseSprintStatusText(yaml);
    expect(summarizeSprint(doc)["story:done"]).toBe(1);
    expect(findFirstStoryWithStatus(doc, "ready-for-dev")?.key).toBe("1-2-second-story");
  });

  it("validates illegal statuses", () => {
    const doc = parseSprintStatusText(`development_status:\n  1-1-test: shipped\n`);
    expect(validateSprintDocument(doc).some((issue) => issue.severity === "error")).toBe(true);
  });

  it("validates story transitions", () => {
    expect(validateSprintTransition("story", "ready-for-dev", "in-progress").ok).toBe(true);
    expect(validateSprintTransition("story", "ready-for-dev", "done").ok).toBe(false);
    expect(validateSprintTransition("story", "review", "done").ok).toBe(true);
  });
});
