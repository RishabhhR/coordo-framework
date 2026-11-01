import test from "node:test";
import assert from "node:assert/strict";
import { classifyMongoFailure, describeMongoFailure, sanitizeMongoMessage } from "../dist/mongoErrors.js";

// Verbatim from a real failure on 2026-10-31 (every Atlas node dropped the handshake).
const ALERT80 = "807F91E801000000:error:0A000438:SSL routines:ssl3_read_bytes:tlsv1 alert internal error:ssl/record/rec_layer_s3.c:918:SSL alert number 80";

test("TLS alert 80 means the IP is not allowed, not 'check cluster availability'", () => {
  assert.equal(classifyMongoFailure(ALERT80), "ip_not_allowed");
  assert.equal(classifyMongoFailure("ERR_SSL_TLSV1_ALERT_INTERNAL_ERROR"), "ip_not_allowed");
  const text = describeMongoFailure(ALERT80, "claude");
  assert.match(text, /public IP is most likely not on the Atlas Network Access list/);
  assert.match(text, /atlas-ip-sync --probe/);
  assert.match(text, /^Mongo connection failed:/);
  assert.match(text, /No ledger operation was run\.$/);
  assert.doesNotMatch(text, /Check Atlas cluster availability/);
});

test("bad auth names the agent and where its credential lives, and says the network is fine", () => {
  const raw = "bad auth : authentication failed";
  assert.equal(classifyMongoFailure(raw), "bad_auth");
  const text = describeMongoFailure(raw, "claude");
  assert.match(text, /credentials for agent 'claude'/);
  assert.match(text, /~\/\.config\/coordo\/mongo\.env/);
  assert.match(text, /network path is fine/);
  assert.match(describeMongoFailure("Authentication failed.", "codex"), /agent 'codex'/);
});

test("alert 80 outranks the generic TLS wording; unrelated TLS errors keep the availability hint", () => {
  assert.equal(classifyMongoFailure("SSL routines: certificate verify failed: certificate has expired"), "tls");
  assert.match(describeMongoFailure("certificate has expired", "claude"), /Check Atlas cluster availability/);
  assert.equal(classifyMongoFailure("write EPROTO TLS handshake failure ... alert number 80"), "ip_not_allowed");
});

test("timeouts and DNS failures get their own advice", () => {
  assert.equal(classifyMongoFailure("Server selection timed out after 8000 ms"), "timeout");
  assert.match(describeMongoFailure("Server selection timed out after 8000 ms", "claude"), /no Atlas node answered in time/);
  assert.equal(classifyMongoFailure("querySrv ENOTFOUND _mongodb._tcp.cluster0.abcde.mongodb.net"), "dns");
  assert.match(describeMongoFailure("getaddrinfo EAI_AGAIN cluster0.abcde.mongodb.net", "claude"), /could not be resolved or reached/);
});

test("unknown errors keep the old format and never echo hosts, URIs or IP addresses", () => {
  const raw = "weird failure talking to cluster0.abcde.mongodb.net:27017 at 203.0.113.7 via mongodb+srv://user:hunter2@cluster0.abcde.mongodb.net/coordo?retryWrites=true";
  const text = describeMongoFailure(raw, "claude");
  assert.match(text, /^Mongo connection failed: weird failure talking to /);
  assert.match(text, /No ledger operation was run\.$/);
  for (const leak of ["cluster0", "abcde", "mongodb.net", "203.0.113.7", "hunter2", "user:"]) assert.ok(!text.includes(leak), `leaked ${leak}`);
  assert.ok(!sanitizeMongoMessage("see 10.1.2.3:27017").includes("10.1.2.3"));
});

test("only the first line of a multi-line driver message is used, and it is bounded", () => {
  const text = describeMongoFailure(`oops\nsecond line with 198.51.100.9\n${"x".repeat(5000)}`, "claude");
  assert.ok(!text.includes("second line") && !text.includes("198.51.100.9"));
  assert.ok(sanitizeMongoMessage("y".repeat(900)).length <= 200);
});

test("an odd agent name cannot inject text into the message", () => {
  assert.match(describeMongoFailure("bad auth", "claude'; rm -rf /"), /agent 'clauderm-rf'/);
});
