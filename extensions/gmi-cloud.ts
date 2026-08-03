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
import {
	mapGmiCatalog,
	type GmiModel,
	type ProviderModelConfig,
} from "./gmi-catalog.ts";

const PROVIDER_ID = "gmi";
const PROVIDER_NAME = "GMI Cloud";
const BASE_URL = "https://api.gmi-serving.com/v1";

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
	return mapGmiCatalog(rows);
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
