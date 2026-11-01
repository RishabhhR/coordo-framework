// Turns a raw MongoDB driver failure into one safe, actionable line.
//
// The same low-level error can mean very different things, and the old blanket hint
// ("check cluster availability") sent people the wrong way. Observed 2026-10-31: "SSL alert
// number 80" on every node only meant that this machine's public IP was not on the Atlas
// Network Access list (the IP changes on every Wi-Fi or hotspot switch).
//
// The text is read by agents and lands in transcripts and logs, so it never echoes
// hostnames, URIs, IP addresses or credentials.

export type MongoFailureKind = "ip_not_allowed" | "bad_auth" | "timeout" | "dns" | "tls" | "other";

export function classifyMongoFailure(raw: string): MongoFailureKind {
  const text = String(raw);
  if (/alert(?: number)? 80\b|tlsv1 alert internal error|ERR_SSL_TLSV1_ALERT_INTERNAL_ERROR/i.test(text)) return "ip_not_allowed";
  if (/\bbad auth\b|authentication failed|AuthenticationFailed/i.test(text)) return "bad_auth";
  if (/ENOTFOUND|EAI_AGAIN|querySrv|getaddrinfo|ECONNREFUSED/i.test(text)) return "dns";
  if (/server selection timed out|ETIMEDOUT|timed out/i.test(text)) return "timeout";
  if (/TLS|SSL|certificate|handshake/i.test(text)) return "tls";
  return "other";
}

const REDACTIONS: Array<[RegExp, string]> = [
  [/mongodb(?:\+srv)?:\/\/\S+/gi, "<mongodb-uri>"],
  [/\b[a-z0-9][a-z0-9.-]*\.mongodb\.net(?::\d+)?/gi, "<atlas-host>"],
  [/\b\d{1,3}(?:\.\d{1,3}){3}(?::\d+)?\b/g, "<ip>"],
];

/** First line of the driver message with hosts, URIs and IP addresses removed. */
export function sanitizeMongoMessage(raw: string, max = 200): string {
  let text = String(raw).split("\n")[0] ?? "";
  for (const [pattern, replacement] of REDACTIONS) text = text.replace(pattern, replacement);
  return text.trim().replace(/[.\s]+$/, "").slice(0, max);
}

const NO_OP = "No ledger operation was run.";

export function describeMongoFailure(raw: string, agent: string): string {
  const who = String(agent).replace(/[^a-z0-9_-]/gi, "") || "this agent";
  switch (classifyMongoFailure(raw)) {
    case "ip_not_allowed":
      return "Mongo connection failed: Atlas dropped the TLS handshake (SSL alert 80). This machine's public IP is most likely not on the Atlas Network Access list; it changes on every Wi-Fi or hotspot switch. "
        + "Add the current IP in Atlas (Security > Database & Network Access) or run atlas-ip-sync; `atlas-ip-sync --probe` needs no credentials and shows whether TLS works. "
        + `If the IP is already listed, the cluster may be paused. ${NO_OP}`;
    case "bad_auth":
      return `Mongo connection failed: Atlas rejected the credentials for agent '${who}'. `
        + "Check that agent's user and password in ~/.config/coordo/mongo.env against Atlas > Database Access (never print or paste them). "
        + `The network path is fine if you got this far. ${NO_OP}`;
    case "timeout":
      return "Mongo connection failed: no Atlas node answered in time. The network may be down, the cluster paused, or this machine's IP not allowed "
        + `(\`atlas-ip-sync --probe\` tells the last two apart). ${NO_OP}`;
    case "dns":
      return `Mongo connection failed: the Atlas host could not be resolved or reached (offline, or a wrong COORDO_MONGO_HOST). ${NO_OP}`;
    case "tls":
      return `Mongo connection failed: ${sanitizeMongoMessage(raw)}. Check Atlas cluster availability and the local network/TLS path; ${NO_OP.toLowerCase()}`;
    default:
      return `Mongo connection failed: ${sanitizeMongoMessage(raw)}. ${NO_OP}`;
  }
}
