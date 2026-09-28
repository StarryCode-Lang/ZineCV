import type { AgentProviderStatus } from "../legacy/agent/types";
import { nativeInvoke } from "./ipc";

type Account = { id: string; email: string };
type ProviderProfile = {
  providerId: string;
  name: string;
  baseUrl: string;
  model: string;
  capability: string;
  hasApiKey: boolean;
};

export async function nativeAgentStatus(): Promise<AgentProviderStatus> {
  const account = await nativeInvoke("current_account") as Account | null;
  const profile = account
    ? await nativeInvoke("provider_profile") as ProviderProfile | null
    : null;
  return {
    configured: profile !== null,
    provider: profile ? {
      name: profile.name,
      baseUrl: profile.baseUrl,
      model: profile.model,
      hasApiKey: profile.hasApiKey,
      capability: profile.capability === "structured" ? "structured" : "chat",
    } : null,
    keyStorage: "local-account",
    authRequired: true,
    account,
  };
}

export async function nativeAuthenticate(
  mode: "login" | "register",
  credentials: { email: string; password: string },
): Promise<AgentProviderStatus> {
  if (mode === "register") await nativeInvoke("register_account", credentials);
  await nativeInvoke("login_account", credentials);
  return nativeAgentStatus();
}

export async function nativeLogout(): Promise<void> {
  await nativeInvoke("logout_account");
}

export async function nativeSaveProvider(draft: {
  name: string;
  baseUrl: string;
  model: string;
  apiKey: string;
}): Promise<AgentProviderStatus> {
  await nativeInvoke("store_provider_key", {
    name: draft.name.trim(),
    baseUrl: draft.baseUrl.trim(),
    model: draft.model.trim(),
    key: draft.apiKey.trim(),
  });
  return nativeAgentStatus();
}

export async function nativeClearProvider(): Promise<void> {
  await nativeInvoke("clear_provider");
}
