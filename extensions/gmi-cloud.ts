/**
 * GMI Cloud provider with dynamic model discovery.
 *
 * Auth:
 *   - env GMI_API_KEY
 *   - ~/.pi/agent/auth.json provider "gmi"
 *   - /login gmi
 *
 * Catalog:
 *   GET https://api.gmi-serving.com/v1/models
 *   Fetched during extension load (so --list-models works),
 *   and again via refreshModels when the model picker refreshes.
 *
 * Transport (per model):
 *   - openai/gpt-* and openai/o* → openai-responses
 *   - everything else → openai-completions (provider default)
 */

import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { RefreshModelsContext } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const PROVIDER_ID = "gmi";
const PROVIDER_NAME = "GMI Cloud";
const BASE_URL = "https://api.gmi-serving.com/v1";

type ModelApi = "openai-completions" | "openai-responses";

type ProviderModelConfig = {
	id: string;
	name: string;
	api: ModelApi;
	reasoning: boolean;
	input: ("text" | "image")[];
	cost: {
		input: number;
		output: number;
		cacheRead: number;
		cacheWrite: number;
	};
	contextWindow: number;
	maxTokens: number;
	compat?: {
		supportsDeveloperRole?: boolean;
		supportsReasoningEffort?: boolean;
		supportsStore?: boolean;
		maxTokensField?: "max_tokens" | "max_completion_tokens";
	};
};

type GmiPricing = {
	prompt?: string | number;
	completion?: string | number;
	input_cache_read?: string | number;
	input_cache_write?: string | number;
};

type GmiModel = {
	id?: string;
	name?: string;
	object?: string;
	context_length?: number;
	pricing?: GmiPricing;
};

function perMillion(value: string | number | undefined): number {
	const n = typeof value === "number" ? value : Number(value ?? 0);
	if (!Number.isFinite(n) || n <= 0) return 0;
	// GMI returns USD per token; pi tracks USD per million tokens.
	return n * 1_000_000;
}

function modelId(raw: GmiModel): string | undefined {
	const id = typeof raw.id === "string" ? raw.id.trim() : "";
	if (id && id !== "model") return id;
	const object = typeof raw.object === "string" ? raw.object.trim() : "";
	if (object && object !== "model") return object;
	return undefined;
}

function looksReasoning(id: string, name: string): boolean {
	const text = `${id} ${name}`.toLowerCase();
	return (
		/thinking|reason|\br1\b|opus|sonnet|fable/.test(text) ||
		/gpt-5(?!\s)/.test(text) ||
		/deepseek-v4-pro|kimi-k2\.(?:[5-9]|\d{2})|kimi-k3|grok|gemini-3|glm-5|qwen3\.(?:[5-9]|\d{2})|hy3|minimax-m3|mimo-v2\.5-pro/.test(
			text,
		)
	);
}

function looksMultimodal(id: string, name: string): boolean {
	const text = `${id} ${name}`.toLowerCase();
	return (
		/claude|gpt-4o|gpt-5|gemini|gemma-4|kimi-k2\.(?:[5-9]|\d{2})|kimi-k3|grok/.test(text) &&
		!/coder|code-only|tts|embed|clip/.test(text)
	);
}

/**
 * Prefer Responses only for GMI-hosted OpenAI first-party models.
 * Everything else stays on Chat Completions — the broad compatibility path.
 *
 * Matches: openai/gpt-*, openai/o1, openai/o3, openai/o4, ...
 * Skips: openai/gpt-oss-* and any non-openai/* id.
 */
function selectApi(id: string): ModelApi {
	const lower = id.toLowerCase();
	if (/^openai\/(?!gpt-oss)(gpt-|o[1-9])/.test(lower)) {
		return "openai-responses";
	}
	return "openai-completions";
}

function modelCompat(id: string, api: ModelApi): ProviderModelConfig["compat"] {
	if (api === "openai-responses") {
		return {
			// GMI/Codex path is stateless; pi also defaults Responses store:false.
			supportsStore: false,
			supportsReasoningEffort: /\/(gpt-5|o[1-9])/.test(id.toLowerCase()),
		};
	}

	return {
		supportsDeveloperRole: false,
		supportsReasoningEffort: /openai\/gpt-5/i.test(id),
		supportsStore: false,
		maxTokensField: "max_tokens",
	};
}

