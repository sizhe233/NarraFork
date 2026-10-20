import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import {
	compileDelegationPolicy,
	isRuntimeToolAllowed,
	resolveRuntimePolicy,
} from "@server/services/agent-runtime/policy";
import { getBuiltinRoutine, getBuiltinToolNames } from "../../../builtin-routines";
import { OPTIONAL_TOOLS } from "../index";
import { narratorControlTool } from "../narrator-control";

describe("NarratorControl registration (local patch)", () => {
	test("is an optional tool controlled by the narrator_control routine", () => {
		const routine = getBuiltinRoutine("narrator_control");
		expect(routine?.type).toBe("tool");
		expect(routine?.defaultEnabled).toBeUndefined();
		if (!routine?.tool) throw new Error("narrator_control routine is missing its tool");
		expect(getBuiltinToolNames(routine.tool)).toEqual(["NarratorControl"]);
		expect(OPTIONAL_TOOLS.get("NarratorControl")).toBe(narratorControlTool);
	});

	test("is hidden from every delegated (subagent) policy", () => {
		expect(isRuntimeToolAllowed(resolveRuntimePolicy([]), "NarratorControl")).toBe(true);
		for (const template of ["general", "explore", "plan", "review", "search"]) {
			const policy = resolveRuntimePolicy([compileDelegationPolicy({ template })]);
			expect(isRuntimeToolAllowed(policy, "NarratorControl")).toBe(false);
		}
		// Even a custom definition that lists the tool explicitly stays denied.
		const custom = resolveRuntimePolicy([
			compileDelegationPolicy({
				template: "custom-agent",
				customDefinition: { toolAccess: "custom", customTools: ["NarratorControl"] },
			}),
		]);
		expect(isRuntimeToolAllowed(custom, "NarratorControl")).toBe(false);
	});
});

describe("NarratorControl upstream hook points (source guard)", () => {
	const root = `${import.meta.dir}/../../../../..`;
	const read = (path: string) => readFileSync(`${root}/${path}`, "utf8");

	test("eager execution and read-only classification stay wired", () => {
		expect(read("server/lib/agent/loop.ts")).toMatch(
			/EAGER_EXECUTION_DISABLED_TOOLS = new Set\(\[[\s\S]*?"NarratorControl"/,
		);
		expect(read("server/services/narrator-permission.ts")).toContain(
			'if (toolName === "NarratorControl") return input.action === "list";',
		);
	});
});

describe("NarratorControl argument validation", () => {
	const ctx = { narratorId: "n", userId: "u", locale: "en" } as never;

	test("rejects unknown actions and modes without reaching the service", async () => {
		const bad = await narratorControlTool.execute({ action: "delete", target: "x" }, ctx);
		expect(bad.isError).toBe(true);
		const badMode = await narratorControlTool.execute(
			{ action: "send", target: "x", message: "m", mode: "now" },
			ctx,
		);
		expect(badMode.isError).toBe(true);
		expect(badMode.output).toContain("mode");
	});

	test("send requires a message", async () => {
		const result = await narratorControlTool.execute({ action: "send", target: "x" }, ctx);
		expect(result.isError).toBe(true);
	});
});
