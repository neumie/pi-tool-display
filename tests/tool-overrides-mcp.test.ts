import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { decorateMcpToolForDisplay } from "../tool-display-api-consumer.js";
import { isMcpToolCandidate } from "../src/tool-metadata.ts";
import { registerToolDisplayOverrides } from "../src/tool-overrides.ts";
import { DEFAULT_TOOL_DISPLAY_CONFIG, type ToolDisplayConfig } from "../src/types.ts";

interface RenderThemeLike {
	fg(color: string, value: string): string;
	bold(value: string): string;
}

interface RegisteredToolLike {
	name: string;
	description?: string;
	parameters?: unknown;
	promptSnippet?: string;
	promptGuidelines?: string[];
	renderCall?: (...args: unknown[]) => unknown;
	renderResult?: (...args: unknown[]) => unknown;
	execute?: (...args: unknown[]) => unknown;
}

interface ToolEventHandlers {
	session_start?: () => Promise<void> | void;
	before_agent_start?: () => Promise<void> | void;
}

interface RuntimeTool extends Record<string, unknown> {
	name: string;
	description: string;
	parameters?: unknown;
	execute?: (...args: unknown[]) => unknown;
	renderCall?: (...args: unknown[]) => unknown;
	renderResult?: (...args: unknown[]) => unknown;
	promptSnippet?: string;
	promptGuidelines?: string[];
	label?: string;
}

function buildConfig(overrides: Partial<ToolDisplayConfig>): ToolDisplayConfig {
	return {
		...DEFAULT_TOOL_DISPLAY_CONFIG,
		...overrides,
		registerToolOverrides: {
			...DEFAULT_TOOL_DISPLAY_CONFIG.registerToolOverrides,
			...overrides.registerToolOverrides,
		},
	};
}

function withDefaultReadEditOwners(tools: RuntimeTool[] = []): RuntimeTool[] {
	const names = new Set(tools.map((tool) => tool.name));
	const defaults: RuntimeTool[] = ["read", "edit"]
		.filter((name) => !names.has(name))
		.map((name) => ({
			name,
			description: `Built-in ${name} tool`,
			sourceInfo: { source: "builtin", path: `<builtin:${name}>` },
		}));
	return [...defaults, ...tools];
}

