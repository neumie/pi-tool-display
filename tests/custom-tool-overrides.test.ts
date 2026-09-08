import assert from "node:assert/strict";
import test from "node:test";
import { createEventBus, createExtensionRuntime, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { loadExtensionFromFactory } from "../node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/loader.js";
import { decorateToolForDisplay } from "../tool-display-api-consumer.js";
import { normalizeToolDisplayConfig } from "../src/config-store.ts";
import { registerToolDisplayOverrides } from "../src/tool-overrides.ts";
import { DEFAULT_TOOL_DISPLAY_CONFIG, type ToolDisplayConfig } from "../src/types.ts";

interface NormalizedCustomToolOverride {
	enabled: boolean;
	kind: "generic" | "mcp";
	outputMode: "hidden" | "summary" | "preview";
}

interface ToolDisplayConfigWithCustomOverrides extends ToolDisplayConfig {
	customToolOverrides: Record<string, NormalizedCustomToolOverride>;
}

interface RenderThemeLike {
	fg(color: string, value: string): string;
	bold(value: string): string;
}

interface RenderComponentLike {
	render(width: number): string[];
}

interface RuntimeTool extends Record<string, unknown> {
	name: string;
	description?: string;
	parameters?: unknown;
	renderCall?: (...args: unknown[]) => RenderComponentLike;
	renderResult?: (...args: unknown[]) => RenderComponentLike;
	execute?: (...args: unknown[]) => unknown;
}

interface ToolEventHandlers {
	session_start?: () => Promise<void> | void;
	before_agent_start?: () => Promise<void> | void;
}

function buildConfigWithCustomOverrides(
	customToolOverrides: Record<string, unknown>,
	overrides: Partial<ToolDisplayConfig> = {},
): ToolDisplayConfig {
	return {
		...DEFAULT_TOOL_DISPLAY_CONFIG,
		...overrides,
		registerToolOverrides: {
			...DEFAULT_TOOL_DISPLAY_CONFIG.registerToolOverrides,
			...overrides.registerToolOverrides,
		},
		customToolOverrides,
	} as ToolDisplayConfig;
}

function createExtensionApiStub(allTools: RuntimeTool[] = [], cloneOnRegister = false): {
	api: ExtensionAPI;
	registeredTools: RuntimeTool[];
	runtimeTools: RuntimeTool[];
	eventHandlers: ToolEventHandlers;
} {
	const registeredTools: RuntimeTool[] = [];
	const eventHandlers: ToolEventHandlers = {};
	const api = {
		registerTool(tool: RuntimeTool): void {
			registeredTools.push(cloneOnRegister ? { ...tool } : tool);
		},
		on(event: keyof ToolEventHandlers, handler: () => Promise<void> | void): void {
			eventHandlers[event] = handler;
		},
		getAllTools(): RuntimeTool[] {
			const names = new Set(allTools.map((tool) => tool.name));
			const defaultBuiltIns: RuntimeTool[] = ["read", "edit"]
				.filter((name) => !names.has(name))
				.map((name) => ({
					name,
					description: `Built-in ${name} tool`,
					sourceInfo: { source: "builtin", path: `<builtin:${name}>` },
				}));
			// Pi's getAllTools() returns metadata copies, not live definitions.
			return [...defaultBuiltIns, ...allTools].map((tool) => ({
				name: tool.name,
				description: tool.description,
				parameters: tool.parameters,
				sourceInfo: tool.sourceInfo,
			}));
		},
	} as unknown as ExtensionAPI;

	return { api, registeredTools, runtimeTools: allTools, eventHandlers };
}

async function runLifecycle(eventHandlers: ToolEventHandlers): Promise<void> {
	await eventHandlers.session_start?.();
	await eventHandlers.before_agent_start?.();
}

function createTheme(): RenderThemeLike {
	return {
		fg: (_color: string, value: string): string => value,
		bold: (value: string): string => value,
	};
}

function renderToText(component: unknown): string {
	const render = component && typeof component === "object"
		? (component as { render?: unknown }).render
		: undefined;
	assert.equal(typeof render, "function", "expected a renderable component");
	return (component as RenderComponentLike)
		.render(120)
		.map((line) => line.trimEnd())
		.join("\n")
		.trim();
}

function renderToolResult(tool: RuntimeTool, text: string, options: Record<string, unknown> = {}): string {
	return renderToolRawResult(
		tool,
		{ content: [{ type: "text", text }], details: {} },
		options,
	);
}

function renderToolRawResult(
	tool: RuntimeTool,
	result: Record<string, unknown>,
	options: Record<string, unknown> = {},
): string {
	assert.equal(typeof tool.renderResult, "function", `expected ${tool.name} to have renderResult`);
	return renderToText(
		tool.renderResult(
			result,
			{ expanded: false, isPartial: false, ...options },
			createTheme(),
		),
	);
}

test("normalizeToolDisplayConfig defaults customToolOverrides to an empty opt-in map", () => {
	const config = normalizeToolDisplayConfig({}) as ToolDisplayConfigWithCustomOverrides;

	assert.deepEqual(config.customToolOverrides, {});
});

test("normalizeToolDisplayConfig normalizes custom tool override shorthand, defaults, and invalid entries", () => {
	const config = normalizeToolDisplayConfig({
		customToolOverrides: {
			ide_find_symbol: true,
			" agent_gateway ": { outputMode: "preview" },
			mcp_gateway: { enabled: true, kind: "mcp", outputMode: "hidden" },
			disabled_tool: false,
			invalid_kind: { enabled: true, kind: "terminal", outputMode: "verbose" },
			read: { enabled: true, kind: "mcp", outputMode: "summary" },
			"": { enabled: true },
			"   ": true,
		},
	}) as ToolDisplayConfigWithCustomOverrides;

	assert.deepEqual(config.customToolOverrides, {
		ide_find_symbol: { enabled: true, kind: "generic", outputMode: "summary" },
		agent_gateway: { enabled: true, kind: "generic", outputMode: "preview" },
		mcp_gateway: { enabled: true, kind: "mcp", outputMode: "hidden" },
		disabled_tool: { enabled: false, kind: "generic", outputMode: "summary" },
		invalid_kind: { enabled: true, kind: "generic", outputMode: "summary" },
	});
});

test("enabled generic custom tool override replaces existing extension renderers and leaves other tools alone", async () => {
	const enabledTool: RuntimeTool = {
		name: "ide_find_symbol",
		description: "Find symbols through an IDE index.",
		parameters: {},
		execute: () => {},
		renderCall: () => ({ render: () => ["RAW ENABLED CALL"] }),
		renderResult: () => ({ render: () => ["RAW ENABLED RESULT"] }),
	};
	const disabledTool: RuntimeTool = {
		name: "disabled_noisy_tool",
		description: "Noisy extension tool that should keep its own renderer while disabled.",
		parameters: {},
		execute: () => {},
		renderCall: () => ({ render: () => ["RAW DISABLED CALL"] }),
		renderResult: () => ({ render: () => ["RAW DISABLED RESULT"] }),
	};
	const unlistedTool: RuntimeTool = {
		name: "unlisted_noisy_tool",
		description: "Noisy extension tool that was not explicitly opted in.",
		parameters: {},
		execute: () => {},
		renderCall: () => ({ render: () => ["RAW UNLISTED CALL"] }),
		renderResult: () => ({ render: () => ["RAW UNLISTED RESULT"] }),
	};
	const config = buildConfigWithCustomOverrides({
		ide_find_symbol: { enabled: true, outputMode: "summary" },
		disabled_noisy_tool: { enabled: false, outputMode: "summary" },
	});
	const { api, eventHandlers } = createExtensionApiStub([enabledTool, disabledTool, unlistedTool]);

	registerToolDisplayOverrides(api, () => config);
	await runLifecycle(eventHandlers);

	const decoratedEnabledTool = decorateToolForDisplay(enabledTool);
	assert.equal(renderToText(decoratedEnabledTool.renderCall?.({ query: "Widget", limit: 5 }, createTheme())), "ide_find_symbol (2 args)");
	assert.equal(renderToolResult(decoratedEnabledTool, "alpha\nbeta\ngamma\n"), "↳ 3 lines returned • Ctrl+O to expand");
	assert.equal(renderToText(disabledTool.renderCall?.({}, createTheme())), "RAW DISABLED CALL");
	assert.equal(renderToolResult(disabledTool, "ignored"), "RAW DISABLED RESULT");
	assert.equal(renderToText(unlistedTool.renderCall?.({}, createTheme())), "RAW UNLISTED CALL");
	assert.equal(renderToolResult(unlistedTool, "ignored"), "RAW UNLISTED RESULT");
});

test("custom tool override defaults kind to generic unless the user chooses mcp", async () => {
	const genericTool: RuntimeTool = {
		name: "remote_gateway",
		description: "Calls a remote integration with plain generic rendering.",
		parameters: {},
		execute: () => {},
	};
	const mcpTool: RuntimeTool = {
		name: "remote_gateway_structured",
		description: "Calls a remote integration with user-selected structured rendering.",
		parameters: {},
		execute: () => {},
	};
	const config = buildConfigWithCustomOverrides({
		remote_gateway: { enabled: true },
		remote_gateway_structured: { enabled: true, kind: "mcp" },
	});
	const { api, eventHandlers } = createExtensionApiStub([genericTool, mcpTool]);

	registerToolDisplayOverrides(api, () => config);
	await runLifecycle(eventHandlers);

	const decoratedGenericTool = decorateToolForDisplay(genericTool);
	const decoratedMcpTool = decorateToolForDisplay(mcpTool);
	assert.equal(renderToText(decoratedGenericTool.renderCall?.({ tool: "read_file", server: "filesystem" }, createTheme())), "remote_gateway (2 args)");
	assert.equal(renderToText(decoratedMcpTool.renderCall?.({ tool: "read_file", server: "filesystem" }, createTheme())), "MCP call filesystem:read_file (2 args)");
});

test("custom generic tool override honors per-tool hidden output mode", async () => {
	const quietTool: RuntimeTool = {
		name: "large_payload_tool",
		description: "Produces huge payloads that the user wants hidden.",
		parameters: {},
		execute: () => {},
	};
	const config = buildConfigWithCustomOverrides({
		large_payload_tool: { enabled: true, outputMode: "hidden" },
	});
	const { api, eventHandlers } = createExtensionApiStub([quietTool]);

	registerToolDisplayOverrides(api, () => config);
	await runLifecycle(eventHandlers);

	const decoratedQuietTool = decorateToolForDisplay(quietTool);
	assert.equal(renderToolResult(decoratedQuietTool, "secret\nnoisy\noutput\n"), "");
});

test("custom tool override can preserve a tool's native call renderer while hiding results", async () => {
	const quietShell: RuntimeTool = {
		name: "quiet_shell",
		description: "Shell tool with a useful native command header.",
		parameters: {},
		execute: () => {},
		renderCall: (args: unknown) => ({ render: () => [`quiet_shell $ ${(args as { command?: string }).command}`] }),
		renderResult: () => ({ render: () => ["RAW RESULT"] }),
	};
	const config = buildConfigWithCustomOverrides({
		quiet_shell: { enabled: true, outputMode: "hidden", preserveCallRenderer: true },
	});
	const { api, eventHandlers } = createExtensionApiStub([quietShell]);

	registerToolDisplayOverrides(api, () => config);
	await runLifecycle(eventHandlers);

	const decoratedQuietShell = decorateToolForDisplay(quietShell);
	assert.equal(renderToText(decoratedQuietShell.renderCall?.({ command: "git status" }, createTheme())), "quiet_shell $ git status");
	assert.equal(renderToolResult(decoratedQuietShell, "noisy output"), "");
});

test("custom MCP tool override preserves a native call renderer while hiding results", async () => {
	const nativeMcp: RuntimeTool = {
		name: "native_mcp",
		description: "MCP proxy with a useful native call header.",
		parameters: {},
		execute: () => {},
		renderCall: () => ({ render: () => ["NATIVE MCP CALL"] }),
		renderResult: () => ({ render: () => ["RAW RESULT"] }),
	};
	const config = buildConfigWithCustomOverrides({
		native_mcp: { enabled: true, kind: "mcp", outputMode: "hidden", preserveCallRenderer: true },
	});
	const { api, eventHandlers } = createExtensionApiStub([nativeMcp]);

	registerToolDisplayOverrides(api, () => config);
	await runLifecycle(eventHandlers);

	const decoratedNativeMcp = decorateToolForDisplay(nativeMcp);
	assert.equal(renderToText(decoratedNativeMcp.renderCall?.({}, createTheme())), "NATIVE MCP CALL");
	assert.equal(renderToolResult(decoratedNativeMcp, "noisy output"), "");
});

test("custom tool overrides ignore missing tools instead of registering phantom tools", async () => {
	const config = buildConfigWithCustomOverrides({
		missing_tool: { enabled: true, outputMode: "summary" },
	});
	const { api, registeredTools, runtimeTools, eventHandlers } = createExtensionApiStub([]);

	registerToolDisplayOverrides(api, () => config);
	await runLifecycle(eventHandlers);

	assert.equal(runtimeTools.some((tool) => tool.name === "missing_tool"), false);
	assert.equal(registeredTools.some((tool) => tool.name === "missing_tool"), false);
});

test("normalizeToolDisplayConfig treats malformed customToolOverrides containers as empty", () => {
	for (const rawCustomOverrides of [null, true, "ide_find_symbol", [], 42]) {
		const config = normalizeToolDisplayConfig({
			customToolOverrides: rawCustomOverrides,
		}) as ToolDisplayConfigWithCustomOverrides;

		assert.deepEqual(config.customToolOverrides, {});
	}
});

test("normalizeToolDisplayConfig preserves supported custom output modes and drops unknown entry fields", () => {
	const config = normalizeToolDisplayConfig({
		customToolOverrides: {
			hidden_tool: { enabled: true, outputMode: "hidden", label: "Ignored Label" },
			summary_tool: { enabled: true, outputMode: "summary", preserveCallRenderer: true, pathFields: ["file_path"] },
			preview_tool: { enabled: true, outputMode: "preview", renderShell: "self" },
		},
	}) as ToolDisplayConfigWithCustomOverrides;

	assert.deepEqual(config.customToolOverrides, {
		hidden_tool: { enabled: true, kind: "generic", outputMode: "hidden" },
		summary_tool: { enabled: true, kind: "generic", outputMode: "summary", preserveCallRenderer: true },
		preview_tool: { enabled: true, kind: "generic", outputMode: "preview" },
	});
});

test("generic custom tool renderCall handles absent, non-object, and nested arguments safely", async () => {
	const argumentProbe: RuntimeTool = {
		name: "argument_probe",
		description: "Noisy extension tool with unpredictable arguments.",
		parameters: {},
		execute: () => {},
	};
	const config = buildConfigWithCustomOverrides({
		argument_probe: { enabled: true, outputMode: "summary" },
	});
	const { api, eventHandlers } = createExtensionApiStub([argumentProbe]);

	registerToolDisplayOverrides(api, () => config);
	await runLifecycle(eventHandlers);

	const decoratedArgumentProbe = decorateToolForDisplay(argumentProbe);
	assert.equal(renderToText(decoratedArgumentProbe.renderCall?.(undefined, createTheme())), "argument_probe (no args)");
	assert.equal(renderToText(decoratedArgumentProbe.renderCall?.(null, createTheme())), "argument_probe (no args)");
	assert.equal(renderToText(decoratedArgumentProbe.renderCall?.("raw string args", createTheme())), "argument_probe (no args)");
	assert.equal(renderToText(decoratedArgumentProbe.renderCall?.(["array", "args"], createTheme())), "argument_probe (no args)");
	assert.equal(
		renderToText(decoratedArgumentProbe.renderCall?.({ path: "src/index.ts", options: { recursive: true }, tags: ["a", "b"] }, createTheme())),
		"argument_probe (3 args)",
	);
});

test("generic custom tool preview mode supports collapsed previews, expanded previews, partial state, and empty text", async () => {
	const previewTool: RuntimeTool = {
		name: "preview_payload_tool",
		description: "Produces output that should be previewed instead of summarized.",
		parameters: {},
		execute: () => {},
	};
	const config = buildConfigWithCustomOverrides(
		{ preview_payload_tool: { enabled: true, outputMode: "preview" } },
		{ previewLines: 2 },
	);
	const { api, eventHandlers } = createExtensionApiStub([previewTool]);

	registerToolDisplayOverrides(api, () => config);
	await runLifecycle(eventHandlers);

	const decoratedPreviewTool = decorateToolForDisplay(previewTool);
	assert.equal(
		renderToolResult(decoratedPreviewTool, "alpha\nbeta\ngamma\ndelta\n"),
		"alpha\nbeta\n... (2 more lines • Ctrl+O to expand)",
	);
	assert.equal(
		renderToolResult(decoratedPreviewTool, "alpha\nbeta\ngamma\ndelta\n", { expanded: true }),
		"alpha\nbeta\ngamma\ndelta",
	);
	assert.equal(renderToolResult(decoratedPreviewTool, "still running", { isPartial: true }), "running...");
	assert.equal(
		renderToolRawResult(decoratedPreviewTool, { content: [{ type: "image", data: "ignored" }], details: {} }),
		"↳ (no output)",
	);
	assert.equal(renderToolRawResult(decoratedPreviewTool, { details: {} }), "↳ (no output)");
});

test("explicit mcp custom tool override interprets MCP proxy argument variants", async () => {
	const customMcpProxy: RuntimeTool = {
		name: "custom_gateway",
		description: "Custom gateway that should render as MCP because the user opted in.",
		parameters: {},
		execute: () => {},
	};
	const config = buildConfigWithCustomOverrides({
		custom_gateway: { enabled: true, kind: "mcp", outputMode: "summary" },
	});
	const { api, eventHandlers } = createExtensionApiStub([customMcpProxy]);

	registerToolDisplayOverrides(api, () => config);
	await runLifecycle(eventHandlers);

	const decoratedCustomMcpProxy = decorateToolForDisplay(customMcpProxy);
	assert.equal(renderToText(decoratedCustomMcpProxy.renderCall?.({}, createTheme())), "MCP status (no args)");
	assert.equal(renderToText(decoratedCustomMcpProxy.renderCall?.({ connect: "filesystem" }, createTheme())), "MCP connect filesystem (1 arg)");
	assert.equal(renderToText(decoratedCustomMcpProxy.renderCall?.({ describe: "read_file", server: "filesystem" }, createTheme())), "MCP describe read_file @filesystem (2 args)");
	assert.equal(renderToText(decoratedCustomMcpProxy.renderCall?.({ search: "browser", server: "exa" }, createTheme())), "MCP search \"browser\" @exa (2 args)");
	assert.equal(renderToText(decoratedCustomMcpProxy.renderCall?.({ server: "filesystem" }, createTheme())), "MCP tools filesystem (1 arg)");
	assert.equal(renderToText(decoratedCustomMcpProxy.renderCall?.({ tool: "read_file", server: "filesystem" }, createTheme())), "MCP call filesystem:read_file (2 args)");
});

test("custom tool override preserves execution contract, parameters, and prepareArguments", async () => {
	const execute = (): string => "executed";
	const prepareArguments = (args: unknown): unknown => args;
	const parameters = { type: "object", properties: { query: { type: "string" } } };
	const contractTool: RuntimeTool = {
		name: "contract_tool",
		description: "Tool with runtime behavior that must survive decoration.",
		parameters,
		execute,
		prepareArguments,
	};
	const config = buildConfigWithCustomOverrides({
		contract_tool: { enabled: true, outputMode: "summary" },
	});
	const { api, eventHandlers } = createExtensionApiStub([contractTool]);

	registerToolDisplayOverrides(api, () => config);
	await runLifecycle(eventHandlers);

	const decoratedContractTool = decorateToolForDisplay(contractTool);
	assert.equal(decoratedContractTool.execute, execute);
	assert.equal(decoratedContractTool.prepareArguments, prepareArguments);
	assert.equal(decoratedContractTool.parameters, parameters);
	assert.equal(typeof decoratedContractTool.renderCall, "function");
	assert.equal(typeof decoratedContractTool.renderResult, "function");
});

test("custom tool is decorated when the extension opts in through the consumer API", async () => {
	const config = buildConfigWithCustomOverrides({
		late_custom_tool: { enabled: true, outputMode: "summary" },
	});
	const { api, eventHandlers } = createExtensionApiStub([]);

	registerToolDisplayOverrides(api, () => config);
	await runLifecycle(eventHandlers);

	const lateTool: RuntimeTool = {
		name: "late_custom_tool",
		description: "Tool registered after lifecycle by another extension.",
		parameters: {},
		execute: () => {},
	};
	const decoratedLateTool = decorateToolForDisplay(lateTool);
	(api as unknown as { registerTool(tool: RuntimeTool): void }).registerTool(decoratedLateTool);

	assert.equal(typeof lateTool.renderCall, "undefined");
	assert.equal(typeof decoratedLateTool.renderCall, "function");
	assert.equal(typeof decoratedLateTool.renderResult, "function");
	assert.equal(renderToText(decoratedLateTool.renderCall?.({ query: "late" }, createTheme())), "late_custom_tool (1 arg)");
});

test("consumer decoration survives Pi registration snapshots", async () => {
	const config = buildConfigWithCustomOverrides({
		hypa_shell: { enabled: true, outputMode: "hidden" },
	});
	const { api, registeredTools, eventHandlers } = createExtensionApiStub([], true);

	registerToolDisplayOverrides(api, () => config);
	await runLifecycle(eventHandlers);

	const hypaShell: RuntimeTool = {
		name: "hypa_shell",
		description: "Run shell commands through Hypa compression.",
		parameters: {},
		execute: () => {},
		renderCall: () => ({ render: () => ["RAW HYPA CALL"] }),
		renderResult: () => ({ render: () => ["RAW HYPA RESULT"] }),
	};
	const decoratedHypaShell = decorateToolForDisplay(hypaShell);
	(api as unknown as { registerTool(tool: RuntimeTool): void }).registerTool(decoratedHypaShell);

	const registeredHypaShell = registeredTools.find((tool) => tool.name === "hypa_shell");
	assert.ok(registeredHypaShell);
	assert.equal(renderToText(registeredHypaShell.renderCall?.({ command: "git status" }, createTheme())), "hypa_shell (1 arg)");
	assert.equal(renderToolResult(registeredHypaShell, "large noisy output"), "");
});

test("consumer decorates distinct tool objects with the same configured name", async () => {
	const config = buildConfigWithCustomOverrides({
		hypa_shell: { enabled: true, outputMode: "hidden" },
	});
	const { api, registeredTools, eventHandlers } = createExtensionApiStub([], true);

	registerToolDisplayOverrides(api, () => config);
	await runLifecycle(eventHandlers);

	for (const nativeCall of ["FIRST NATIVE CALL", "SECOND NATIVE CALL"]) {
		const tool: RuntimeTool = {
			name: "hypa_shell",
			description: "Run shell commands through Hypa compression.",
			parameters: {},
			execute: () => {},
			renderCall: () => ({ render: () => [nativeCall] }),
			renderResult: () => ({ render: () => ["RAW HYPA RESULT"] }),
		};
		(api as unknown as { registerTool(tool: RuntimeTool): void }).registerTool(decorateToolForDisplay(tool));
	}

	const registeredHypaTools = registeredTools.filter((tool) => tool.name === "hypa_shell");
	assert.equal(registeredHypaTools.length, 2);
	for (const registeredTool of registeredHypaTools) {
		assert.equal(renderToText(registeredTool.renderCall?.({ command: "git status" }, createTheme())), "hypa_shell (1 arg)");
		assert.equal(renderToolResult(registeredTool, "large noisy output"), "");
	}
});

test("separate real Pi extension APIs require public opt-in before registration", async () => {
	const runtime = createExtensionRuntime();
	const eventBus = createEventBus();
	const config = buildConfigWithCustomOverrides({
		real_consumer_tool: { enabled: true, outputMode: "hidden" },
	});
	let displayApi: ExtensionAPI | undefined;
	let consumerApi: ExtensionAPI | undefined;
	const cwd = process.cwd();

	const displayExtension = await loadExtensionFromFactory(
		(pi) => {
			displayApi = pi;
			registerToolDisplayOverrides(pi, () => config);
		},
		cwd,
		eventBus,
		runtime,
		"<pi-tool-display>",
	);

	const cooperativeTool: RuntimeTool = {
		name: "real_consumer_tool",
		description: "Tool decorated by a separate extension through the public API.",
		parameters: {},
		execute: () => {},
		renderCall: () => ({ render: () => ["RAW COOPERATIVE CALL"] }),
		renderResult: () => ({ render: () => ["RAW COOPERATIVE RESULT"] }),
	};
	const consumerExtension = await loadExtensionFromFactory(
		(pi) => {
			consumerApi = pi;
			pi.registerTool(decorateToolForDisplay(cooperativeTool) as never);
		},
		cwd,
		eventBus,
		runtime,
		"<consumer-extension>",
	);

	const noncooperatingTool: RuntimeTool = {
		name: "real_noncooperating_tool",
		description: "Tool that does not call the display consumer API.",
		parameters: {},
		execute: () => {},
		renderCall: () => ({ render: () => ["RAW NONCOOPERATING CALL"] }),
		renderResult: () => ({ render: () => ["RAW NONCOOPERATING RESULT"] }),
	};
	const noncooperatingExtension = await loadExtensionFromFactory(
		(pi) => {
			pi.registerTool(noncooperatingTool as never);
		},
		cwd,
		eventBus,
		runtime,
		"<noncooperating-extension>",
	);

	assert.ok(displayApi);
	assert.ok(consumerApi);
	assert.notEqual(displayApi, consumerApi);
	assert.equal(displayExtension.tools.size > 0, true);
	assert.equal(consumerExtension.tools.size, 1);
	assert.equal(noncooperatingExtension.tools.size, 1);

	const registeredCooperativeTool = consumerExtension.tools.get("real_consumer_tool")?.definition as unknown as RuntimeTool;
	assert.ok(registeredCooperativeTool);
	assert.equal(renderToText(registeredCooperativeTool.renderCall?.({}, createTheme())), "real_consumer_tool (no args)");
	assert.equal(renderToolResult(registeredCooperativeTool, "noisy output"), "");
	assert.equal(renderToText(noncooperatingTool.renderCall?.({}, createTheme())), "RAW NONCOOPERATING CALL");

	// Model the SDK's getAllTools() metadata-only boundary: renderers are not
	// available for display to mutate after another extension registers them.
	runtime.getAllTools = () => [
		{
			name: "real_consumer_tool",
			description: cooperativeTool.description,
			parameters: cooperativeTool.parameters,
			sourceInfo: { source: "local", path: "<consumer-extension>" },
		},
	] as never;
	const metadata = consumerApi.getAllTools() as unknown as Array<Record<string, unknown>>;
	assert.equal("renderCall" in (metadata[0] ?? {}), false);
});
