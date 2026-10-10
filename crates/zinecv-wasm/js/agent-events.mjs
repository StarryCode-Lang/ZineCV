export function emit_agent_delta(runId, text) {
  if (typeof self.__zinecvAgentDelta !== "function") throw new Error("Agent stream sink unavailable");
  self.__zinecvAgentDelta(runId, text);
}
