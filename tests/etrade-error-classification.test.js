// tests/etrade-error-classification.test.js
// Covers classifyEtradeError (api/etrade.js) — distinguishes "re-auth required"
// (token_expired/rejected) from "consumer key/signature broken" (signature_invalid/
// consumer_key_*) so /api/etrade's error response tells the caller WHY it failed,
// not just that it failed. ETrade reports this via the WWW-Authenticate header's
// oauth_problem param and/or an XML error body — never a clean JSON field.
// Run: npx vitest run tests/etrade-error-classification.test.js

import { describe, it, expect } from "vitest";
import { classifyEtradeError } from "../api/etrade.js";

function fakeRes(status, wwwAuthenticate) {
  return {
    status,
    headers: { get: (name) => (name.toLowerCase() === "www-authenticate" ? wwwAuthenticate : null) },
  };
}

describe("classifyEtradeError", () => {
  it("positive — WWW-Authenticate oauth_problem=token_expired -> token_expired", () => {
    const res = fakeRes(401, 'OAuth realm="https://etws.etrade.com", oauth_problem="token_expired"');
    expect(classifyEtradeError(res, "")).toBe("token_expired");
  });

  it("positive — WWW-Authenticate oauth_problem=signature_invalid -> signature_invalid", () => {
    const res = fakeRes(401, 'OAuth realm="https://etws.etrade.com", oauth_problem="signature_invalid"');
    expect(classifyEtradeError(res, "")).toBe("signature_invalid");
  });

  it("positive — oauth_problem in body (no header) -> consumer_key_rejected", () => {
    const res = fakeRes(401, null);
    expect(classifyEtradeError(res, "oauth_problem=consumer_key_rejected")).toBe("consumer_key_rejected");
  });

  it("negative — prose mentioning 'invalid signature' without the oauth_problem code -> signature_invalid via text fallback", () => {
    const res = fakeRes(500, null);
    expect(classifyEtradeError(res, "Request failed: Invalid Signature for consumer key")).toBe("signature_invalid");
  });

  it("edge — 401 with no problem code and no XML body -> defaults to token_expired", () => {
    const res = fakeRes(401, null);
    expect(classifyEtradeError(res, "some plain error text")).toBe("token_expired");
  });

  it("edge — XML body with no problem code, non-401 status -> defaults to token_expired", () => {
    const res = fakeRes(500, null);
    expect(classifyEtradeError(res, "<Error><Code>1000</Code><Message>oops</Message></Error>")).toBe("token_expired");
  });

  it("edge — non-401, non-XML, no recognizable problem -> unknown", () => {
    const res = fakeRes(500, null);
    expect(classifyEtradeError(res, '{"unexpected":"json shape"}')).toBe("unknown");
  });

  it("boundary — unrecognized oauth_problem code in header falls through to body/status heuristics, not a crash", () => {
    const res = fakeRes(500, 'OAuth oauth_problem="some_future_code_we_dont_know"');
    expect(classifyEtradeError(res, "unrelated body")).toBe("unknown");
  });
});
