import { createInterface } from "node:readline/promises";
import type { AuthInteraction } from "@earendil-works/pi-ai";
import { createOAuthModelRuntime } from "./runtime.ts";
import { oauthLoginError } from "./auth-errors.ts";

/** Status deliberately does not refresh tokens or claim account/model entitlement. */
export async function oauthStatus(provider: string, authPath: string) {
  const runtime = await createOAuthModelRuntime(provider, authPath, false);
  let configured;
  try { configured = (await runtime.listCredentials({ signal: AbortSignal.timeout(30_000) })).some(c => c.providerId === provider && c.type === "oauth"); }
  catch { throw Error("Cannot read the OAuth credential file"); }
  return { provider, authentication: "oauth", configured, entitlementVerified: false };
}

export async function loginOAuth(provider: string, authPath: string, interaction: AuthInteraction) {
  const runtime = await createOAuthModelRuntime(provider, authPath, false);
  let verifyingStorage = false;
  try {
    await runtime.login(provider, "oauth", interaction);
    verifyingStorage = true;
    // Re-open the native store: do not report success for an in-memory-only login.
    const status = await oauthStatus(provider, authPath);
    if (!status.configured) throw Error("Credential was not persisted");
    return status;
  } catch (error) {
    throw oauthLoginError(error, interaction.signal, verifyingStorage);
  }
}

export async function logoutOAuth(provider: string, authPath: string) {
  const runtime = await createOAuthModelRuntime(provider, authPath, false);
  try { await runtime.logout(provider); }
  catch { throw Error("OAuth logout failed; could not update the credential store"); }
  return oauthStatus(provider, authPath);
}

export async function loginOAuthInTerminal(provider: string, authPath: string) {
  if (!process.stdin.isTTY || !process.stderr.isTTY) throw Error("Run login in an interactive terminal");
  const cancel = new AbortController(), stop = () => cancel.abort();
  const signal = AbortSignal.any([cancel.signal, AbortSignal.timeout(15 * 60_000)]);
  const terminal = createInterface({ input: process.stdin, output: process.stderr });
  process.once("SIGINT", stop); process.once("SIGTERM", stop); terminal.on("SIGINT", stop);
  try {
    return await loginOAuth(provider, authPath, {
      signal,
      notify(event) {
        if (event.type === "auth_url") console.error(`在浏览器打开以下链接完成登录：\n${event.url}`);
        else if (event.type === "device_code") console.error(`打开 ${event.verificationUri}，输入代码：${event.userCode}`);
        else {
          console.error(event.message);
          if (event.type === "info") for (const link of event.links ?? []) console.error(link.url);
        }
      },
      async prompt(prompt) {
        const promptSignal = prompt.signal ? AbortSignal.any([signal, prompt.signal]) : signal;
        if (prompt.type === "secret") throw Error("This login entry supports OAuth only");
        if (prompt.type === "select") {
          console.error(prompt.message);
          prompt.options.forEach((option, i) => console.error(`${i + 1}. ${option.label}`));
          const answer = (await terminal.question("选择编号（回车选择 1）：", { signal: promptSignal })).trim();
          const selected = prompt.options[Number(answer || "1") - 1];
          if (!selected) throw Error("Invalid login method");
          return selected.id;
        }
        while (true) {
          const answer = await terminal.question(`${prompt.message}\n> `, { signal: promptSignal });
          if (prompt.type !== "manual_code" || answer.trim()) return answer;
          console.error("仍在等待浏览器授权；无需按回车。也可粘贴本次登录的最终跳转地址。");
        }
      },
    });
  } finally {
    terminal.close(); process.removeListener("SIGINT", stop); process.removeListener("SIGTERM", stop);
  }
}
