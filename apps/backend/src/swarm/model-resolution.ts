import { getModel, type Model } from "@mariozechner/pi-ai";
import type { ModelRegistry } from "@mariozechner/pi-coding-agent";
import { listSwarmModelPresetDescriptors } from "./model-presets.js";
import type { AgentModelDescriptor, SwarmModelPreset } from "./types.js";

export interface ModelAvailabilityHint {
  preset: SwarmModelPreset;
  descriptor: AgentModelDescriptor;
  available: boolean;
}

export interface ModelResolutionMeta {
  requested: AgentModelDescriptor;
  resolvedModel: AgentModelDescriptor | null;
  strategy: "registry_exact" | "catalog_exact" | "fallback_exact" | "unresolved";
  reason: string;
  available: ModelAvailabilityHint[];
}

export function resolveModelWithMeta(
  modelRegistry: ModelRegistry,
  requested: AgentModelDescriptor,
  fallbackDescriptor?: AgentModelDescriptor
): { resolvedModel: Model<any> | undefined; resolutionMeta: ModelResolutionMeta } {
  const available = getModelAvailabilityHints(modelRegistry);

  const direct = modelRegistry.find(requested.provider, requested.modelId);
  if (direct) {
    return {
      resolvedModel: direct,
      resolutionMeta: {
        requested,
        resolvedModel: requested,
        strategy: "registry_exact",
        reason: "Resolved by exact provider/model match from runtime model registry.",
        available
      }
    };
  }

  const fromCatalog = getModel(requested.provider as any, requested.modelId as any);
  if (fromCatalog) {
    return {
      resolvedModel: fromCatalog,
      resolutionMeta: {
        requested,
        resolvedModel: requested,
        strategy: "catalog_exact",
        reason: "Resolved by exact provider/model match from static model catalog.",
        available
      }
    };
  }

  const normalizedFallback = normalizeDescriptor(fallbackDescriptor);
  if (normalizedFallback && !sameDescriptor(normalizedFallback, requested)) {
    const fallbackModel =
      modelRegistry.find(normalizedFallback.provider, normalizedFallback.modelId) ??
      getModel(normalizedFallback.provider as any, normalizedFallback.modelId as any);

    if (fallbackModel) {
      return {
        resolvedModel: fallbackModel,
        resolutionMeta: {
          requested,
          resolvedModel: normalizedFallback,
          strategy: "fallback_exact",
          reason:
            `Requested model ${toModelSlug(requested)} is unavailable. ` +
            `Falling back to configured default ${toModelSlug(normalizedFallback)}.`,
          available
        }
      };
    }
  }

  return {
    resolvedModel: undefined,
    resolutionMeta: {
      requested,
      resolvedModel: null,
      strategy: "unresolved",
      reason:
        `Requested model ${toModelSlug(requested)} could not be resolved and no configured fallback was available.`,
      available
    }
  };
}

export function getModelAvailabilityHints(modelRegistry: ModelRegistry): ModelAvailabilityHint[] {
  return listSwarmModelPresetDescriptors().map(({ preset, descriptor }) => ({
    preset,
    descriptor,
    available:
      Boolean(modelRegistry.find(descriptor.provider, descriptor.modelId)) ||
      Boolean(getModel(descriptor.provider as any, descriptor.modelId as any))
  }));
}

function sameDescriptor(left: AgentModelDescriptor, right: AgentModelDescriptor): boolean {
  return left.provider === right.provider && left.modelId === right.modelId;
}

function normalizeDescriptor(
  descriptor: AgentModelDescriptor | undefined
): AgentModelDescriptor | undefined {
  if (!descriptor) {
    return undefined;
  }

  return {
    provider: descriptor.provider,
    modelId: descriptor.modelId,
    thinkingLevel: descriptor.thinkingLevel
  };
}

function toModelSlug(descriptor: Pick<AgentModelDescriptor, "provider" | "modelId">): string {
  return `${descriptor.provider}/${descriptor.modelId}`;
}
