import { homedir } from 'node:os'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { createConfig } from '../config.js'

const MANAGED_ENV_KEYS = [
  'NODE_ENV',
  'SWARM_ROOT_DIR',
  'SWARM_DATA_DIR',
  'SWARM_AUTH_FILE',
  'SWARM_HOST',
  'SWARM_PORT',
  'SHUVLR_HOST',
  'SHUVLR_PORT',
  'SHUVLR_DATA_DIR',
  'SHUVLR_AUTH_TOKEN',
  'SHUVLR_ALLOWED_ORIGINS',
  'SHUVLR_DEFAULT_MODEL_PRESET',
  'SHUVLR_CODEX_SANDBOX_MODE',
  'SHUVLR_CODEX_APPROVAL_POLICY',
  'SWARM_DEBUG',
  'SWARM_ALLOW_NON_MANAGER_SUBSCRIPTIONS',
  'SWARM_MANAGER_ID',
  'SWARM_DEFAULT_CWD',
  'SWARM_MODEL_PROVIDER',
  'SWARM_MODEL_ID',
  'SWARM_THINKING_LEVEL',
  'SWARM_CWD_ALLOWLIST_ROOTS',
] as const

async function withEnv(
  overrides: Partial<Record<(typeof MANAGED_ENV_KEYS)[number], string>>,
  run: () => Promise<void> | void,
) {
  const previous = new Map<string, string | undefined>()

  for (const key of MANAGED_ENV_KEYS) {
    previous.set(key, process.env[key])
    delete process.env[key]
  }

  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) {
      delete process.env[key]
    } else {
      process.env[key] = value
    }
  }

  try {
    await run()
  } finally {
    for (const [key, value] of previous.entries()) {
      if (value === undefined) {
        delete process.env[key]
      } else {
        process.env[key] = value
      }
    }
  }
}

