import { describe, expect, it, vi } from 'vitest'
import { buildSwarmTools, type SwarmToolHost } from '../swarm/swarm-tools.js'
import type { ShuvdoClient } from '../swarm/shuvdo-client.js'
import type { AgentDescriptor, SendMessageReceipt, SpawnAgentInput } from '../swarm/types.js'

function makeManagerDescriptor(): AgentDescriptor {
  return {
    agentId: 'manager',
    displayName: 'manager',
    role: 'manager',
    managerId: 'manager',
    archetypeId: 'manager',
    status: 'idle',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    cwd: '/tmp/swarm',
    model: {
      provider: 'openai-codex',
      modelId: 'gpt-5.3-codex',
      thinkingLevel: 'xhigh',
    },
    sessionFile: '/tmp/swarm/manager.jsonl',
  }
}

function makeWorkerDescriptor(agentId: string): AgentDescriptor {
  return {
    agentId,
    displayName: agentId,
    role: 'worker',
    managerId: 'manager',
    status: 'idle',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    cwd: '/tmp/swarm',
    model: {
      provider: 'anthropic',
      modelId: 'claude-opus-4-6',
      thinkingLevel: 'xhigh',
    },
    sessionFile: `/tmp/swarm/${agentId}.jsonl`,
  }
}

function makeHost(
  spawnImpl: (callerAgentId: string, input: SpawnAgentInput) => Promise<AgentDescriptor>,
): SwarmToolHost {
  return {
    listAgents(): AgentDescriptor[] {
      return [makeManagerDescriptor()]
    },
    spawnAgent: spawnImpl,
    async killAgent(): Promise<void> {},
    async sendMessage(): Promise<SendMessageReceipt> {
      return {
        targetAgentId: 'worker',
        deliveryId: 'delivery-1',
        acceptedMode: 'prompt',
      }
    },
    async publishToUser(): Promise<{ targetContext: { channel: 'web' } }> {
      return {
        targetContext: { channel: 'web' },
      }
    },
  }
}

function makeShuvdoClient(): ShuvdoClient {
  return {
    createTask: vi.fn(async () => ({ item: { id: 'task-1' } })),
    completeTask: vi.fn(async () => ({ item: { id: 'task-1', done: true } })),
    listTasks: vi.fn(async () => ({ items: [{ id: 'task-1' }] })),
    createReminder: vi.fn(async () => ({ item: { id: 'rem-1' } })),
    listDueReminders: vi.fn(async () => ({ reminders: [{ id: 'rem-1' }] })),
    completeReminder: vi.fn(async () => ({ item: { id: 'rem-1', done: true } })),
    listProjects: vi.fn(async () => ({ projects: [] })),
    createProject: vi.fn(async () => ({ project: { id: 'proj-1' } })),
    showProject: vi.fn(async () => ({ project: { id: 'proj-1' } })),
    updateProject: vi.fn(async () => ({ project: { id: 'proj-1', status: 'active' } })),
    createMilestone: vi.fn(async () => ({ milestone: { id: 'ms-1' } })),
    updateMilestone: vi.fn(async () => ({ milestone: { id: 'ms-1', status: 'done' } })),
    getAgentQueue: vi.fn(async () => ({ tasks: [], reminders: [] })),
  }
}

