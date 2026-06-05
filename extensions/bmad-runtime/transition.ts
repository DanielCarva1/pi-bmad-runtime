export interface TransitionPromptInput {
  current: string;
  destination: string;
  artifacts?: string[];
  gate?: string;
  evidence?: string[];
}

export function formatTransitionPrompt(input: TransitionPromptInput): string {
  const lines = [
    "BMAD transition confirmation",
    `Current: ${input.current}`,
    `Proposed destination: ${input.destination}`,
  ];
  if (input.gate) lines.push(`Gate: ${input.gate}`);
  if (input.artifacts?.length) {
    lines.push("Artifacts:");
    for (const artifact of input.artifacts) lines.push(`- ${artifact}`);
  }
  if (input.evidence?.length) {
    lines.push("Evidence:");
    for (const item of input.evidence) lines.push(`- ${item}`);
  }
  lines.push("", "Options:", "1. Accept — record the transition decision and proceed", "2. Review — inspect the artifacts/gate before deciding", "3. Cancel — stay on the current BMAD step");
  return lines.join("\n");
}
