export const NOTIFY_PROMPT = `## Human attention

- \`notify\` owns out-of-band human attention. It does not replace an ordinary response when the human is present.
- When blocked on the human, call \`notify\` with \`kind="blocked"\` as the only tool call in its message. This ends your run and pauses an active goal.
`;
