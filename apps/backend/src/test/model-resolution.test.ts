import { describe, expect, it } from 'vitest'
import { resolveModelWithMeta } from '../swarm/model-resolution.js'
import type { AgentModelDescriptor } from '../swarm/types.js'

function descriptor(provider: string, modelId: string): AgentModelDescriptor {
  return {
    provider,
    modelId,
    thinkingLevel: 'xhigh',
  }
}

describe('model-resolution', () => {
  it('resolves exact model from runtime registry', () => {
    const requested = descriptor('openai-codex', 'gpt-5.3-codex')
    const resolvedModel = { id: 'registry-model' }

    const registry = {
      find: (provider: string, modelId: string) =>
        provider === requested.provider && modelId === requested.modelId ? (resolvedModel as any) : undefined,
    } as any

    const resolved = resolveModelWithMeta(registry, requested, descriptor('anthropic', 'claude-opus-4-6'))

    expect(resolved.resolvedModel).toBe(resolvedModel)
    expect(resolved.resolutionMeta.strategy).toBe('registry_exact')
    expect(resolved.resolutionMeta.resolvedModel).toEqual(requested)
  })

  it('falls back to configured default when requested model is unavailable', () => {
    const requested = descriptor('example-provider', 'missing-model')
    const fallback = descriptor('anthropic', 'claude-opus-4-6')
    const fallbackModel = { id: 'fallback-model' }

    const registry = {
      find: (provider: string, modelId: string) =>
        provider === fallback.provider && modelId === fallback.modelId ? (fallbackModel as any) : undefined,
    } as any

    const resolved = resolveModelWithMeta(registry, requested, fallback)

    expect(resolved.resolvedModel).toBe(fallbackModel)
    expect(resolved.resolutionMeta.strategy).toBe('fallback_exact')
    expect(resolved.resolutionMeta.resolvedModel).toEqual(fallback)
    expect(resolved.resolutionMeta.reason).toContain('Falling back to configured default')
  })

  it('returns unresolved metadata when neither requested nor fallback can be resolved', () => {
    const requested = descriptor('missing-provider', 'missing-model')
    const fallback = descriptor('also-missing', 'missing-fallback')

    const registry = {
      find: () => undefined,
    } as any

    const resolved = resolveModelWithMeta(registry, requested, fallback)

    expect(resolved.resolvedModel).toBeUndefined()
    expect(resolved.resolutionMeta.strategy).toBe('unresolved')
    expect(resolved.resolutionMeta.resolvedModel).toBeNull()
    expect(resolved.resolutionMeta.reason).toContain('could not be resolved')
  })
})
