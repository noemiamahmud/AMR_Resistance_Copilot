/**
 * Minimal client for a local Ollama server.
 *
 * We talk to the *native* `/api/chat` endpoint rather than the OpenAI-compatible
 * `/v1/chat/completions` one, for two reasons that matter here:
 *
 *  - `think: false`. qwen3 is a hybrid reasoning model and thinks by default. On an
 *    M-series laptop a chain of thought costs tens of seconds we do not have in a live
 *    demo, and the OpenAI-compatible shim ignores the usual knobs for turning it off
 *    (`chat_template_kwargs`), so the whole token budget disappears into `reasoning`.
 *  - `format: <json schema>`. Ollama constrains decoding to the schema, which is what
 *    makes structured output from an 8B model reliable rather than hopeful.
 *
 * Everything is local, so there is no key and no rate limit - only latency.
 */

export const DEFAULT_HOST = "http://localhost:11434";
export const DEFAULT_MODEL = "qwen3:8b";

export function ollamaHost(): string {
  return (process.env.OLLAMA_HOST ?? DEFAULT_HOST).replace(/\/+$/, "");
}

export function ollamaModel(): string {
  return process.env.OLLAMA_MODEL ?? DEFAULT_MODEL;
}

/** The local model is unreachable, or took too long. Callers degrade rather than fail. */
export class OllamaUnavailableError extends Error {}

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface ChatOptions {
  /** JSON schema; when given, Ollama constrains decoding to it. */
  schema?: unknown;
  /** qwen3 thinks by default; off unless a caller really wants it. */
  think?: boolean;
  temperature?: number;
  /** Ollama's num_predict. */
  maxTokens?: number;
  timeoutMs?: number;
  signal?: AbortSignal;
}

export interface ChatResult {
  content: string;
  model: string;
  latencyMs: number;
  /** Ollama reports how much of the wall clock went into loading the model. */
  loadMs: number;
  evalTokens: number;
}

interface OllamaChatResponse {
  model?: string;
  message?: { content?: string };
  total_duration?: number;
  load_duration?: number;
  eval_count?: number;
  error?: string;
}

const NANOS_PER_MS = 1e6;

export async function chat(messages: ChatMessage[], options: ChatOptions = {}): Promise<ChatResult> {
  const { schema, think = false, temperature = 0.2, maxTokens = 700, timeoutMs = 120_000 } = options;

  const model = ollamaModel();
  const signals = [AbortSignal.timeout(timeoutMs)];
  if (options.signal) signals.push(options.signal);

  const started = Date.now();
  let response: Response;
  try {
    response = await fetch(`${ollamaHost()}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal: AbortSignal.any(signals),
      body: JSON.stringify({
        model,
        messages,
        stream: false,
        think,
        ...(schema ? { format: schema } : {}),
        options: { temperature, num_predict: maxTokens },
      }),
    });
  } catch (err) {
    if (options.signal?.aborted) throw err;
    const reason = err instanceof Error && err.name === "TimeoutError"
      ? `the local model did not answer within ${Math.round(timeoutMs / 1000)}s`
      : `could not reach Ollama at ${ollamaHost()}`;
    throw new OllamaUnavailableError(
      `${reason}. Start it with \`ollama serve\` and \`ollama pull ${model}\`.`,
    );
  }

  if (!response.ok) {
    const detail = (await response.text()).slice(0, 300);
    throw new OllamaUnavailableError(
      `Ollama returned ${response.status} for model "${model}". ${detail}`.trim(),
    );
  }

  const body = (await response.json()) as OllamaChatResponse;
  if (body.error) throw new OllamaUnavailableError(body.error);

  return {
    content: body.message?.content ?? "",
    model: body.model ?? model,
    latencyMs: Date.now() - started,
    loadMs: Math.round((body.load_duration ?? 0) / NANOS_PER_MS),
    evalTokens: body.eval_count ?? 0,
  };
}

export interface OllamaHealth {
  available: boolean;
  host: string;
  model: string;
  /** True when the configured model is actually pulled. */
  modelPresent: boolean;
  installedModels: string[];
  message: string | null;
}

export async function health(timeoutMs = 3_000): Promise<OllamaHealth> {
  const host = ollamaHost();
  const model = ollamaModel();
  try {
    const res = await fetch(`${host}/api/tags`, { signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) throw new Error(`status ${res.status}`);
    const body = (await res.json()) as { models?: { name?: string }[] };
    const installed = (body.models ?? []).map((m) => m.name ?? "").filter(Boolean);
    const modelPresent = installed.some((n) => n === model || n.split(":")[0] === model.split(":")[0]);
    return {
      available: true,
      host,
      model,
      modelPresent,
      installedModels: installed,
      message: modelPresent ? null : `Ollama is running but "${model}" is not pulled.`,
    };
  } catch {
    return {
      available: false,
      host,
      model,
      modelPresent: false,
      installedModels: [],
      message: `No Ollama server at ${host}.`,
    };
  }
}

/**
 * One throwaway token to force the weights into memory. Cold-loading qwen3:8b costs
 * ~10s, which is the difference between a demo that feels instant and one that stalls
 * on the first question asked of it.
 */
export async function prewarm(): Promise<{ warmed: boolean; latencyMs: number }> {
  try {
    const result = await chat([{ role: "user", content: "ok" }], { maxTokens: 1, timeoutMs: 60_000 });
    return { warmed: true, latencyMs: result.latencyMs };
  } catch {
    return { warmed: false, latencyMs: 0 };
  }
}
