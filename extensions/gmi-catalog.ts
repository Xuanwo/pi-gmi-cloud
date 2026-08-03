/**
 * Pure GMI catalog mapping helpers.
 * Kept free of pi runtime imports so unit tests can import this module directly.
 */

export type ModelApi = "openai-completions" | "openai-responses";

export type ProviderModelConfig = {
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

export type GmiPricing = {
	prompt?: string | number;
	completion?: string | number;
	input_cache_read?: string | number;
	input_cache_write?: string | number;
};

export type GmiModel = {
	id?: string;
	name?: string;
	object?: string;
	context_length?: number;
	pricing?: GmiPricing;
};

export function perMillion(value: string | number | undefined): number {
	const n = typeof value === "number" ? value : Number(value ?? 0);
	if (!Number.isFinite(n) || n <= 0) return 0;
	// GMI returns USD per token; pi tracks USD per million tokens.
	return n * 1_000_000;
}

export function modelId(raw: GmiModel): string | undefined {
	const id = typeof raw.id === "string" ? raw.id.trim() : "";
	if (id && id !== "model") return id;
	const object = typeof raw.object === "string" ? raw.object.trim() : "";
	if (object && object !== "model") return object;
	return undefined;
}

export function looksReasoning(id: string, name: string): boolean {
	const text = `${id} ${name}`.toLowerCase();
	return (
		/thinking|reason|\br1\b|opus|sonnet|fable/.test(text) ||
		/gpt-5(?!\s)/.test(text) ||
		/deepseek-v4-pro|kimi-k2\.(?:[5-9]|\d{2})|kimi-k3|grok|gemini-3|glm-5|qwen3\.(?:[5-9]|\d{2})|hy3|minimax-m3|mimo-v2\.5-pro/.test(
			text,
		)
	);
}

export function looksMultimodal(id: string, name: string): boolean {
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
export function selectApi(id: string): ModelApi {
	const lower = id.toLowerCase();
	if (/^openai\/(?!gpt-oss)(gpt-|o[1-9])/.test(lower)) {
		return "openai-responses";
	}
	return "openai-completions";
}

export function modelCompat(id: string, api: ModelApi): ProviderModelConfig["compat"] {
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

export function toProviderModel(raw: GmiModel): ProviderModelConfig | undefined {
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

export function mapGmiCatalog(rows: GmiModel[]): ProviderModelConfig[] {
	return rows
		.map(toProviderModel)
		.filter((model): model is ProviderModelConfig => model !== undefined)
		.sort((a, b) => a.id.localeCompare(b.id));
}
