/**
 * NPC reasoning — the OPENAI-COMPATIBLE provider (the Grok integration).
 *
 * ONE provider for the whole ecosystem that speaks the OpenAI `POST /chat/completions`
 * contract: xAI/Grok, Groq, Cerebras, OpenRouter, Together, Fireworks, Mistral, a local
 * Ollama, even OpenAI itself. Pick a backend by pointing the factory at a different
 * `{ baseUrl, apiKey, model }` — NO new code per provider. The reply is run through the
 * `parseReasoningResponse` firewall exactly like every provider, so a malformed model
 * output can never become an illegal action.
 *
 * SERVER-SIDE: makes a network call and holds the API key. Never import into the browser.
 */

import { parseReasoningResponse } from './schema.js';
import type { ReasoningRequest, ReasoningResponse } from './schema.js';
import { buildReasoningUserPrompt, REASONING_SYSTEM_GUARDRAILS } from './prompt.js';
import type { ReasoningProvider } from './provider.js';

export interface OpenAiCompatibleOptions {
  /** Display name (e.g. 'grok', 'openai') — flows into logs + a source badge. */
  name: string;
  /** API root that hosts `/chat/completions` (e.g. https://api.x.ai/v1). */
  baseUrl: string;
  /** Bearer key for this backend (e.g. XAI_API_KEY). */
  apiKey: string;
  /** The model id (e.g. grok-3, llama-3.3-70b-versatile). */
  model: string;
  /** Injectable fetch (tests). Defaults to the global `fetch`. */
  fetchImpl?: typeof fetch;
}

/** xAI's OpenAI-compatible endpoint — the default `baseUrl` for {@link createGrokProvider}. */
export const GROK_BASE_URL = 'https://api.x.ai/v1';
/** A sensible default Grok model. Override per your account's available models. */
export const DEFAULT_GROK_MODEL = 'grok-3';

/** The slice of the OpenAI chat-completions response we read (backend-agnostic). */
interface ChatCompletionShape {
  choices?: Array<{
    message?: { content?: string };
    finish_reason?: string;
  }>;
}

/** Best-effort read of an error body for diagnostics (never throws; capped). */
async function errorSnippet(res: Response): Promise<string> {
  try {
    const body = await res.text();
    return body.slice(0, 400).replace(/\s+/g, ' ').trim();
  } catch {
    return '(no body)';
  }
}

/**
 * Create a provider for any OpenAI-compatible chat-completions backend. The reply runs
 * through the firewall, so a bad model output yields no intents (the caller falls back).
 * Throws (no key / HTTP error) so a budget wrapper scripted-falls-back.
 */
export function createOpenAiCompatibleProvider(
  opts: OpenAiCompatibleOptions,
): ReasoningProvider {
  const name = opts.name;
  // Tolerate a trailing slash so both ".../v1" and ".../v1/" work.
  const baseUrl = opts.baseUrl.replace(/\/+$/, '');
  const apiKey = opts.apiKey;
  const model = opts.model;
  const fetchImpl = opts.fetchImpl ?? globalThis.fetch;

  const endpoint = `${baseUrl}/chat/completions`;
  const headers = (): Record<string, string> => ({
    'content-type': 'application/json',
    authorization: `Bearer ${apiKey}`,
  });

  return {
    name,

    async respond(req: ReasoningRequest, signal?: AbortSignal): Promise<ReasoningResponse> {
      if (!apiKey) {
        throw new Error(`openai-compatible(${name}): API key not set`);
      }

      const body = {
        model,
        messages: [
          { role: 'system', content: REASONING_SYSTEM_GUARDRAILS },
          { role: 'user', content: buildReasoningUserPrompt(req) },
        ],
        // Ask for a raw JSON object so the firewall has the cleanest input. Most
        // backends honor this; if one doesn't, the guardrails still ask for JSON and
        // the tolerant parser strips fences — degrade, never break.
        response_format: { type: 'json_object' },
        temperature: 0.8,
        max_tokens: 1024,
      };

      const res = await fetchImpl(endpoint, {
        method: 'POST',
        headers: headers(),
        body: JSON.stringify(body),
        signal: signal ?? null,
      });

      if (!res.ok) {
        throw new Error(`openai-compatible(${name}): HTTP ${res.status} — ${await errorSnippet(res)}`);
      }

      const json = (await res.json()) as ChatCompletionShape;
      const text = json?.choices?.[0]?.message?.content ?? '';
      // THE FIREWALL: validate-and-drop. A bad output yields no intents.
      return { intents: parseReasoningResponse(text) };
    },

    async complete(systemPrompt: string, userPrompt: string, signal?: AbortSignal): Promise<string> {
      if (!apiKey) {
        throw new Error(`openai-compatible(${name}): API key not set`);
      }

      const body = {
        model,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt },
        ],
        response_format: { type: 'json_object' },
        temperature: 0.6,
        max_tokens: 512,
      };

      const res = await fetchImpl(endpoint, {
        method: 'POST',
        headers: headers(),
        body: JSON.stringify(body),
        signal: signal ?? null,
      });

      if (!res.ok) {
        throw new Error(`openai-compatible(${name}): HTTP ${res.status} — ${await errorSnippet(res)}`);
      }

      const json = (await res.json()) as ChatCompletionShape;
      return json?.choices?.[0]?.message?.content ?? '';
    },
  };
}

/**
 * Convenience: an {@link createOpenAiCompatibleProvider} pre-pointed at xAI/Grok. Pass
 * your `XAI_API_KEY` (server-side) and optionally a model id.
 */
export function createGrokProvider(opts: {
  apiKey: string;
  model?: string;
  fetchImpl?: typeof fetch;
}): ReasoningProvider {
  return createOpenAiCompatibleProvider({
    name: 'grok',
    baseUrl: GROK_BASE_URL,
    apiKey: opts.apiKey,
    model: opts.model ?? DEFAULT_GROK_MODEL,
    ...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}),
  });
}
