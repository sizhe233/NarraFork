import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { isRuntimeToolAllowed, resolveRuntimePolicy } from "@server/services/agent-runtime/policy";
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

	test("is hidden from every subagent profile", () => {
		expect(
			isRuntimeToolAllowed(resolveRuntimePolicy({ variant: "primary" }), "NarratorControl"),
		).toBe(true);
		for (const subagentType of ["general", "explore", "plan", "review", "search"]) {
			const policy = resolveRuntimePolicy({ variant: "subagent", subagentType });
			expect(isRuntimeToolAllowed(policy, "NarratorControl")).toBe(false);
		}
	});
});

describe("NarratorControl upstream hook points (source guard)", () => {
	const root = `${import.meta.dir}/../../../../..`;
	const read = (path: string) => readFileSync(`${root}/${path}`, "utf8");

	test("eager execution, read-only classification and origin pass-through stay wired", () => {
		expect(read("server/lib/agent/loop.ts")).toMatch(
			/EAGER_EXECUTION_DISABLED_TOOLS = new Set\(\[[\s\S]*?"NarratorControl"/,
		);
		expect(read("server/services/narrator-permission.ts")).toContain(
			'if (toolName === "NarratorControl") return input.action === "list";',
		);
		expect(read("server/services/narrator-session-state.ts")).toMatch(
			/interface BufferedExecutionIntent \{[\s\S]*?origin\?:/,
		);
		// Both persistence paths for consumed user input must forward the queued origin.
		expect(read("server/services/narrator-session.ts")).toContain(
			"origin: origin ?? accepted.executionIntent?.origin,",
		);
		expect(read("server/services/agent-runtime/orchestrator.ts")).toContain(
			"origin: buffered.executionIntent?.origin,",
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
