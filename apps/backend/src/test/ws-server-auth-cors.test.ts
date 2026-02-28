import { EventEmitter } from 'node:events'
import { mkdir, mkdtemp } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import WebSocket from 'ws'
import { describe, expect, it } from 'vitest'
import type { AgentDescriptor, SwarmConfig } from '../swarm/types.js'
import { getScheduleFilePath } from '../scheduler/schedule-storage.js'
import { SwarmWebSocketServer } from '../ws/server.js'

class FakeSwarmManager extends EventEmitter {
  private readonly config: SwarmConfig
  private readonly manager: AgentDescriptor

  constructor(config: SwarmConfig) {
    super()
    this.config = config
    this.manager = {
      agentId: config.managerId ?? 'manager',
      displayName: 'Manager',
      role: 'manager',
      managerId: config.managerId ?? 'manager',
      status: 'idle',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      cwd: config.defaultCwd,
      model: {
        provider: 'openai-codex',
        modelId: 'gpt-5.3-codex',
        thinkingLevel: 'xhigh',
      },
      sessionFile: join(config.paths.sessionsDir, 'manager.jsonl'),
    }
  }

  getConfig(): SwarmConfig {
    return this.config
  }

  listAgents(): AgentDescriptor[] {
    return [this.manager]
  }

  getAgent(agentId: string): AgentDescriptor | undefined {
    return agentId === this.manager.agentId ? this.manager : undefined
  }

  getConversationHistory(): [] {
    return []
  }
}

async function getAvailablePort(): Promise<number> {
  const server = createServer()
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))

  const address = server.address()
  if (!address || typeof address === 'string') {
    await new Promise<void>((resolve) => server.close(() => resolve()))
    throw new Error('Unable to allocate port')
  }

  const port = address.port
  await new Promise<void>((resolve) => server.close(() => resolve()))
  return port
}

async function makeConfig(options?: {
  authToken?: string
  allowedOrigins?: string[]
}): Promise<SwarmConfig> {
  const port = await getAvailablePort()
  const rootDir = await mkdtemp(join(tmpdir(), 'shuvlr-ws-auth-test-'))
  const dataDir = join(rootDir, 'data')
  const swarmDir = join(dataDir, 'swarm')
  const sessionsDir = join(dataDir, 'sessions')
  const uploadsDir = join(dataDir, 'uploads')
  const authDir = join(dataDir, 'auth')
  const agentDir = join(dataDir, 'agent')
  const managerAgentDir = join(agentDir, 'manager')
  const repoArchetypesDir = join(rootDir, '.swarm', 'archetypes')
  const memoryDir = join(dataDir, 'memory')
  const memoryFile = join(memoryDir, 'manager.md')
  const repoMemorySkillFile = join(rootDir, '.swarm', 'skills', 'memory', 'SKILL.md')

  await mkdir(swarmDir, { recursive: true })
  await mkdir(sessionsDir, { recursive: true })
  await mkdir(uploadsDir, { recursive: true })
  await mkdir(authDir, { recursive: true })
  await mkdir(memoryDir, { recursive: true })
  await mkdir(agentDir, { recursive: true })
  await mkdir(managerAgentDir, { recursive: true })
  await mkdir(repoArchetypesDir, { recursive: true })

  return {
    host: '127.0.0.1',
    port,
    debug: false,
    allowNonManagerSubscriptions: false,
    authToken: options?.authToken,
    allowedOrigins: options?.allowedOrigins,
    managerId: 'manager',
    managerDisplayName: 'Manager',
    defaultModelPreset: 'pi-codex',
    defaultModel: {
      provider: 'openai-codex',
      modelId: 'gpt-5.3-codex',
      thinkingLevel: 'xhigh',
    },
    codexSandboxMode: 'danger-full-access',
    codexApprovalPolicy: 'auto_accept',
    defaultCwd: rootDir,
    cwdAllowlistRoots: [rootDir],
    paths: {
      rootDir,
      dataDir,
      swarmDir,
      sessionsDir,
      uploadsDir,
      authDir,
      authFile: join(authDir, 'auth.json'),
      agentDir,
      managerAgentDir,
      repoArchetypesDir,
      memoryDir,
      memoryFile,
      repoMemorySkillFile,
      agentsStoreFile: join(swarmDir, 'agents.json'),
      secretsFile: join(dataDir, 'secrets.json'),
      schedulesFile: getScheduleFilePath(dataDir, 'manager'),
    },
  }
}

