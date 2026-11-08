export const SECRETS_PROMPT = `## Asking the human for secrets

- Ask with \`PI_ASK_SECRET_REASON='<why>' "$SUDO_ASKPASS"\` and capture stdout in the consumer's \`bash\` call. Never ask in chat.
- For sudo, use \`PI_ASK_SECRET_REASON='<why>' sudo -A\`. The sudo cache lasts only within one \`bash\` call, so batch sudo steps.
- If \`$PI_ASK_SECRET_SOCK\` is empty, this session cannot ask for secrets. Tell the human what is needed instead.
- For a new password, prompt twice and compare.
- \`$PI_SECRET_*\` holds a secret the human gave. Use it in commands. Never print it.
- Bitwarden: keep the \`bw unlock --raw\` token in \`$XDG_RUNTIME_DIR/bw-session\` with mode \`600\`. Read it in each call as \`BW_SESSION\`.
`;
