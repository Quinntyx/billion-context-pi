import { defaultCountTokens } from "acp-kernel";
import type { ExtensionAPI, SessionMessageEntry } from "@earendil-works/pi-coding-agent";
import { IMAGE_TOKEN_COST, modelSupportsImages } from "./tokens.js";

type Message = SessionMessageEntry["message"];
type Tool = Pick<ReturnType<ExtensionAPI["getAllTools"]>[number], "name" | "description" | "parameters">;
type System = { role: "system"; content?: unknown; sections?: Record<string, string | null>; toolsAdded?: Tool[] };

export function activeToolDefinitions(pi: ExtensionAPI): Tool[] {
  if (typeof pi.getAllTools !== "function" || typeof pi.getActiveTools !== "function") return [];
  const active = new Set(pi.getActiveTools());
  return pi.getAllTools().filter(tool => active.has(tool.name));
}

export function toolDefinitionTokens(tools: readonly Tool[]): number {
  return tools.reduce((sum, tool) => sum + defaultCountTokens(JSON.stringify({ name: tool.name, description: tool.description, parameters: tool.parameters })), 0);
}

function contentTokens(content: unknown, vision: boolean): number {
  if (typeof content === "string") return defaultCountTokens(content);
  if (!Array.isArray(content)) return 0;
  return content.reduce((sum: number, block: { type?: string; text?: string; thinking?: string; name?: string; arguments?: unknown }) => {
    if (block.type === "image") return sum + (vision ? IMAGE_TOKEN_COST : 0);
    if (block.type === "toolCall") return sum + defaultCountTokens(JSON.stringify({ name: block.name, arguments: block.arguments }));
    return sum + defaultCountTokens(block.text ?? block.thinking ?? "");
  }, 0);
}

export function estimateOutboundTokens(messages: readonly Message[], systemPrompt: string, model: unknown, tools: readonly Tool[]): number {
  const vision = modelSupportsImages(model);
  const systems = messages.filter(message => (message as { role: string }).role === "system") as unknown as System[];
  let tokens = 0;
  for (const message of messages) {
    const payload = message as { content?: unknown; output?: string; summary?: string };
    tokens += contentTokens(payload.content ?? payload.output ?? payload.summary, vision);
    if ((message as { role: string }).role === "system") {
      const system = message as unknown as System;
      for (const section of Object.values(system.sections ?? {})) tokens += defaultCountTokens(section ?? "");
      tokens += toolDefinitionTokens(system.toolsAdded ?? []);
    }
  }
  if (systems.length === 0) tokens += defaultCountTokens(systemPrompt) + toolDefinitionTokens(tools);
  return tokens;
}