function toProviderModel(raw: GmiModel): ProviderModelConfig | undefined {
	const id = modelId(raw);
	if (!id) return undefined;

	const name = (typeof raw.name === "string" && raw.name.trim()) || id;
	const api = selectApi(id);
	const contextWindow =
		typeof raw.context_length === "number" && raw.context_length > 0
			? raw.context_length
			: 128000;
	const pricing = raw.pricing ?? {};

	return {
		id,
		name,
		api,
		reasoning: looksReasoning(id, name),
		input: looksMultimodal(id, name) ? ["text", "image"] : ["text"],
		cost: {
			input: perMillion(pricing.prompt),
			output: perMillion(pricing.completion),
			cacheRead: perMillion(pricing.input_cache_read),
			cacheWrite: perMillion(pricing.input_cache_write),
		},
		contextWindow,
		maxTokens: Math.min(Math.max(8192, Math.floor(contextWindow / 4)), 65536),
		compat: modelCompat(id, api),
	};
}

async function resolveApiKey(credentialKey?: string): Promise<string | undefined> {
	if (credentialKey?.trim()) return credentialKey.trim();

	const envKey = process.env.GMI_API_KEY?.trim();
	if (envKey) return envKey;

	// Fallback: read auth.json directly so async factory works before runtime injects credentials.
	try {
		const authPath = join(homedir(), ".pi/agent/auth.json");
		const auth = JSON.parse(await readFile(authPath, "utf8")) as Record<
			string,
			{ type?: string; key?: string }
		>;
		const entry = auth[PROVIDER_ID];
		if (entry?.type === "api_key" && typeof entry.key === "string" && entry.key.trim()) {
			return entry.key.trim();
		}
	} catch {
		// ignore missing/unreadable auth file
	}

	return undefined;
}

async function fetchGmiModels(apiKey: string, signal?: AbortSignal): Promise<ProviderModelConfig[]> {
	const response = await fetch(`${BASE_URL}/models`, {
		headers: {
			Authorization: `Bearer ${apiKey}`,
			Accept: "application/json",
		},
		signal,
	});

	if (!response.ok) {
		const body = await response.text().catch(() => "");
		throw new Error(
			`GMI /v1/models failed: HTTP ${response.status}${body ? ` ${body.slice(0, 200)}` : ""}`,
		);
	}

	const payload = (await response.json()) as { data?: GmiModel[] } | GmiModel[];
	const rows = Array.isArray(payload) ? payload : Array.isArray(payload.data) ? payload.data : [];
	return rows
		.map(toProviderModel)
		.filter((model): model is ProviderModelConfig => model !== undefined)
		.sort((a, b) => a.id.localeCompare(b.id));
}

function register(pi: ExtensionAPI, models: ProviderModelConfig[]) {
	pi.registerProvider(PROVIDER_ID, {
		name: PROVIDER_NAME,
		baseUrl: BASE_URL,
		// Prefer env; auth.json "gmi" is also honored by pi runtime for requests.
		apiKey: "$GMI_API_KEY",
		// Provider default for models that omit api; OpenAI first-party models set openai-responses.
		api: "openai-completions",
		models,
		async refreshModels(context: RefreshModelsContext): Promise<ProviderModelConfig[]> {
			const credentialKey =
				context.credential?.type === "api_key" && typeof context.credential.key === "string"
					? context.credential.key
					: undefined;

			if (!context.allowNetwork || context.signal?.aborted) {
				return models;
			}

			const apiKey = await resolveApiKey(credentialKey);
			if (!apiKey) {
				return models;
			}

			try {
				const refreshed = await fetchGmiModels(apiKey, context.signal);
				if (!context.signal?.aborted && refreshed.length > 0) {
					models = refreshed;
					await context.store.write({
						models: refreshed.map((model) => ({
							id: model.id,
							name: model.name,
							api: model.api,
							provider: PROVIDER_ID,
							baseUrl: BASE_URL,
							reasoning: model.reasoning,
							input: model.input,
							cost: model.cost,
							contextWindow: model.contextWindow,
							maxTokens: model.maxTokens,
							compat: model.compat,
						})),
						checkedAt: Date.now(),
					});
				}
				return models;
			} catch {
				// Keep last good catalog on transient failures.
				return models;
			}
		},
	});
}

export default async function (pi: ExtensionAPI) {
	const apiKey = await resolveApiKey();
	if (!apiKey) {
		// Still register provider shell so /login gmi and later refresh can populate models.
		register(pi, []);
		return;
	}

	try {
		const models = await fetchGmiModels(apiKey);
		register(pi, models);
	} catch (error) {
		// Don't fail all extensions if GMI is temporarily unreachable.
		register(pi, []);
		console.error(
			`[gmi-cloud] failed to load model catalog: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
}