function createExtensionApiStub(allTools: RuntimeTool[] = []): {
	api: ExtensionAPI;
	registeredTools: RegisteredToolLike[];
	runtimeTools: RuntimeTool[];
	eventHandlers: ToolEventHandlers;
} {
	const registeredTools: RegisteredToolLike[] = [];
	const eventHandlers: ToolEventHandlers = {};
	const api = {
		registerTool(tool: RegisteredToolLike): void {
			registeredTools.push(tool);
		},
		on(event: keyof ToolEventHandlers, handler: () => Promise<void> | void): void {
			eventHandlers[event] = handler;
		},
		getAllTools(): RuntimeTool[] {
			// Pi returns metadata copies here, not live tool definitions.
			return withDefaultReadEditOwners(allTools).map((tool) => ({
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
	assert.equal(typeof (component as { render?: unknown })?.render, "function", "expected a renderable component");
	return (component as { render: (width: number) => string[] })
		.render(120)
		.map((line) => line.trimEnd())
		.join("\n")
		.trim();
}

function renderToolResult(tool: RuntimeTool, text: string): string {
	assert.equal(typeof tool.renderResult, "function", `expected ${tool.name} to have renderResult`);
	return renderToText(
		tool.renderResult(
			{ content: [{ type: "text", text }], details: {} },
			{ expanded: false, isPartial: false },
			createTheme(),
		),
	);
}

// ─── isMcpToolCandidate unit tests ──────────────────────────────────────────

test("isMcpToolCandidate returns true when name is 'mcp'", () => {
	assert.equal(isMcpToolCandidate({ name: "mcp", description: "unified gateway" }), true);
});

test("isMcpToolCandidate returns true when description contains whole word 'mcp'", () => {
	assert.equal(isMcpToolCandidate({ name: "web_search", description: "MCP tool for web search" }), true);
	assert.equal(isMcpToolCandidate({ name: "web_search", description: "mcp tool for web search" }), true);
	assert.equal(isMcpToolCandidate({ name: "web_search", description: "An MCP-based search" }), true);
});

test("isMcpToolCandidate rejects mcp substrings without a word boundary", () => {
	assert.equal(isMcpToolCandidate({ name: "some_tool", description: "McPherson's tool" }), false);
	assert.equal(isMcpToolCandidate({ name: "some_tool", description: "mcp_test function" }), false);
	assert.equal(isMcpToolCandidate({ name: "some_tool", description: "mcpExample" }), false);
});

test("isMcpToolCandidate recognizes pi-mcp-adapter source metadata", () => {
	assert.equal(
		isMcpToolCandidate({
			name: "xcodebuild_list_sims",
			description: "List available iOS simulators.",
			parameters: {},
			sourceInfo: {
				source: "local",
				path: "C:/Users/Administrator/.pi/agent/extensions/pi-mcp-adapter/index.ts",
			},
		}),
		true,
	);
});

test("isMcpToolCandidate rejects descriptions containing only whitespace", () => {
	assert.equal(isMcpToolCandidate({ name: "random_tool", description: "   " }), false);
});

test("isMcpToolCandidate returns false for missing or non-object candidates", () => {
	assert.equal(isMcpToolCandidate({ name: "random_tool" }), false);
	assert.equal(isMcpToolCandidate({ name: "random_tool", description: "" }), false);
	assert.equal(isMcpToolCandidate(null), false);
	assert.equal(isMcpToolCandidate(undefined), false);
	assert.equal(isMcpToolCandidate("mcp"), false);
});

// ─── Public MCP consumer API ────────────────────────────────────────────────

test("MCP tools are decorated through the public consumer API", async () => {
	const mcpTool: RuntimeTool = {
		name: "mcp",
		description: "Unified MCP gateway for status, discovery, reconnects, and proxy tool calls.",
		parameters: {},
		execute: () => "executed",
	};
	const { api, eventHandlers } = createExtensionApiStub([mcpTool]);

	registerToolDisplayOverrides(api, () => ({ ...DEFAULT_TOOL_DISPLAY_CONFIG, mcpOutputMode: "summary" }));
	await runLifecycle(eventHandlers);

	const decorated = decorateMcpToolForDisplay(mcpTool);
	assert.equal(typeof mcpTool.renderCall, "undefined", "the original definition remains unchanged");
	assert.equal(typeof decorated.renderCall, "function");
	assert.equal(typeof decorated.renderResult, "function");
	assert.equal(decorated.execute, mcpTool.execute);
	assert.equal(renderToText(decorated.renderCall?.({}, createTheme())), "MCP status (no args)");
	assert.equal(renderToolResult(decorated, "one\ntwo\n"), "↳ 2 lines returned • Ctrl+O to expand");
});

test("MCP consumer decoration handles missing execute and parameters", async () => {
	const mcpTool: RuntimeTool = {
		name: "minimal_mcp",
		description: "An MCP tool.",
	};
	const { api } = createExtensionApiStub();
	registerToolDisplayOverrides(api, () => DEFAULT_TOOL_DISPLAY_CONFIG);

	const decorated = decorateMcpToolForDisplay(mcpTool);
	assert.equal(typeof decorated.renderCall, "function");
	assert.equal(typeof decorated.renderResult, "function");
});

test("MCP consumer decoration can be applied repeatedly without lifecycle discovery", async () => {
	const mcpTool: RuntimeTool = {
		name: "mcp",
		description: "An MCP tool.",
		parameters: {},
		execute: () => {},
	};
	const { api, eventHandlers } = createExtensionApiStub();
	registerToolDisplayOverrides(api, () => DEFAULT_TOOL_DISPLAY_CONFIG);
	await runLifecycle(eventHandlers);

	const first = decorateMcpToolForDisplay(mcpTool);
	const second = decorateMcpToolForDisplay(first);
	assert.equal(typeof first.renderCall, "function");
	assert.equal(typeof second.renderCall, "function");
	assert.equal(renderToText(second.renderCall?.({ tool: "read_file", server: "filesystem" }, createTheme())), "MCP call filesystem:read_file (2 args)");
});

test("noncooperating MCP definitions remain unchanged across lifecycle events", async () => {
	const lateMcpTool: RuntimeTool = {
		name: "late_registered_mcp",
		description: "MCP tool registered by another extension.",
		parameters: {},
		execute: () => {},
	};
	const { api, runtimeTools, eventHandlers } = createExtensionApiStub();
	registerToolDisplayOverrides(api, () => DEFAULT_TOOL_DISPLAY_CONFIG);
	await runLifecycle(eventHandlers);
	runtimeTools.push(lateMcpTool);
	await runLifecycle(eventHandlers);

	assert.equal(typeof lateMcpTool.renderCall, "undefined");
	assert.equal(typeof lateMcpTool.renderResult, "undefined");

	const decorated = decorateMcpToolForDisplay(lateMcpTool);
	assert.equal(typeof decorated.renderCall, "function");
});

test("MCP tools registered before lifecycle require explicit consumer decoration", async () => {
	const mcpTools: RuntimeTool[] = [
		{ name: "mcp_user_search", description: "Search users via MCP.", parameters: {}, execute: () => {} },
		{ name: "mcp_db_query", description: "Query database via MCP.", parameters: {}, execute: () => {} },
	];
	const { api, eventHandlers } = createExtensionApiStub(mcpTools);
	registerToolDisplayOverrides(api, () => DEFAULT_TOOL_DISPLAY_CONFIG);
	await eventHandlers.session_start?.();

	for (const tool of mcpTools) {
		assert.equal(typeof tool.renderCall, "undefined");
		assert.equal(typeof decorateMcpToolForDisplay(tool).renderCall, "function");
	}
});

test("MCP renderCall supports status and server-qualified targets", async () => {
	const mcpTool: RuntimeTool = {
		name: "mcp",
		description: "Unified MCP gateway.",
		parameters: {},
		execute: () => {},
	};
	const { api } = createExtensionApiStub();
	registerToolDisplayOverrides(api, () => DEFAULT_TOOL_DISPLAY_CONFIG);
	const decorated = decorateMcpToolForDisplay(mcpTool);

	assert.equal(renderToText(decorated.renderCall?.({}, createTheme())), "MCP status (no args)");
	assert.equal(renderToText(decorated.renderCall?.({ tool: "read_file", server: "filesystem" }, createTheme())), "MCP call filesystem:read_file (2 args)");
});

test("MCP consumer decoration overrides existing renderers and preserves execute", async () => {
	const config = buildConfig({ mcpOutputMode: "summary" });
	const execute = (): string => "executed";
	const mcpTool: RuntimeTool = {
		name: "mcp",
		label: "MCP",
		description: "MCP gateway - connect to MCP servers and call their tools",
		parameters: {},
		execute,
		renderCall: () => ({ render: () => ["RAW MCP CALL"] }),
		renderResult: () => ({ render: () => ["RAW MCP RESULT"] }),
	};
	const { api } = createExtensionApiStub();
	registerToolDisplayOverrides(api, () => config);

	const decorated = decorateMcpToolForDisplay(mcpTool);
	assert.equal(decorated.execute, execute);
	assert.equal(renderToText(decorated.renderCall?.({ tool: "read_file", server: "filesystem" }, createTheme())), "MCP call filesystem:read_file (2 args)");
	assert.equal(renderToolResult(decorated, "line 1\nline 2"), "↳ 2 lines returned • Ctrl+O to expand");
	assert.equal(renderToText(mcpTool.renderCall?.({}, createTheme())), "RAW MCP CALL");
});

test("MCP consumer decoration is independent of built-in ownership config", async () => {
	const config = buildConfig({
		registerToolOverrides: {
			read: false,
			grep: false,
			find: false,
			ls: false,
			bash: false,
			edit: false,
			write: false,
		},
	});
	const mcpTool: RuntimeTool = {
		name: "mcp",
		description: "Unified MCP gateway.",
	};
	const { api } = createExtensionApiStub();
	registerToolDisplayOverrides(api, () => config);
	const decorated = decorateMcpToolForDisplay(mcpTool);
	assert.equal(typeof decorated.renderCall, "function");
});

test("multiple MCP tools receive independent consumer decorations", async () => {
	const tools: RuntimeTool[] = [
		{ name: "filesystem_list", description: "List files via MCP.", parameters: {}, execute: () => {} },
		{ name: "db_query", description: "Query database via MCP.", parameters: {}, execute: () => {} },
		{ name: "web_search", description: "Search via MCP.", parameters: {}, execute: () => {} },
	];
	const { api } = createExtensionApiStub();
	registerToolDisplayOverrides(api, () => DEFAULT_TOOL_DISPLAY_CONFIG);

	for (const tool of tools) {
		const decorated = decorateMcpToolForDisplay(tool);
		assert.equal(typeof decorated.renderCall, "function", `${tool.name} should have renderCall`);
		assert.equal(typeof decorated.renderResult, "function", `${tool.name} should have renderResult`);
	}
});

test("metadata-only getAllTools discovery cannot decorate live MCP definitions", async () => {
	const mcpTool: RuntimeTool = {
		name: "metadata_only_mcp",
		description: "An MCP tool represented only by metadata.",
		parameters: {},
	};
	const { api, runtimeTools, eventHandlers } = createExtensionApiStub([mcpTool]);
	registerToolDisplayOverrides(api, () => DEFAULT_TOOL_DISPLAY_CONFIG);
	await runLifecycle(eventHandlers);

	const metadata = api.getAllTools().find((tool) => tool.name === mcpTool.name);
	assert.ok(metadata);
	assert.equal(typeof (metadata as unknown as Record<string, unknown>).renderCall, "undefined");
	assert.equal(typeof runtimeTools[0]?.renderCall, "undefined");
});

test("display registration tolerates getAllTools throwing", async () => {
	const { api, eventHandlers } = createExtensionApiStub();
	(api as { getAllTools: () => unknown[] }).getAllTools = () => {
		throw new Error("getAllTools failed");
	};

	registerToolDisplayOverrides(api, () => DEFAULT_TOOL_DISPLAY_CONFIG);
	await runLifecycle(eventHandlers);
	assert.ok(true, "built-in registration should not throw when getAllTools fails");
});
