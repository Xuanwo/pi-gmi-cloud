import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	mapGmiCatalog,
	modelCompat,
	modelId,
	perMillion,
	selectApi,
	toProviderModel,
} from "../extensions/gmi-catalog.ts";

describe("selectApi", () => {
	it("routes OpenAI first-party models to Responses", () => {
		for (const id of [
			"openai/gpt-4o",
			"openai/gpt-4o-mini",
			"openai/gpt-5.5",
			"openai/gpt-5.4-nano",
			"openai/gpt-5.3-codex",
			"openai/o3-mini",
			"openai/o1-pro",
			"OpenAI/GPT-5.4",
		]) {
			assert.equal(selectApi(id), "openai-responses", id);
		}
	});

	it("keeps non-OpenAI and open-weight ids on Completions", () => {
		for (const id of [
			"openai/gpt-oss-120b",
			"deepseek-ai/DeepSeek-V4-Pro",
			"anthropic/claude-sonnet-4.6",
			"Qwen/Qwen3.5-27B",
			"moonshotai/Kimi-K2.5",
			"gpt-5.5",
			"google/gemini-3.6-flash",
		]) {
			assert.equal(selectApi(id), "openai-completions", id);
		}
	});
});

describe("perMillion", () => {
	it("converts per-token USD to per-million USD", () => {
		assert.equal(perMillion(0.000001), 1);
		assert.equal(perMillion("0.000002"), 2);
	});

	it("treats missing or non-positive values as zero", () => {
		assert.equal(perMillion(undefined), 0);
		assert.equal(perMillion(0), 0);
		assert.equal(perMillion(-1), 0);
		assert.equal(perMillion("nope"), 0);
	});
});

describe("modelId", () => {
	it("prefers id and falls back to object", () => {
		assert.equal(modelId({ id: "openai/gpt-5.5" }), "openai/gpt-5.5");
		assert.equal(modelId({ id: "model", object: "deepseek-ai/DeepSeek-V4-Flash" }), "deepseek-ai/DeepSeek-V4-Flash");
		assert.equal(modelId({ id: "model", object: "model" }), undefined);
		assert.equal(modelId({}), undefined);
	});
});

describe("toProviderModel", () => {
	it("maps OpenAI models onto Responses with store disabled", () => {
		const model = toProviderModel({
			id: "openai/gpt-5.4-nano",
			name: "GPT-5.4 nano",
			context_length: 400000,
			pricing: {
				prompt: 0.0000002,
				completion: 0.00000125,
				input_cache_read: 0.00000002,
			},
		});

		assert.ok(model);
		assert.equal(model.api, "openai-responses");
		assert.equal(model.reasoning, true);
		assert.deepEqual(model.input, ["text", "image"]);
		assert.equal(model.contextWindow, 400000);
		assert.ok(Math.abs(model.cost.input - 0.2) < 1e-12);
		assert.ok(Math.abs(model.cost.output - 1.25) < 1e-12);
		assert.ok(Math.abs(model.cost.cacheRead - 0.02) < 1e-12);
		assert.equal(model.compat?.supportsStore, false);
		assert.equal(model.compat?.supportsReasoningEffort, true);
	});

	it("maps non-OpenAI models onto Completions defaults", () => {
		const model = toProviderModel({
			id: "deepseek-ai/DeepSeek-V4-Flash",
			context_length: 128000,
			pricing: { prompt: "0.00000014", completion: "0.00000028" },
		});

		assert.ok(model);
		assert.equal(model.api, "openai-completions");
		assert.equal(model.name, "deepseek-ai/DeepSeek-V4-Flash");
		assert.deepEqual(model.input, ["text"]);
		assert.equal(model.compat?.supportsDeveloperRole, false);
		assert.equal(model.compat?.maxTokensField, "max_tokens");
		assert.ok(Math.abs(model.cost.input - 0.14) < 1e-12);
		assert.ok(Math.abs(model.cost.output - 0.28) < 1e-12);
	});
});

describe("modelCompat", () => {
	it("enables reasoning effort only for gpt-5 and o-series on Responses", () => {
		assert.equal(modelCompat("openai/gpt-4o", "openai-responses")?.supportsReasoningEffort, false);
		assert.equal(modelCompat("openai/gpt-5.5", "openai-responses")?.supportsReasoningEffort, true);
		assert.equal(modelCompat("openai/o3-mini", "openai-responses")?.supportsReasoningEffort, true);
	});
});

describe("mapGmiCatalog", () => {
	it("drops invalid rows and sorts by id", () => {
		const models = mapGmiCatalog([
			{ id: "openai/gpt-5.5" },
			{ id: "model", object: "model" },
			{ id: "deepseek-ai/DeepSeek-V4-Flash" },
		]);

		assert.deepEqual(
			models.map((model) => model.id),
			["deepseek-ai/DeepSeek-V4-Flash", "openai/gpt-5.5"],
		);
		assert.equal(models[0]?.api, "openai-completions");
		assert.equal(models[1]?.api, "openai-responses");
	});
});
