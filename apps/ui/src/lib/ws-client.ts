import { chooseFallbackAgentId } from './agent-hierarchy'
import {
  MANAGER_MODEL_PRESETS,
  type AgentContextUsage,
  type AgentDescriptor,
  type AgentStatus,
  type ClientCommand,
  type ConversationAttachment,
  type ConversationEntry,
  type ConversationMessageEvent,
  type DeliveryMode,
  type ManagerModelPreset,
  type ServerEvent,
  type SlackStatusEvent,
  type TelegramStatusEvent,
} from './ws-types'

const INITIAL_CONNECT_DELAY_MS = 50
const RECONNECT_MS = 1200
const REQUEST_TIMEOUT_MS = 300_000
// Keep client-side activity retention aligned with backend history retention.
const MAX_CLIENT_CONVERSATION_HISTORY = 2000

type ConversationHistoryEntry = Extract<ConversationEntry, { type: 'conversation_message' | 'conversation_log' }>
type AgentActivityEntry = Extract<ConversationEntry, { type: 'agent_message' | 'agent_tool_call' }>

export interface ManagerWsState {
  connected: boolean
  targetAgentId: string | null
  subscribedAgentId: string | null
  messages: ConversationHistoryEntry[]
  activityMessages: AgentActivityEntry[]
  agents: AgentDescriptor[]
  statuses: Record<string, { status: AgentStatus; pendingCount: number; contextUsage?: AgentContextUsage }>
  lastError: string | null
  slackStatus: SlackStatusEvent | null
  telegramStatus: TelegramStatusEvent | null
}

export interface DirectoriesListedResult {
  path: string
  directories: string[]
}

export interface DirectoryValidationResult {
  path: string
  valid: boolean
  message: string | null
}

type Listener = (state: ManagerWsState) => void

interface PendingRequest<T> {
  resolve: (value: T) => void
  reject: (error: Error) => void
  timeout: ReturnType<typeof setTimeout>
}

const initialState: ManagerWsState = {
  connected: false,
  targetAgentId: null,
  subscribedAgentId: null,
  messages: [],
  activityMessages: [],
  agents: [],
  statuses: {},
  lastError: null,
  slackStatus: null,
  telegramStatus: null,
}

function appendWsAuthToken(url: string): string {
  const authToken =
    typeof import.meta !== 'undefined' && typeof import.meta.env?.VITE_SHUVLR_AUTH_TOKEN === 'string'
      ? import.meta.env.VITE_SHUVLR_AUTH_TOKEN.trim()
      : ''

  if (!authToken) {
    return url
  }

  try {
    const parsed = new URL(url)
    parsed.searchParams.set('authToken', authToken)
    return parsed.toString()
  } catch {
    return url
  }
}

export class ManagerWsClient {
  private readonly url: string
  private desiredAgentId: string | null

  private socket: WebSocket | null = null
  private connectTimer: ReturnType<typeof setTimeout> | undefined
  private started = false
  private destroyed = false
  private hasConnectedOnce = false
  private shouldReloadOnReconnect = false

  private state: ManagerWsState
  private readonly listeners = new Set<Listener>()

  private requestCounter = 0
  private readonly pendingCreateManagerRequests = new Map<string, PendingRequest<AgentDescriptor>>()
  private readonly pendingDeleteManagerRequests = new Map<string, PendingRequest<{ managerId: string }>>()
  private readonly pendingStopAllAgentsRequests = new Map<
    string,
    PendingRequest<{ managerId: string; stoppedWorkerIds: string[]; managerStopped: boolean }>
  >()
  private readonly pendingListDirectoriesRequests = new Map<string, PendingRequest<DirectoriesListedResult>>()
  private readonly pendingValidateDirectoryRequests = new Map<string, PendingRequest<DirectoryValidationResult>>()
  private readonly pendingPickDirectoryRequests = new Map<string, PendingRequest<string | null>>()

  constructor(url: string, initialAgentId?: string | null) {
    const normalizedInitialAgentId = normalizeAgentId(initialAgentId)
    this.url = appendWsAuthToken(url)
    this.desiredAgentId = normalizedInitialAgentId
    this.state = {
      ...initialState,
      targetAgentId: normalizedInitialAgentId,
    }
  }

