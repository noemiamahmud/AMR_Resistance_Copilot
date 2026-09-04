/**
 * Phase 4 - the agent loop.
 *
 * Same question as Phase 2, asked a different way. The pipeline hands the model a finished
 * feature payload; here the model is handed a mutation string and nothing else, and has to
 * obtain every number it uses by calling a tool. That is not decoration: it means the trace
 * below the answer is a complete account of the evidence, and an answer that cites a number
 * nobody measured is visibly impossible rather than merely discouraged.
 *
 * Tool turns and the answer turn are deliberately separate calls. Constrained decoding to
 * the answer schema leaves no room for the model to emit a tool call instead, so the loop
 * runs unconstrained with tools, and only the final turn is schema-bound.
 */

import { ChatMessage, ToolCall, chat } from "./ollama";
import { MECHANISM_RULES, RESPONSE_SCHEMA, StructuredReasoning, parseStructuredReasoning } from "./reasoning";
import { MutationParseError, parseMutation } from "./mutation";
import { Toolbox, makeToolbox } from "./tools";
import { resolveTarget } from "./targets";
import { AnalysisError, unknownTargetMessage } from "./analysis";

/** Tool turns before we stop and ask for the answer regardless. */
const MAX_TOOL_TURNS = 6;

export interface ToolCallRecord {
  step: number;
  name: string;
  arguments: Record<string, unknown>;
  result: unknown;
  ok: boolean;
  durationMs: number;
}

export interface AgentRun {
  mutation: string;
  target: { id: string; gene: string; drug: string };
  model: string;
  /** Tool turns actually taken. */
  turns: number;
  latencyMs: number;
  trace: ToolCallRecord[];
  toolsOffered: string[];
  reasoning: StructuredReasoning | null;
  /** Prose fallback if the final schema-bound turn produced nothing usable. */
  text: string | null;
  notes: string[];
}

const AGENT_RULES = [
  MECHANISM_RULES,
  "",
  "You have been given no measurements. Every number you use must come back from a tool.",
  "Call the tools you need - you may call several before answering - and do not state a",
  "distance, confidence or catalogue status you have not measured. If a tool returns an",
  "error, read it and correct the call. When you have enough, stop calling tools and say so.",
].join("\n");

function argumentsOf(call: ToolCall): Record<string, unknown> {
  const args = call.function?.arguments;
  if (args && typeof args === "object") return args as Record<string, unknown>;
  // Some builds hand arguments back as a JSON string rather than an object.
  if (typeof args === "string") {
    try {
      return JSON.parse(args) as Record<string, unknown>;
    } catch {
      return { raw: args };
    }
  }
  return {};
}

async function runToolTurns(
  messages: ChatMessage[],
  toolbox: Toolbox,
  signal: AbortSignal | undefined,
): Promise<{ trace: ToolCallRecord[]; turns: number; model: string; notes: string[] }> {
  const trace: ToolCallRecord[] = [];
  const notes: string[] = [];
  let model = "";
  let turns = 0;

  for (let turn = 0; turn < MAX_TOOL_TURNS; turn++) {
    const reply = await chat(messages, { tools: toolbox.specs, maxTokens: 400, signal });
    model = reply.model;

    if (reply.toolCalls.length === 0) {
      if (trace.length === 0 && turn === 0) {
        // It tried to answer from memory. Say so once; the trace has to be real.
        notes.push("the model tried to answer without measuring; it was asked again");
        messages.push({ role: "assistant", content: reply.content });
        messages.push({
          role: "user",
          content:
            "You have not measured anything yet. Call the tools to obtain the structural " +
            "evidence before you answer.",
        });
        continue;
      }
      messages.push({ role: "assistant", content: reply.content });
      break;
    }

    turns++;
    messages.push({ role: "assistant", content: reply.content, tool_calls: reply.toolCalls });

    for (const call of reply.toolCalls) {
      const name = call.function?.name ?? "";
      const args = argumentsOf(call);
      const started = Date.now();
      const { ok, result } = toolbox.execute(name, args);
      trace.push({
        step: trace.length + 1,
        name,
        arguments: args,
        result,
        ok,
        durationMs: Date.now() - started,
      });
      messages.push({ role: "tool", tool_name: name, content: JSON.stringify(result) });
    }
  }

  if (trace.length === 0) notes.push("the model never called a tool");
  return { trace, turns, model, notes };
}

export async function runAgent(
  input: string,
  options: { signal?: AbortSignal; targetId?: string | null } = {},
): Promise<AgentRun> {
  const parsed = parseMutation(input); // throws MutationParseError
  const target = resolveTarget(options.targetId, parsed.gene);
  if (!target) throw new AnalysisError(unknownTargetMessage(parsed.gene ?? options.targetId));

  const started = Date.now();
  const toolbox = await makeToolbox(target);
  const messages: ChatMessage[] = [
    { role: "system", content: AGENT_RULES },
    {
      role: "user",
      content:
        `Assess ${target.gene} ${parsed.canonical} in ${target.organism} against ${target.drug}. ` +
        `Residue numbers are in catalogue numbering. The substitution replaces ` +
        `${parsed.wildType} with ${parsed.mutant} at residue ${parsed.clinicalResnum}. ` +
        "Gather the structural evidence, then give the mechanistic hypothesis.",
    },
  ];

  const { trace, turns, model, notes } = await runToolTurns(messages, toolbox, options.signal);

  // The answer turn: no tools, schema-bound, with every tool result still in view.
  const final = await chat(
    [
      ...messages,
      {
        role: "user",
        content:
          "Now give your answer as JSON, using only what the tools returned. " +
          "Cite the measurements you relied on inside the mechanism text.",
      },
    ],
    { schema: RESPONSE_SCHEMA, maxTokens: 700, signal: options.signal },
  );

  const parsedAnswer = parseStructuredReasoning(final.content);

  return {
    mutation: parsed.canonical,
    target: { id: target.id, gene: target.gene, drug: target.drug },
    model: model || final.model,
    turns,
    latencyMs: Date.now() - started,
    trace,
    toolsOffered: toolbox.names,
    reasoning: parsedAnswer.reasoning,
    text: parsedAnswer.reasoning ? null : final.content.trim() || null,
    notes: [...notes, ...parsedAnswer.notes],
  };
}

export { MutationParseError, AnalysisError };
