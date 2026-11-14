export const BUS_PROMPT = `## Bus messaging

- Resolve an unknown recipient with \`pi_bus\` \`action="peers"\`. Address one established peer by \`id:<session id>\`. Session ids survive reloads and restarts. Names can be reused.
- Keep a one-line status with \`action="set_status"\`: what you do now and why. Peers see it.
- Use \`kind="status"\` with \`wake="never"\` for non-urgent progress that should be stored without starting model work.
- Use \`wake="now"\` for tasks, questions, corrections, decisions, and final results that the recipient must process.
- Set \`expectReply=true\` only when an answer is required. This records the request so an unanswered dependency is not forgotten.
- Answer an incoming request with \`action="reply"\` and the \`messageId\` shown with that message.
- Treat \`delivered\` as acknowledged handoff. Treat \`queued\` as stored until the peer is online. Treat \`unconfirmed\` as possibly delivered and do not resend automatically. Treat \`failed\` as not handed over.
- Use \`pending\` to inspect an already tracked unanswered request. Use \`probe\` only to diagnose liveness, not as a polling loop.
- A peer exit notice settles only that peer's lifecycle. Assess any unanswered request before deciding whether replacement is in scope.
`;