  getState(): ManagerWsState {
    return this.state
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener)
    listener(this.state)

    return () => {
      this.listeners.delete(listener)
    }
  }

  start(): void {
    if (this.started || this.destroyed || typeof window === 'undefined') {
      return
    }

    this.started = true
    this.scheduleConnect(INITIAL_CONNECT_DELAY_MS)
  }

  destroy(): void {
    this.destroyed = true
    this.started = false

    if (this.connectTimer) {
      clearTimeout(this.connectTimer)
      this.connectTimer = undefined
    }

    this.rejectAllPendingRequests('Client destroyed before request completed.')

    if (this.socket) {
      this.socket.close()
      this.socket = null
    }
  }

  subscribeToAgent(agentId: string): void {
    const trimmed = agentId.trim()
    if (!trimmed) return

    this.desiredAgentId = trimmed
    this.updateState({
      targetAgentId: trimmed,
      messages: [],
      activityMessages: [],
      lastError: null,
    })

    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
      return
    }

    this.send({
      type: 'subscribe',
      agentId: trimmed,
    })
  }

  sendUserMessage(
    text: string,
    options?: { agentId?: string; delivery?: DeliveryMode; attachments?: ConversationAttachment[] },
  ): void {
    const trimmed = text.trim()
    const attachments = normalizeConversationAttachments(options?.attachments)
    if (!trimmed && attachments.length === 0) return

    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
      this.updateState({
        lastError: 'WebSocket is disconnected. Reconnecting...'
      })
      return
    }

    const agentId =
      options?.agentId ?? this.state.targetAgentId ?? this.state.subscribedAgentId ?? this.desiredAgentId

    if (!agentId) {
      this.updateState({
        lastError: 'No active agent selected. Create a manager or select an active thread.',
      })
      return
    }

    if (
      !options?.agentId &&
      !this.state.targetAgentId &&
      !this.state.subscribedAgentId &&
      this.state.agents.length === 0
    ) {
      this.updateState({
        lastError: 'No active agent selected. Create a manager or select an active thread.',
      })
      return
    }

    if (this.state.agents.length > 0 && !this.state.agents.some((agent) => agent.agentId === agentId)) {
      this.updateState({
        lastError: 'No active agent selected. Create a manager or select an active thread.',
      })
      return
    }

    this.send({
      type: 'user_message',
      text: trimmed,
      attachments: attachments.length > 0 ? attachments : undefined,
      agentId,
      delivery: options?.delivery,
    })
  }

  deleteAgent(agentId: string): void {
    const trimmed = agentId.trim()
    if (!trimmed) return

    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
      this.updateState({
        lastError: 'WebSocket is disconnected. Reconnecting...'
      })
      return
    }

    this.send({
      type: 'kill_agent',
      agentId: trimmed,
    })
  }

  async stopAllAgents(
    managerId: string,
  ): Promise<{ managerId: string; stoppedWorkerIds: string[]; managerStopped: boolean }> {
    const trimmed = managerId.trim()
    if (!trimmed) {
      throw new Error('Manager id is required.')
    }

    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
      throw new Error('WebSocket is disconnected. Reconnecting...')
    }

    const requestId = this.nextRequestId('stop_all_agents')

    return new Promise<{ managerId: string; stoppedWorkerIds: string[]; managerStopped: boolean }>(
      (resolve, reject) => {
        this.trackPendingRequest(this.pendingStopAllAgentsRequests, requestId, resolve, reject)

        const sent = this.send({
          type: 'stop_all_agents',
          managerId: trimmed,
          requestId,
        })

        if (!sent) {
          this.rejectPendingRequest(
            this.pendingStopAllAgentsRequests,
            requestId,
            new Error('WebSocket is disconnected. Reconnecting...'),
          )
        }
      },
    )
  }

  async createManager(input: { name: string; cwd: string; model: ManagerModelPreset }): Promise<AgentDescriptor> {
    const name = input.name.trim()
    const cwd = input.cwd.trim()
    const model = input.model

    if (!name) {
      throw new Error('Manager name is required.')
    }

    if (!cwd) {
      throw new Error('Manager working directory is required.')
    }

    if (!MANAGER_MODEL_PRESETS.includes(model)) {
      throw new Error('Manager model is required.')
    }

    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
      throw new Error('WebSocket is disconnected. Reconnecting...')
    }

    const requestId = this.nextRequestId('create_manager')

    return new Promise<AgentDescriptor>((resolve, reject) => {
      this.trackPendingRequest(this.pendingCreateManagerRequests, requestId, resolve, reject)

      const sent = this.send({
        type: 'create_manager',
        name,
        cwd,
        model,
        requestId,
      })

      if (!sent) {
        this.rejectPendingRequest(this.pendingCreateManagerRequests, requestId, new Error('WebSocket is disconnected. Reconnecting...'))
      }
    })
  }

  async deleteManager(managerId: string): Promise<{ managerId: string }> {
    const trimmed = managerId.trim()
    if (!trimmed) {
      throw new Error('Manager id is required.')
    }

    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
      throw new Error('WebSocket is disconnected. Reconnecting...')
    }

    const requestId = this.nextRequestId('delete_manager')

    return new Promise<{ managerId: string }>((resolve, reject) => {
      this.trackPendingRequest(this.pendingDeleteManagerRequests, requestId, resolve, reject)

      const sent = this.send({
        type: 'delete_manager',
        managerId: trimmed,
        requestId,
      })

      if (!sent) {
        this.rejectPendingRequest(this.pendingDeleteManagerRequests, requestId, new Error('WebSocket is disconnected. Reconnecting...'))
      }
    })
  }

  async listDirectories(path?: string): Promise<DirectoriesListedResult> {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
      throw new Error('WebSocket is disconnected. Reconnecting...')
    }

    const requestId = this.nextRequestId('list_directories')

    return new Promise<DirectoriesListedResult>((resolve, reject) => {
      this.trackPendingRequest(this.pendingListDirectoriesRequests, requestId, resolve, reject)

      const sent = this.send({
        type: 'list_directories',
        path: path?.trim() || undefined,
        requestId,
      })

      if (!sent) {
        this.rejectPendingRequest(this.pendingListDirectoriesRequests, requestId, new Error('WebSocket is disconnected. Reconnecting...'))
      }
    })
  }

  async validateDirectory(path: string): Promise<DirectoryValidationResult> {
    const trimmed = path.trim()
    if (!trimmed) {
      throw new Error('Directory path is required.')
    }

    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
      throw new Error('WebSocket is disconnected. Reconnecting...')
    }

    const requestId = this.nextRequestId('validate_directory')

    return new Promise<DirectoryValidationResult>((resolve, reject) => {
      this.trackPendingRequest(this.pendingValidateDirectoryRequests, requestId, resolve, reject)

      const sent = this.send({
        type: 'validate_directory',
        path: trimmed,
        requestId,
      })

      if (!sent) {
        this.rejectPendingRequest(
          this.pendingValidateDirectoryRequests,
          requestId,
          new Error('WebSocket is disconnected. Reconnecting...'),
        )
      }
    })
  }

  async pickDirectory(defaultPath?: string): Promise<string | null> {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
      throw new Error('WebSocket is disconnected. Reconnecting...')
    }

    const requestId = this.nextRequestId('pick_directory')

    return new Promise<string | null>((resolve, reject) => {
      this.trackPendingRequest(this.pendingPickDirectoryRequests, requestId, resolve, reject)

      const sent = this.send({
        type: 'pick_directory',
        defaultPath: defaultPath?.trim() || undefined,
        requestId,
      })

      if (!sent) {
        this.rejectPendingRequest(
          this.pendingPickDirectoryRequests,
          requestId,
          new Error('WebSocket is disconnected. Reconnecting...'),
        )
      }
    })
  }

  private connect(): void {
    if (this.destroyed) return

    const socket = new WebSocket(this.url)
    this.socket = socket

    socket.addEventListener('open', () => {
      const shouldReload = this.shouldReloadOnReconnect
      this.hasConnectedOnce = true
      this.shouldReloadOnReconnect = false

      this.updateState({
        connected: true,
        lastError: null,
      })

      this.send({
        type: 'subscribe',
        agentId: this.desiredAgentId ?? undefined,
      })

      if (shouldReload && typeof window !== 'undefined' && typeof window.location?.reload === 'function') {
        window.location.reload()
      }
    })

    socket.addEventListener('message', (event) => {
      this.handleServerEvent(event.data)
    })

    socket.addEventListener('close', () => {
      if (!this.destroyed && this.hasConnectedOnce) {
        this.shouldReloadOnReconnect = true
      }

      this.updateState({
        connected: false,
        subscribedAgentId: null,
      })

      this.rejectAllPendingRequests('WebSocket disconnected before request completed.')
      this.scheduleConnect(RECONNECT_MS)
    })

    socket.addEventListener('error', () => {
      this.updateState({
        connected: false,
        lastError: 'WebSocket connection error',
      })
    })
  }

  private scheduleConnect(delayMs: number): void {
    if (this.destroyed || !this.started || this.connectTimer) {
      return
    }

    this.connectTimer = setTimeout(() => {
      this.connectTimer = undefined
      if (!this.destroyed && this.started) {
        this.connect()
      }
    }, delayMs)
  }

  private handleServerEvent(raw: unknown): void {
    let event: ServerEvent
    try {
      event = JSON.parse(String(raw)) as ServerEvent
    } catch {
      this.pushSystemMessage('Received invalid JSON event from backend.')
      return
    }

    switch (event.type) {
      case 'ready':
        this.updateState({
          connected: true,
          targetAgentId: event.subscribedAgentId,
          subscribedAgentId: event.subscribedAgentId,
          lastError: null,
        })
        break

      case 'conversation_message':
      case 'conversation_log': {
        if (event.agentId !== this.state.targetAgentId) {
          break
        }

        const messages = [...this.state.messages, event]
        this.updateState({ messages })
        break
      }

      case 'agent_message':
      case 'agent_tool_call': {
        if (event.agentId !== this.state.targetAgentId) {
          break
        }

        const activityMessages = clampConversationHistory([...this.state.activityMessages, event])
        this.updateState({ activityMessages })
        break
      }

      case 'conversation_history':
        if (event.agentId !== this.state.targetAgentId) {
          break
        }

        {
          const { messages, activityMessages } = splitConversationHistory(event.messages)
          this.updateState({
            messages,
            activityMessages: clampConversationHistory(activityMessages),
          })
        }
        break

      case 'conversation_reset':
        if (event.agentId !== this.state.targetAgentId) {
          break
        }

        this.updateState({
          messages: [],
          activityMessages: [],
          lastError: null,
        })
        break

      case 'agent_status': {
        const statuses = {
          ...this.state.statuses,
          [event.agentId]: {
            status: event.status,
            pendingCount: event.pendingCount,
            contextUsage: event.contextUsage,
          },
        }
        this.updateState({ statuses })
        break
      }

      case 'agents_snapshot':
        this.applyAgentsSnapshot(event.agents)
        break

      case 'manager_created': {
        this.applyManagerCreated(event.manager)
        this.resolvePendingRequest(
          this.pendingCreateManagerRequests,
          event.requestId,
          event.manager,
        )
        break
      }

      case 'manager_deleted': {
        this.applyManagerDeleted(event.managerId)
        this.resolvePendingRequest(
          this.pendingDeleteManagerRequests,
          event.requestId,
          { managerId: event.managerId },
        )
        break
      }

      case 'stop_all_agents_result': {
        const stoppedWorkerIds = event.stoppedWorkerIds ?? event.terminatedWorkerIds ?? []
        const managerStopped = event.managerStopped ?? event.managerTerminated ?? false

        this.resolvePendingRequest(
          this.pendingStopAllAgentsRequests,
          event.requestId,
          {
            managerId: event.managerId,
            stoppedWorkerIds,
            managerStopped,
          },
        )
        break
      }

      case 'directories_listed': {
        this.resolvePendingRequest(
          this.pendingListDirectoriesRequests,
          event.requestId,
          {
            path: event.path,
            directories: event.directories,
          },
        )
        break
      }

      case 'directory_validated': {
        this.resolvePendingRequest(
          this.pendingValidateDirectoryRequests,
          event.requestId,
          {
            path: event.path,
            valid: event.valid,
            message: event.message ?? null,
          },
        )
        break
      }

      case 'directory_picked': {
        this.resolvePendingRequest(
          this.pendingPickDirectoryRequests,
          event.requestId,
          event.path ?? null,
        )
        break
      }

      case 'slack_status':
        this.updateState({ slackStatus: event })
        break

      case 'telegram_status':
        this.updateState({ telegramStatus: event })
        break

      case 'error':
        this.updateState({ lastError: event.message })
        this.pushSystemMessage(`${event.code}: ${event.message}`)
        this.rejectPendingFromError(event.code, event.message, event.requestId)
        break
    }
  }

  private applyAgentsSnapshot(agents: AgentDescriptor[]): void {
    const liveAgentIds = new Set(agents.map((agent) => agent.agentId))
    const statuses = Object.fromEntries(
      agents.map((agent) => {
        const previous = this.state.statuses[agent.agentId]
        return [
          agent.agentId,
          {
            status: previous?.status ?? agent.status,
            pendingCount: previous?.pendingCount ?? 0,
            contextUsage: agent.contextUsage,
          },
        ]
      }),
    )

    const fallbackTarget = chooseFallbackAgentId(
      agents,
      this.state.targetAgentId ?? this.state.subscribedAgentId ?? this.desiredAgentId ?? undefined,
    )
    const targetChanged = fallbackTarget !== this.state.targetAgentId
    const nextSubscribedAgentId =
      this.state.subscribedAgentId && liveAgentIds.has(this.state.subscribedAgentId)
        ? this.state.subscribedAgentId
        : fallbackTarget ?? null

    const patch: Partial<ManagerWsState> = {
      agents,
      statuses,
    }

    if (targetChanged) {
      patch.targetAgentId = fallbackTarget
      patch.messages = []
      patch.activityMessages = []
    }

    if (nextSubscribedAgentId !== this.state.subscribedAgentId) {
      patch.subscribedAgentId = nextSubscribedAgentId
    }

    this.desiredAgentId = fallbackTarget ?? null

    this.updateState(patch)

    if (targetChanged && fallbackTarget && this.socket?.readyState === WebSocket.OPEN) {
      this.send({
        type: 'subscribe',
        agentId: fallbackTarget,
      })
    }
  }

  private applyManagerCreated(manager: AgentDescriptor): void {
    const nextAgents = [
      ...this.state.agents.filter((agent) => agent.agentId !== manager.agentId),
      manager,
    ]
    this.applyAgentsSnapshot(nextAgents)
  }

  private applyManagerDeleted(managerId: string): void {
    const nextAgents = this.state.agents.filter(
      (agent) => agent.agentId !== managerId && agent.managerId !== managerId,
    )
    this.applyAgentsSnapshot(nextAgents)
  }

  private pushSystemMessage(text: string): void {
    const message: ConversationMessageEvent = {
      type: 'conversation_message',
      agentId: (this.state.targetAgentId ?? this.state.subscribedAgentId ?? this.desiredAgentId) || 'system',
      role: 'system',
      text,
      timestamp: new Date().toISOString(),
      source: 'system',
    }

    const messages = [...this.state.messages, message]
    this.updateState({ messages })
  }

  private send(command: ClientCommand): boolean {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) return false
    this.socket.send(JSON.stringify(command))
    return true
  }

  private updateState(patch: Partial<ManagerWsState>): void {
    this.state = { ...this.state, ...patch }
    for (const listener of this.listeners) {
      listener(this.state)
    }
  }

  private nextRequestId(prefix: string): string {
    this.requestCounter += 1
    return `${prefix}-${Date.now()}-${this.requestCounter}`
  }

  private trackPendingRequest<T>(
    pendingMap: Map<string, PendingRequest<T>>,
    requestId: string,
    resolve: (value: T) => void,
    reject: (error: Error) => void,
  ): void {
    const timeout = setTimeout(() => {
      this.rejectPendingRequest(
        pendingMap,
        requestId,
        new Error('Request timed out waiting for backend response.'),
      )
    }, REQUEST_TIMEOUT_MS)

    pendingMap.set(requestId, {
      resolve,
      reject,
      timeout,
    })
  }

  private resolvePendingRequest<T>(
    pendingMap: Map<string, PendingRequest<T>>,
    requestId: string | undefined,
    value: T,
  ): void {
    const resolvedById = requestId ? this.finalizePendingById(pendingMap, requestId, value) : false
    if (resolvedById) return

    this.resolveOldestPendingRequest(pendingMap, value)
  }

  private rejectPendingRequest<T>(
    pendingMap: Map<string, PendingRequest<T>>,
    requestId: string,
    error: Error,
  ): void {
    const pending = pendingMap.get(requestId)
    if (!pending) return

    clearTimeout(pending.timeout)
    pendingMap.delete(requestId)
    pending.reject(error)
  }

  private finalizePendingById<T>(
    pendingMap: Map<string, PendingRequest<T>>,
    requestId: string,
    value: T,
  ): boolean {
    const pending = pendingMap.get(requestId)
    if (!pending) return false

    clearTimeout(pending.timeout)
    pendingMap.delete(requestId)
    pending.resolve(value)
    return true
  }

  private resolveOldestPendingRequest<T>(
    pendingMap: Map<string, PendingRequest<T>>,
    value: T,
  ): boolean {
    const first = pendingMap.entries().next()
    if (first.done) return false

    const [requestId, pending] = first.value
    clearTimeout(pending.timeout)
    pendingMap.delete(requestId)
    pending.resolve(value)
    return true
  }

  private rejectOldestPendingRequest<T>(
    pendingMap: Map<string, PendingRequest<T>>,
    error: Error,
  ): boolean {
    const first = pendingMap.entries().next()
    if (first.done) return false

    const [requestId, pending] = first.value
    clearTimeout(pending.timeout)
    pendingMap.delete(requestId)
    pending.reject(error)
    return true
  }

  private rejectPendingFromError(code: string, message: string, requestId?: string): void {
    const fullError = new Error(`${code}: ${message}`)

    if (requestId) {
      const resolvedById =
        this.rejectPendingByRequestId(this.pendingCreateManagerRequests, requestId, fullError) ||
        this.rejectPendingByRequestId(this.pendingDeleteManagerRequests, requestId, fullError) ||
        this.rejectPendingByRequestId(this.pendingStopAllAgentsRequests, requestId, fullError) ||
        this.rejectPendingByRequestId(this.pendingListDirectoriesRequests, requestId, fullError) ||
        this.rejectPendingByRequestId(this.pendingValidateDirectoryRequests, requestId, fullError) ||
        this.rejectPendingByRequestId(this.pendingPickDirectoryRequests, requestId, fullError)

      if (resolvedById) {
        return
      }
    }

    const loweredCode = code.toLowerCase()

    if (loweredCode.includes('create_manager')) {
      if (this.rejectOldestPendingRequest(this.pendingCreateManagerRequests, fullError)) return
    }

    if (loweredCode.includes('delete_manager')) {
      if (this.rejectOldestPendingRequest(this.pendingDeleteManagerRequests, fullError)) return
    }

    if (loweredCode.includes('stop_all_agents')) {
      if (this.rejectOldestPendingRequest(this.pendingStopAllAgentsRequests, fullError)) return
    }

    if (loweredCode.includes('list_directories')) {
      if (this.rejectOldestPendingRequest(this.pendingListDirectoriesRequests, fullError)) return
    }

    if (loweredCode.includes('validate_directory')) {
      if (this.rejectOldestPendingRequest(this.pendingValidateDirectoryRequests, fullError)) return
    }

    if (loweredCode.includes('pick_directory')) {
      if (this.rejectOldestPendingRequest(this.pendingPickDirectoryRequests, fullError)) return
    }

    const totalPending =
      this.pendingCreateManagerRequests.size +
      this.pendingDeleteManagerRequests.size +
      this.pendingStopAllAgentsRequests.size +
      this.pendingListDirectoriesRequests.size +
      this.pendingValidateDirectoryRequests.size +
      this.pendingPickDirectoryRequests.size

    if (totalPending !== 1) {
      return
    }

    this.rejectOldestPendingRequest(this.pendingCreateManagerRequests, fullError)
    this.rejectOldestPendingRequest(this.pendingDeleteManagerRequests, fullError)
    this.rejectOldestPendingRequest(this.pendingStopAllAgentsRequests, fullError)
    this.rejectOldestPendingRequest(this.pendingListDirectoriesRequests, fullError)
    this.rejectOldestPendingRequest(this.pendingValidateDirectoryRequests, fullError)
    this.rejectOldestPendingRequest(this.pendingPickDirectoryRequests, fullError)
  }

  private rejectPendingByRequestId<T>(
    pendingMap: Map<string, PendingRequest<T>>,
    requestId: string,
    error: Error,
  ): boolean {
    const pending = pendingMap.get(requestId)
    if (!pending) return false

    clearTimeout(pending.timeout)
    pendingMap.delete(requestId)
    pending.reject(error)
    return true
  }

  private rejectAllPendingRequests(reason: string): void {
    const error = new Error(reason)

    this.rejectPendingMap(this.pendingCreateManagerRequests, error)
    this.rejectPendingMap(this.pendingDeleteManagerRequests, error)
    this.rejectPendingMap(this.pendingStopAllAgentsRequests, error)
    this.rejectPendingMap(this.pendingListDirectoriesRequests, error)
    this.rejectPendingMap(this.pendingValidateDirectoryRequests, error)
    this.rejectPendingMap(this.pendingPickDirectoryRequests, error)
  }

  private rejectPendingMap<T>(pendingMap: Map<string, PendingRequest<T>>, error: Error): void {
    for (const [requestId, pending] of [...pendingMap.entries()]) {
      clearTimeout(pending.timeout)
      pending.reject(error)
      pendingMap.delete(requestId)
    }
  }
}