describe('buildSwarmTools', () => {
  it('propagates spawn_agent model preset to host.spawnAgent', async () => {
    let receivedInput: SpawnAgentInput | undefined

    const host = makeHost(async (_callerAgentId, input) => {
      receivedInput = input
      return makeWorkerDescriptor('worker-opus')
    })

    const tools = buildSwarmTools(host, makeManagerDescriptor())
    const spawnTool = tools.find((tool) => tool.name === 'spawn_agent')
    expect(spawnTool).toBeDefined()

    const result = await spawnTool!.execute(
      'tool-call',
      {
        agentId: 'Worker Opus',
        model: 'pi-opus',
      },
      undefined,
      undefined,
      undefined as any,
    )

    expect(receivedInput?.model).toBe('pi-opus')
    expect(result.details).toMatchObject({
      agentId: 'worker-opus',
      model: {
        provider: 'anthropic',
        modelId: 'claude-opus-4-6',
        thinkingLevel: 'xhigh',
      },
    })
  })

  it('rejects invalid spawn_agent model presets with a clear error', async () => {
    const host = makeHost(async () => makeWorkerDescriptor('worker'))

    const tools = buildSwarmTools(host, makeManagerDescriptor())
    const spawnTool = tools.find((tool) => tool.name === 'spawn_agent')
    expect(spawnTool).toBeDefined()

    await expect(
      spawnTool!.execute(
        'tool-call',
        {
          agentId: 'Worker Invalid',
          model: 'not-allowed-model',
        } as any,
        undefined,
        undefined,
        undefined as any,
      ),
    ).rejects.toThrow('spawn_agent.model must be one of pi-codex|pi-opus|codex-app')
  })

  it('forwards speak_to_user target metadata and returns resolved target context', async () => {
    let receivedTarget:
      | { channel: 'web' | 'slack' | 'telegram'; channelId?: string; userId?: string; threadTs?: string }
      | undefined

    const host: SwarmToolHost = {
      listAgents: () => [makeManagerDescriptor()],
      spawnAgent: async () => makeWorkerDescriptor('worker'),
      killAgent: async () => {},
      sendMessage: async () => ({
        targetAgentId: 'worker',
        deliveryId: 'delivery-1',
        acceptedMode: 'prompt',
      }),
      publishToUser: async (_agentId, _text, _source, targetContext) => {
        receivedTarget = targetContext
        return {
          targetContext: {
            channel: targetContext?.channel ?? 'web',
            channelId: targetContext?.channelId,
            userId: targetContext?.userId,
            threadTs: targetContext?.threadTs,
          },
        }
      },
    }

    const tools = buildSwarmTools(host, makeManagerDescriptor())
    const speakTool = tools.find((tool) => tool.name === 'speak_to_user')
    expect(speakTool).toBeDefined()

    const result = await speakTool!.execute(
      'tool-call',
      {
        text: 'Reply in Slack thread',
        target: {
          channel: 'slack',
          channelId: 'C12345',
          threadTs: '173.456',
        },
      },
      undefined,
      undefined,
      undefined as any,
    )

    expect(receivedTarget).toEqual({
      channel: 'slack',
      channelId: 'C12345',
      threadTs: '173.456',
    })
    expect(result.details).toMatchObject({
      published: true,
      targetContext: {
        channel: 'slack',
        channelId: 'C12345',
        threadTs: '173.456',
      },
    })
  })

  it('only exposes shuvdo tools to manager runtimes when client is configured', () => {
    const host = makeHost(async () => makeWorkerDescriptor('worker'))
    const shuvdoClient = makeShuvdoClient()

    const managerTools = buildSwarmTools(host, makeManagerDescriptor(), { shuvdoClient })
    const workerTools = buildSwarmTools(host, makeWorkerDescriptor('worker-x'), { shuvdoClient })
    const managerToolNames = managerTools.map((tool) => tool.name)
    const workerToolNames = workerTools.map((tool) => tool.name)

    expect(managerToolNames).toContain('create_task')
    expect(managerToolNames).toContain('complete_reminder')
    expect(managerToolNames).toContain('get_agent_queue')
    expect(workerToolNames).not.toContain('create_task')
  })

  it('maps shuvdo tool parameters to expected client endpoints', async () => {
    const host = makeHost(async () => makeWorkerDescriptor('worker'))
    const shuvdoClient = makeShuvdoClient()

    const tools = buildSwarmTools(host, makeManagerDescriptor(), { shuvdoClient })

    const createTask = tools.find((tool) => tool.name === 'create_task')
    const completeReminder = tools.find((tool) => tool.name === 'complete_reminder')
    const getQueue = tools.find((tool) => tool.name === 'get_agent_queue')

    expect(createTask).toBeDefined()
    expect(completeReminder).toBeDefined()
    expect(getQueue).toBeDefined()

    await createTask!.execute(
      'tool-call',
      {
        listName: 'work',
        payload: { text: 'Write tests' },
      },
      undefined,
      undefined,
      undefined as any,
    )

    await completeReminder!.execute(
      'tool-call',
      {
        reminderId: 'rem-1',
        idempotencyKey: 'key-1',
      },
      undefined,
      undefined,
      undefined as any,
    )

    await getQueue!.execute(
      'tool-call',
      {
        agentId: 'manager',
        limit: 25,
      },
      undefined,
      undefined,
      undefined as any,
    )

    expect(shuvdoClient.createTask).toHaveBeenCalledWith({
      managerId: 'manager',
      listName: 'work',
      body: { text: 'Write tests' },
    })
    expect(shuvdoClient.completeReminder).toHaveBeenCalledWith({
      managerId: 'manager',
      reminderId: 'rem-1',
      idempotencyKey: 'key-1',
      body: undefined,
    })
    expect(shuvdoClient.getAgentQueue).toHaveBeenCalledWith({
      managerId: 'manager',
      agentId: 'manager',
      limit: 25,
    })
  })
})
