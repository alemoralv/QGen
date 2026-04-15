import OpenAI from "openai";

export interface GatewayClientOptions {
  apiKey: string;
  baseUrl: string;
}

export function buildGatewayClient(options: GatewayClientOptions): OpenAI {
  if (!options.apiKey.trim()) {
    throw new Error("GW_GATEWAY_API_KEY is missing or empty.");
  }
  if (!options.baseUrl.trim()) {
    throw new Error("GW_BASE_URL is missing or empty.");
  }
  return new OpenAI({
    apiKey: options.apiKey,
    baseURL: options.baseUrl.replace(/\/+$/, ""),
  });
}

export function gatewayRejectsTemperatureParam(err: unknown): boolean {
  const anyErr = err as {
    status?: number;
    code?: string;
    error?: { param?: string; message?: string };
    message?: string;
  };
  if (anyErr?.status !== 400) return false;
  const param = anyErr.error?.param;
  const msg = (anyErr.error?.message || anyErr.message || "").toLowerCase();
  if (param === "temperature") return true;
  return (
    msg.includes("temperature") &&
    (msg.includes("unsupported") || msg.includes("not supported"))
  );
}