function normalizeConversationAttachments(
  attachments: ConversationAttachment[] | undefined,
): ConversationAttachment[] {
  if (!attachments || attachments.length === 0) {
    return []
  }

  const normalized: ConversationAttachment[] = []

  for (const attachment of attachments) {
    if (!attachment || typeof attachment !== 'object') {
      continue
    }

    const maybe = attachment as {
      type?: unknown
      mimeType?: unknown
      data?: unknown
      text?: unknown
      fileName?: unknown
    }

    const attachmentType = typeof maybe.type === 'string' ? maybe.type.trim() : ''
    const mimeType = typeof maybe.mimeType === 'string' ? maybe.mimeType.trim() : ''
    const fileName = typeof maybe.fileName === 'string' ? maybe.fileName.trim() : ''

    if (attachmentType === 'text') {
      const text = typeof maybe.text === 'string' ? maybe.text : ''
      if (!mimeType || text.trim().length === 0) {
        continue
      }

      normalized.push({
        type: 'text',
        mimeType,
        text,
        fileName: fileName || undefined,
      })
      continue
    }

    if (attachmentType === 'binary') {
      const data = typeof maybe.data === 'string' ? maybe.data.trim() : ''
      if (!mimeType || data.length === 0) {
        continue
      }

      normalized.push({
        type: 'binary',
        mimeType,
        data,
        fileName: fileName || undefined,
      })
      continue
    }

    const data = typeof maybe.data === 'string' ? maybe.data.trim() : ''
    if (!mimeType || !mimeType.startsWith('image/') || !data) {
      continue
    }

    normalized.push({
      mimeType,
      data,
      fileName: fileName || undefined,
    })
  }

  return normalized
}

function splitConversationHistory(
  messages: ConversationEntry[],
): { messages: ConversationHistoryEntry[]; activityMessages: AgentActivityEntry[] } {
  const conversationMessages: ConversationHistoryEntry[] = []
  const activityMessages: AgentActivityEntry[] = []

  for (const entry of messages) {
    if (entry.type === 'agent_message' || entry.type === 'agent_tool_call') {
      activityMessages.push(entry)
      continue
    }

    conversationMessages.push(entry)
  }

  return {
    messages: conversationMessages,
    activityMessages,
  }
}

function clampConversationHistory(messages: AgentActivityEntry[]): AgentActivityEntry[] {
  if (messages.length <= MAX_CLIENT_CONVERSATION_HISTORY) {
    return messages
  }

  return messages.slice(-MAX_CLIENT_CONVERSATION_HISTORY)
}

function normalizeAgentId(agentId: string | null | undefined): string | null {
  const trimmed = agentId?.trim()
  return trimmed ? trimmed : null
}
