/** Return only allowlisted diagnostics: OAuth errors may contain full token response bodies. */
export function oauthLoginError(error: unknown, signal?: AbortSignal, verifyingStorage = false): Error {
  const failure = (code: string, detail: string) => Error(`OAuth login failed [${code}]: ${detail}`);
  if (signal?.aborted) return Error("OAuth login cancelled or timed out [cancelled]");
  let current = error;
  const seen = new Set<unknown>();
  for (let depth = 0; current && depth < 6 && !seen.has(current); depth++) {
    seen.add(current);
    const message = current instanceof Error ? current.message : "";
    const code = typeof current === "object" && "code" in current ? current.code : undefined;
    const http = /^OpenAI Codex token exchange failed \(([1-5][0-9]{2})\)/.exec(message);
    if (http) return failure(`token_http_${http[1]}`, `Browser authorization reached token exchange, but the token endpoint returned HTTP ${http[1]}. Check the terminal's network/proxy; retry with a fresh login link. Response body omitted.`);
    if (/^OpenAI Codex (device code request|device auth).*\b(?:status |\()([1-5][0-9]{2})/.test(message))
      return failure("device_auth_rejected", "Device authorization request was rejected. Check terminal connectivity and account device-login availability.");
    if (message === "State mismatch") return failure("state_mismatch", "The redirect belongs to another login attempt. Use the link printed by this terminal and its matching redirect.");
    if (message === "Missing authorization code") return failure("missing_code", "No authorization code was received. Complete browser login or paste its final redirect into this terminal.");
    if (/^OpenAI Codex token exchange response missing fields:/.test(message) || message === "Failed to extract accountId from token")
      return failure("invalid_token_response", "The token endpoint returned an unexpected credential format. Response body omitted.");
    if (verifyingStorage || /^Credential store modify failed for /.test(message) || ["EACCES", "EPERM", "EROFS", "ENOSPC", "ELOCKED"].includes(String(code)))
      return failure("credential_storage", "Could not confirm saved credentials. Check permissions and concurrent processes using the selected state directory; retry auth-status.");
    if (["ECONNREFUSED", "ECONNRESET", "ENOTFOUND", "EAI_AGAIN", "ETIMEDOUT", "UND_ERR_CONNECT_TIMEOUT", "UND_ERR_HEADERS_TIMEOUT"].includes(String(code)))
      return failure(`network_${code}`, "The terminal could not complete the authentication request. Browser connectivity does not verify Node connectivity; check HTTP_PROXY/HTTPS_PROXY and Node's environment-proxy setting.");
    if (["CERT_HAS_EXPIRED", "UNABLE_TO_VERIFY_LEAF_SIGNATURE", "DEPTH_ZERO_SELF_SIGNED_CERT", "SELF_SIGNED_CERT_IN_CHAIN"].includes(String(code)))
      return failure("network_tls", "TLS certificate verification failed. Check the configured proxy and trusted certificates.");
    current = typeof current === "object" && "cause" in current ? current.cause : undefined;
  }
  if (error instanceof Error && error.message === "fetch failed")
    return failure("network_fetch", "The authentication HTTP request failed. Check the terminal's network/proxy configuration.");
  return failure("unknown", "The login did not complete. Retry with a fresh login link; provider response details were omitted to protect credentials.");
}
