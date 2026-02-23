function trim(value) {
  return String(value ?? "").trim();
}

export function buildPairingReply(params) {
  const idLine = trim(params?.idLine);
  const code = trim(params?.code).toUpperCase();

  return [
    "CodexClaw: access not configured.",
    "",
    idLine,
    "",
    `Pairing code: ${code}`,
    "",
    "Ask the bot owner to enter this code in the running bot terminal.",
  ].join("\n");
}