describe('createConfig', () => {
  it('uses fixed defaults for non-host/port config', async () => {
    await withEnv({}, () => {
      const config = createConfig()

      expect(config.host).toBe('127.0.0.1')
      expect(config.port).toBe(47187)
      expect(config.debug).toBe(true)
      expect(config.allowNonManagerSubscriptions).toBe(true)
      expect(config.managerId).toBeUndefined()
      expect(config.defaultModel).toEqual({
        provider: 'openai-codex',
        modelId: 'gpt-5.3-codex',
        thinkingLevel: 'xhigh',
      })
      expect(config.defaultModelPreset).toBe('pi-codex')
      expect(config.codexSandboxMode).toBe('danger-full-access')
      expect(config.codexApprovalPolicy).toBe('auto_accept')

      expect(config.paths.dataDir).toBe(resolve(homedir(), '.shuvlr'))
      expect(config.paths.swarmDir).toBe(resolve(homedir(), '.shuvlr', 'swarm'))
      expect(config.paths.sessionsDir).toBe(resolve(homedir(), '.shuvlr', 'sessions'))
      expect(config.paths.uploadsDir).toBe(resolve(homedir(), '.shuvlr', 'uploads'))
      expect(config.paths.authDir).toBe(resolve(homedir(), '.shuvlr', 'auth'))
      expect(config.paths.authFile).toBe(resolve(homedir(), '.shuvlr', 'auth', 'auth.json'))
      expect(config.paths.managerAgentDir).toBe(resolve(homedir(), '.shuvlr', 'agent', 'manager'))
      expect(config.paths.repoArchetypesDir).toBe(resolve(config.paths.rootDir, '.swarm', 'archetypes'))
      expect(config.paths.memoryDir).toBe(resolve(homedir(), '.shuvlr', 'memory'))
      expect(config.paths.memoryFile).toBeUndefined()
      expect(config.paths.repoMemorySkillFile).toBe(resolve(config.paths.rootDir, '.swarm', 'skills', 'memory', 'SKILL.md'))
      expect(config.paths.agentsStoreFile).toBe(resolve(homedir(), '.shuvlr', 'swarm', 'agents.json'))
      expect(config.paths.secretsFile).toBe(resolve(homedir(), '.shuvlr', 'secrets.json'))
      expect(config.paths.schedulesFile).toBeUndefined()

      expect(config.defaultCwd).toBe(config.paths.rootDir)
      expect(config.cwdAllowlistRoots).toContain(config.paths.rootDir)
      expect(config.cwdAllowlistRoots).toContain(resolve(homedir(), 'worktrees'))
    })
  })

  it('respects SHUVLR host/port/auth/cors settings', async () => {
    await withEnv(
      {
        SHUVLR_HOST: '0.0.0.0',
        SHUVLR_PORT: '9999',
        SHUVLR_AUTH_TOKEN: 'secret-token',
        SHUVLR_ALLOWED_ORIGINS: 'https://app.shuvlr.dev, http://localhost:47188',
        SHUVLR_DEFAULT_MODEL_PRESET: 'pi-opus',
        SHUVLR_CODEX_SANDBOX_MODE: 'workspace-write',
        SHUVLR_CODEX_APPROVAL_POLICY: 'deny_file_changes',
      },
      () => {
        const config = createConfig()
        expect(config.host).toBe('0.0.0.0')
        expect(config.port).toBe(9999)
        expect(config.authToken).toBe('secret-token')
        expect(config.allowedOrigins).toEqual(['https://app.shuvlr.dev', 'http://localhost:47188'])
        expect(config.defaultModelPreset).toBe('pi-opus')
        expect(config.defaultModel).toEqual({
          provider: 'anthropic',
          modelId: 'claude-opus-4-6',
          thinkingLevel: 'xhigh',
        })
        expect(config.codexSandboxMode).toBe('workspace-write')
        expect(config.codexApprovalPolicy).toBe('deny_file_changes')
      },
    )
  })

  it('supports SHUVLR_DATA_DIR override and validates malformed input', async () => {
    await withEnv({ SHUVLR_DATA_DIR: '/tmp/custom-shuvlr-data' }, () => {
      const config = createConfig()
      expect(config.paths.dataDir).toBe('/tmp/custom-shuvlr-data')
      expect(config.paths.authFile).toBe('/tmp/custom-shuvlr-data/auth/auth.json')
    })

    await withEnv({ SHUVLR_PORT: 'nope' }, () => {
      expect(() => createConfig()).toThrow('SHUVLR_PORT must be a positive integer')
    })

    await withEnv({ SHUVLR_CODEX_SANDBOX_MODE: 'invalid' }, () => {
      expect(() => createConfig()).toThrow('SHUVLR_CODEX_SANDBOX_MODE must be one of')
    })

    await withEnv({ SHUVLR_CODEX_APPROVAL_POLICY: 'invalid' }, () => {
      expect(() => createConfig()).toThrow('SHUVLR_CODEX_APPROVAL_POLICY must be one of')
    })
  })

  it('ignores removed SWARM_* env vars', async () => {
    await withEnv(
      {
        NODE_ENV: 'development',
        SWARM_ROOT_DIR: '/tmp/swarm-root',
        SWARM_DATA_DIR: '/tmp/swarm-data',
        SWARM_AUTH_FILE: '/tmp/swarm-auth/auth.json',
        SWARM_DEBUG: 'false',
        SWARM_ALLOW_NON_MANAGER_SUBSCRIPTIONS: 'false',
        SWARM_MANAGER_ID: 'opus-manager',
        SWARM_DEFAULT_CWD: '/tmp/swarm-cwd',
        SWARM_MODEL_PROVIDER: 'anthropic',
        SWARM_MODEL_ID: 'claude-opus-4-6',
        SWARM_THINKING_LEVEL: 'low',
        SWARM_CWD_ALLOWLIST_ROOTS: '/tmp/swarm-allowlist',
      },
      () => {
        const config = createConfig()

        expect(config.paths.dataDir).toBe(resolve(homedir(), '.shuvlr'))
        expect(config.paths.authFile).toBe(resolve(homedir(), '.shuvlr', 'auth', 'auth.json'))
        expect(config.debug).toBe(true)
        expect(config.allowNonManagerSubscriptions).toBe(true)
        expect(config.managerId).toBeUndefined()
        expect(config.defaultCwd).toBe(config.paths.rootDir)
        expect(config.defaultModel).toEqual({
          provider: 'openai-codex',
          modelId: 'gpt-5.3-codex',
          thinkingLevel: 'xhigh',
        })
        expect(config.cwdAllowlistRoots).not.toContain('/tmp/swarm-allowlist')
      },
    )
  })
})