describe('ws-server auth + cors hardening', () => {
  it('requires bearer token on HTTP endpoints when configured', async () => {
    const config = await makeConfig({ authToken: 'secret-token' })
    const manager = new FakeSwarmManager(config)
    const server = new SwarmWebSocketServer({
      swarmManager: manager as any,
      host: config.host,
      port: config.port,
      allowNonManagerSubscriptions: config.allowNonManagerSubscriptions,
      authToken: config.authToken,
      allowedOrigins: config.allowedOrigins,
    })

    await server.start()

    try {
      const noAuth = await fetch(`http://${config.host}:${config.port}/api/reboot`, {
        method: 'POST',
      })
      expect(noAuth.status).toBe(401)

      const withAuth = await fetch(`http://${config.host}:${config.port}/api/reboot`, {
        method: 'POST',
        headers: {
          authorization: 'Bearer secret-token',
        },
      })
      expect(withAuth.status).toBe(200)
    } finally {
      await server.stop()
    }
  })

  it('rejects disallowed CORS origins', async () => {
    const config = await makeConfig({
      allowedOrigins: ['https://allowed.example.com'],
    })

    const manager = new FakeSwarmManager(config)
    const server = new SwarmWebSocketServer({
      swarmManager: manager as any,
      host: config.host,
      port: config.port,
      allowNonManagerSubscriptions: config.allowNonManagerSubscriptions,
      authToken: config.authToken,
      allowedOrigins: config.allowedOrigins,
    })

    await server.start()

    try {
      const denied = await fetch(`http://${config.host}:${config.port}/api/reboot`, {
        method: 'POST',
        headers: {
          origin: 'https://denied.example.com',
        },
      })
      expect(denied.status).toBe(403)

      const preflightDenied = await fetch(`http://${config.host}:${config.port}/api/reboot`, {
        method: 'OPTIONS',
        headers: {
          origin: 'https://denied.example.com',
          'access-control-request-method': 'POST',
        },
      })
      expect(preflightDenied.status).toBe(403)

      const allowed = await fetch(`http://${config.host}:${config.port}/api/reboot`, {
        method: 'POST',
        headers: {
          origin: 'https://allowed.example.com',
        },
      })
      expect(allowed.status).toBe(200)
      expect(allowed.headers.get('access-control-allow-origin')).toBe('https://allowed.example.com')
    } finally {
      await server.stop()
    }
  })

  it('enforces auth for websocket handshake with query-param fallback', async () => {
    const config = await makeConfig({ authToken: 'secret-token' })
    const manager = new FakeSwarmManager(config)
    const server = new SwarmWebSocketServer({
      swarmManager: manager as any,
      host: config.host,
      port: config.port,
      allowNonManagerSubscriptions: config.allowNonManagerSubscriptions,
      authToken: config.authToken,
      allowedOrigins: config.allowedOrigins,
    })

    await server.start()

    try {
      const unauthorized = new WebSocket(`ws://${config.host}:${config.port}`)
      const closeCode = await new Promise<number>((resolve) => {
        unauthorized.on('close', (code) => resolve(code))
      })
      expect(closeCode).toBe(1008)

      const authorized = new WebSocket(`ws://${config.host}:${config.port}?authToken=secret-token`)
      await new Promise<void>((resolve, reject) => {
        authorized.once('open', () => resolve())
        authorized.once('error', (error) => reject(error))
      })

      authorized.close()
      await new Promise<void>((resolve) => authorized.once('close', () => resolve()))
    } finally {
      await server.stop()
    }
  })
})
