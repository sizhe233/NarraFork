/**
 * LOCAL PATCH (plugin-model-context-window) guard.
 *
 * A plugin model's context window lives only in the plugin provider registry's catalog.
 * `resolveModelContextWindow` never looked there, so every plugin model fell back to
 * DEFAULT_CONTEXT_WINDOW (272k): opencode2api:deepseek-v4.1-flash-free (1M) compacted at
 * 95% of 272k and the context meter showed "254.5K / 272K".
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
	DEFAULT_CONTEXT_WINDOW,
	narraforkDir,
	registerExtraModelSource,
	reloadSettings,
	resolveModelContextWindow,
	saveSettings,
	settings,
} from "@server/lib/settings";
import { findPluginProviderContextWindow } from "./plugin-provider-model-source";
import {
	PluginProviderRegistry,
	type ProviderModelDescriptor,
	type ProviderRegistryRegistration,
} from "./plugin-provider-registry";

const settingsPath = join(narraforkDir, "settings.json");

const noAdapter = () => {
	throw new Error("context-window lookups must not create adapters");
};

function model(id: string, contextWindow?: number): ProviderModelDescriptor {
	return {
		id,
		displayName: id,
		...(contextWindow === undefined ? {} : { contextWindow }),
		capabilities: { tools: true, sessionMode: "stateless" },
	} as ProviderModelDescriptor;
}

function registryWith(
	prefix: string,
	models: ProviderModelDescriptor[],
	overrides: Partial<ProviderRegistryRegistration> = {},
): PluginProviderRegistry {
	const registry = new PluginProviderRegistry();
	registry.register({
		kind: "executable-plugin",
		pluginId: "com.example.ctx",
		localId: "demo",
		providerInstanceId: "com.example.ctx/demo",
		providerPrefix: prefix,
		displayName: "Demo",
		createAdapter: noAdapter,
		...overrides,
	});
	registry.updateModelCatalog("com.example.ctx/demo", models);
	return registry;
}

describe("findPluginProviderContextWindow", () => {
	test("reports the catalog window for the provider's own model only", () => {
		const registry = registryWith("demo", [model("big-free", 1_000_000), model("unknown")]);
		expect(findPluginProviderContextWindow(registry, "demo", "big-free")).toBe(1_000_000);
		expect(findPluginProviderContextWindow(registry, "DEMO", "big-free")).toBe(1_000_000);
		expect(findPluginProviderContextWindow(registry, "demo", "unknown")).toBeUndefined();
		expect(findPluginProviderContextWindow(registry, "demo", "missing")).toBeUndefined();
		expect(findPluginProviderContextWindow(registry, "other", "big-free")).toBeUndefined();
	});

	test("ignores non-plugin registrations", () => {
		const registry = registryWith("demo", [model("big-free", 1_000_000)], {
			kind: "builtin",
			pluginId: undefined,
		});
		expect(findPluginProviderContextWindow(registry, "demo", "big-free")).toBeUndefined();
	});
});

describe("resolveModelContextWindow with an extra model source", () => {
	let dispose: (() => void) | undefined;
	let originalSettingsFile: string;

	beforeEach(() => {
		originalSettingsFile = readFileSync(settingsPath, "utf8");
	});

	afterEach(() => {
		dispose?.();
		dispose = undefined;
		writeFileSync(settingsPath, originalSettingsFile);
		reloadSettings();
	});

	function registerDemo(): void {
		const registry = registryWith("ctxdemo", [model("big-free", 1_000_000)]);
		dispose = registerExtraModelSource("ctx-test", {
			listModels: () => ["ctxdemo:big-free"],
			contextWindow: (provider, bareModel) =>
				findPluginProviderContextWindow(registry, provider, bareModel),
		});
	}

	test("uses the plugin catalog window", () => {
		expect(resolveModelContextWindow("big-free", "ctxdemo")).toEqual({
			contextWindow: DEFAULT_CONTEXT_WINDOW,
			source: "fallback",
		});
		registerDemo();
		expect(resolveModelContextWindow("big-free", "ctxdemo")).toEqual({
			contextWindow: 1_000_000,
			source: "catalog",
		});
		expect(resolveModelContextWindow("ctxdemo:big-free", "ctxdemo").contextWindow).toBe(1_000_000);
		// A model the plugin does not describe keeps the default.
		expect(resolveModelContextWindow("other", "ctxdemo").source).toBe("fallback");
	});

	test("a per-model user override (provider-page binding) still wins", () => {
		// agent.modelContextWindows is a view of local bindings; saving it writes one.
		const draft = structuredClone(settings);
		draft.agent.modelContextWindows = {
			...draft.agent.modelContextWindows,
			"ctxdemo:big-free": 500_000,
		};
		saveSettings(draft);
		registerDemo();
		expect(resolveModelContextWindow("big-free", "ctxdemo")).toEqual({
			contextWindow: 500_000,
			source: "user",
		});
	});

	test("a throwing or nonsensical source is ignored", () => {
		dispose = registerExtraModelSource("ctx-test", {
			listModels: () => [],
			contextWindow: () => {
				throw new Error("broken");
			},
		});
		expect(resolveModelContextWindow("big-free", "ctxdemo").source).toBe("fallback");
		dispose();
		dispose = registerExtraModelSource("ctx-test", {
			listModels: () => [],
			contextWindow: () => -5,
		});
		expect(resolveModelContextWindow("big-free", "ctxdemo").source).toBe("fallback");
	});
});
