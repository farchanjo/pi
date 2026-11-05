import { describe, expect, it, beforeEach } from "vitest";
import {
	planResponsesChain,
	resetResponsesChainsForTest,
} from "../src/api/openai-responses.ts";

const compat = { supportsStatefulStore: true } as never;
const off = { supportsStatefulStore: false } as never;

const user = (text: string) => ({ role: "user", content: [{ type: "input_text", text }] });
const assistant = (text: string) => ({ role: "assistant", content: [{ type: "output_text", text }] });

describe("planResponsesChain", () => {
	beforeEach(() => resetResponsesChainsForTest());

	it("stays stateless when the provider does not opt in", () => {
		const first = planResponsesChain("s1", [user("a")], off, false);
		expect(first.stateful).toBe(false);
		expect(first.previousResponseId).toBeUndefined();
		expect(first.input).toEqual([user("a")]);
	});

	it("stays stateless without a session id", () => {
		const plan = planResponsesChain(undefined, [user("a")], compat, false);
		expect(plan.stateful).toBe(false);
		expect(plan.previousResponseId).toBeUndefined();
	});

	it("stays stateless when stateful mode is disabled (harmony/background)", () => {
		const plan = planResponseChainDisabled();
		expect(plan.stateful).toBe(false);
	});

	it("sends everything on the first turn and chains afterwards", () => {
		const turn1 = [user("ALPHA")];
		const first = planResponsesChain("s2", turn1, compat, false);
		expect(first.stateful).toBe(true);
		expect(first.previousResponseId).toBeUndefined();
		expect(first.input).toEqual(turn1);

		first.commit("resp_1");

		const turn2 = [...turn1, assistant("ALPHA"), user("BETA")];
		const second = planResponsesChain("s2", turn2, compat, false);
		expect(second.stateful).toBe(true);
		expect(second.previousResponseId).toBe("resp_1");
		// The server already stored the assistant turn, so the delta carries only
		// the new user item -- the duplication this patch removed.
		expect(second.input).toEqual([user("BETA")]);
	});

	it("falls back to the full transcript when the prefix was edited or compacted", () => {
		const turn1 = [user("ALPHA")];
		const first = planResponsesChain("s3", turn1, compat, false);
		first.commit("resp_2");

		const edited = [user("ALPHA edited"), assistant("ALPHA"), user("BETA")];
		const second = planResponsesChain("s3", edited, compat, false);
		expect(second.stateful).toBe(true);
		expect(second.previousResponseId).toBeUndefined();
		expect(second.input).toEqual(edited);
	});

	it("falls back when the expected assistant slot is missing", () => {
		const turn1 = [user("ALPHA")];
		planResponsesChain("s4", turn1, compat, false).commit("resp_3");

		const noAssistant = [user("ALPHA"), user("BETA")];
		const second = planResponsesChain("s4", noAssistant, compat, false);
		expect(second.previousResponseId).toBeUndefined();
		expect(second.input).toEqual(noAssistant);
	});

	it("drops the chain when the turn produced no response id", () => {
		const turn1 = [user("ALPHA")];
		planResponsesChain("s5", turn1, compat, false).commit("resp_4");

		const turn2 = [...turn1, assistant("ALPHA"), user("BETA")];
		expect(planResponsesChain("s5", turn2, compat, false).previousResponseId).toBe("resp_4");

		// A turn that fails to commit must not leave a stale reference behind.
		const turn3 = [...turn2, assistant("BETA"), user("GAMMA")];
		planResponsesChain("s5", turn3, compat, false).commit(undefined);
		const turn4 = [...turn3, assistant("GAMMA"), user("DELTA")];
		const afterDrop = planResponsesChain("s5", turn4, compat, false);
		expect(afterDrop.previousResponseId).toBeUndefined();
		expect(afterDrop.input).toEqual(turn4);
	});

	it("never sends an empty delta when only the assistant turn was appended", () => {
		const turn1 = [user("ALPHA")];
		planResponsesChain("s6", turn1, compat, false).commit("resp_5");

		const onlyAssistant = [...turn1, assistant("ALPHA")];
		const second = planResponsesChain("s6", onlyAssistant, compat, false);
		expect(second.previousResponseId).toBeUndefined();
		expect(second.input).toEqual(onlyAssistant);
	});

	it("keeps sessions independent", () => {
		const a = [user("one")];
		planResponsesChain("sA", a, compat, false).commit("resp_A");
		const b = [user("two")];
		planResponsesChain("sB", b, compat, false).commit("resp_B");

		const a2 = planResponsesChain("sA", [...a, assistant("one"), user("more")], compat, false);
		const b2 = planResponsesChain("sB", [...b, assistant("two"), user("more")], compat, false);
		expect(a2.previousResponseId).toBe("resp_A");
		expect(b2.previousResponseId).toBe("resp_B");
	});
});

function planResponseChainDisabled() {
	return planResponsesChain("sDisabled", [user("a")], compat, true);
}
