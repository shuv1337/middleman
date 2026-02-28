/* ------------------------------------------------------------------ */
/*  Shared API helpers for settings components                        */
/* ------------------------------------------------------------------ */

import type {
  SettingsEnvVariable,
  SettingsAuthProviderId,
  SettingsAuthProvider,
  SettingsAuthOAuthFlowState,
  SlackSettingsConfig,
  SlackChannelDescriptor,
  TelegramSettingsConfig,
  GsuiteSettingsConfig,
  GsuiteSettingsStatus,
} from './settings-types'
import type { SlackStatusEvent, TelegramStatusEvent } from '@/lib/ws-types'

/* ------------------------------------------------------------------ */
/*  Constants                                                         */
/* ------------------------------------------------------------------ */

export const SETTINGS_AUTH_PROVIDER_META: Record<
  SettingsAuthProviderId,
  { label: string; description: string; placeholder: string; helpUrl: string }
> = {
  anthropic: {
    label: 'Anthropic API key',
    description: 'Used by pi-opus and Anthropic-backed managers/workers.',
    placeholder: 'sk-ant-...',
    helpUrl: 'https://console.anthropic.com/settings/keys',
  },
  'openai-codex': {
    label: 'OpenAI API key',
    description: 'Used for Codex runtime sessions and voice transcription.',
    placeholder: 'sk-...',
    helpUrl: 'https://platform.openai.com/api-keys',
  },
}

export const SETTINGS_AUTH_PROVIDER_ORDER: SettingsAuthProviderId[] = ['anthropic', 'openai-codex']

export const DEFAULT_SETTINGS_AUTH_OAUTH_FLOW_STATE: SettingsAuthOAuthFlowState = {
  status: 'idle',
  codeValue: '',
  isSubmittingCode: false,
}

const SETTINGS_AUTH_TOKEN =
  typeof import.meta !== 'undefined' && typeof import.meta.env?.VITE_SHUVLR_AUTH_TOKEN === 'string'
    ? import.meta.env.VITE_SHUVLR_AUTH_TOKEN.trim() || undefined
    : undefined

const fetch = (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
  const nativeFetch = globalThis.fetch.bind(globalThis)

  if (!SETTINGS_AUTH_TOKEN) {
    return nativeFetch(input, init)
  }

  const headers = new Headers(init?.headers)
  if (!headers.has('authorization')) {
    headers.set('authorization', `Bearer ${SETTINGS_AUTH_TOKEN}`)
  }

  return nativeFetch(input, {
    ...init,
    headers,
  })
}

/* ------------------------------------------------------------------ */
/*  Utilities                                                         */
/* ------------------------------------------------------------------ */

export function resolveApiEndpoint(wsUrl: string, path: string): string {
  try {
    const parsed = new URL(wsUrl)
    parsed.protocol = parsed.protocol === 'wss:' ? 'https:' : 'http:'
    parsed.pathname = path
    parsed.search = ''
    parsed.hash = ''
    return parsed.toString()
  } catch {
    return path
  }
}

export function toErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message
  return 'An unexpected error occurred.'
}

export function createIdleSettingsAuthOAuthFlowState(): SettingsAuthOAuthFlowState {
  return { ...DEFAULT_SETTINGS_AUTH_OAUTH_FLOW_STATE }
}

function normalizeSettingsAuthProviderId(value: unknown): SettingsAuthProviderId | undefined {
  if (value === 'anthropic') return 'anthropic'
  if (value === 'openai-codex') return 'openai-codex'
  return undefined
}

async function readApiError(response: Response): Promise<string> {
  try {
    const payload = (await response.json()) as { error?: unknown; message?: unknown }
    if (typeof payload.error === 'string' && payload.error.trim()) return payload.error
    if (typeof payload.message === 'string' && payload.message.trim()) return payload.message
  } catch { /* ignore */ }
  try {
    const text = await response.text()
    if (text.trim().length > 0) return text
  } catch { /* ignore */ }
  return `Request failed (${response.status})`
}

/* ------------------------------------------------------------------ */
/*  Type guards                                                       */
/* ------------------------------------------------------------------ */

function isSettingsEnvVariable(value: unknown): value is SettingsEnvVariable {
  if (!value || typeof value !== 'object') return false
  const v = value as Partial<SettingsEnvVariable>
  return (
    typeof v.name === 'string' && v.name.trim().length > 0 &&
    typeof v.skillName === 'string' && v.skillName.trim().length > 0 &&
    typeof v.required === 'boolean' &&
    typeof v.isSet === 'boolean'
  )
}

function parseSettingsAuthProvider(value: unknown): SettingsAuthProvider | null {
  if (!value || typeof value !== 'object') return null
  const provider = value as { provider?: unknown; configured?: unknown; authType?: unknown; maskedValue?: unknown }
  const providerId = normalizeSettingsAuthProviderId(provider.provider)
  if (!providerId || typeof provider.configured !== 'boolean') return null
  if (provider.authType !== undefined && provider.authType !== 'api_key' && provider.authType !== 'oauth' && provider.authType !== 'unknown') return null
  return {
    provider: providerId,
    configured: provider.configured,
    authType: provider.authType,
    maskedValue: typeof provider.maskedValue === 'string' ? provider.maskedValue : undefined,
  }
}

function isSlackSettingsConfig(value: unknown): value is SlackSettingsConfig {
  if (!value || typeof value !== 'object') return false
  const config = value as Partial<SlackSettingsConfig>
  return (
    typeof config.profileId === 'string' && typeof config.enabled === 'boolean' &&
    config.mode === 'socket' && typeof config.hasAppToken === 'boolean' &&
    typeof config.hasBotToken === 'boolean' && Boolean(config.listen) &&
    Boolean(config.response) && Boolean(config.attachments)
  )
}

function isSlackChannelDescriptor(value: unknown): value is SlackChannelDescriptor {
  if (!value || typeof value !== 'object') return false
  const channel = value as Partial<SlackChannelDescriptor>
  return (
    typeof channel.id === 'string' && channel.id.trim().length > 0 &&
    typeof channel.name === 'string' && channel.name.trim().length > 0 &&
    typeof channel.isPrivate === 'boolean' && typeof channel.isMember === 'boolean'
  )
}

function isTelegramSettingsConfig(value: unknown): value is TelegramSettingsConfig {
  if (!value || typeof value !== 'object') return false
  const config = value as Partial<TelegramSettingsConfig>
  const hasValidAllowedUserIds = config.allowedUserIds === undefined ||
    (Array.isArray(config.allowedUserIds) && config.allowedUserIds.every((e) => typeof e === 'string'))
  return (
    typeof config.profileId === 'string' && typeof config.enabled === 'boolean' &&
    config.mode === 'polling' && typeof config.hasBotToken === 'boolean' &&
    hasValidAllowedUserIds && Boolean(config.polling) &&
    Boolean(config.delivery) && Boolean(config.attachments)
  )
}

function isGsuiteSettingsConfig(value: unknown): value is GsuiteSettingsConfig {
  if (!value || typeof value !== 'object') return false
  const config = value as Partial<GsuiteSettingsConfig>
  return (
    typeof config.enabled === 'boolean' && typeof config.accountEmail === 'string' &&
    Array.isArray(config.services) && typeof config.hasOAuthClientCredentials === 'boolean' &&
    (config.lastConnectedAt === null || typeof config.lastConnectedAt === 'string') &&
    typeof config.updatedAt === 'string'
  )
}

function isGsuiteSettingsStatus(value: unknown): value is GsuiteSettingsStatus {
  if (!value || typeof value !== 'object') return false
  const status = value as Partial<GsuiteSettingsStatus>
  return (
    (status.state === 'disabled' || status.state === 'ready' || status.state === 'connected' || status.state === 'error') &&
    typeof status.enabled === 'boolean' && typeof status.gogInstalled === 'boolean' &&
    typeof status.connected === 'boolean' && typeof status.accountEmail === 'string' &&
    typeof status.message === 'string' && typeof status.updatedAt === 'string'
  )
}

/* ------------------------------------------------------------------ */
/*  OAuth SSE parsing                                                 */
/* ------------------------------------------------------------------ */

interface SettingsAuthOAuthStreamHandlers {
  onAuthUrl: (event: { url: string; instructions?: string }) => void
  onPrompt: (event: { message: string; placeholder?: string }) => void
  onProgress: (event: { message: string }) => void
  onComplete: (event: { provider: SettingsAuthProviderId; status: 'connected' }) => void
  onError: (message: string) => void
}

function parseSettingsAuthOAuthEventData(rawData: string): Record<string, unknown> {
  let parsed: unknown
  try { parsed = JSON.parse(rawData) } catch { throw new Error('Invalid OAuth event payload.') }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('Invalid OAuth event payload.')
  return parsed as Record<string, unknown>
}

/* ------------------------------------------------------------------ */
/*  Env variables API                                                 */
/* ------------------------------------------------------------------ */

export async function fetchSettingsEnvVariables(wsUrl: string): Promise<SettingsEnvVariable[]> {
  const endpoint = resolveApiEndpoint(wsUrl, '/api/settings/env')
  const response = await fetch(endpoint)
  if (!response.ok) throw new Error(await readApiError(response))
  const payload = (await response.json()) as { variables?: unknown }
  if (!payload || !Array.isArray(payload.variables)) return []
  return payload.variables.filter(isSettingsEnvVariable)
}

export async function updateSettingsEnvVariables(wsUrl: string, values: Record<string, string>): Promise<void> {
  const endpoint = resolveApiEndpoint(wsUrl, '/api/settings/env')
  const response = await fetch(endpoint, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ values }) })
  if (!response.ok) throw new Error(await readApiError(response))
}

export async function deleteSettingsEnvVariable(wsUrl: string, variableName: string): Promise<void> {
  const endpoint = resolveApiEndpoint(wsUrl, `/api/settings/env/${encodeURIComponent(variableName)}`)
  const response = await fetch(endpoint, { method: 'DELETE' })
  if (!response.ok) throw new Error(await readApiError(response))
}

/* ------------------------------------------------------------------ */
/*  Auth providers API                                                */
/* ------------------------------------------------------------------ */

export async function fetchSettingsAuthProviders(wsUrl: string): Promise<SettingsAuthProvider[]> {
  const endpoint = resolveApiEndpoint(wsUrl, '/api/settings/auth')
  const response = await fetch(endpoint)
  if (!response.ok) throw new Error(await readApiError(response))
  const payload = (await response.json()) as { providers?: unknown }
  if (!payload || !Array.isArray(payload.providers)) return []
  const parsed = payload.providers.map((v) => parseSettingsAuthProvider(v)).filter((v): v is SettingsAuthProvider => v !== null)
  const configuredByProvider = new Map(parsed.map((entry) => [entry.provider, entry]))
  return SETTINGS_AUTH_PROVIDER_ORDER.map((provider) => configuredByProvider.get(provider) ?? { provider, configured: false })
}

export async function updateSettingsAuthProviders(wsUrl: string, values: Partial<Record<SettingsAuthProviderId, string>>): Promise<void> {
  const endpoint = resolveApiEndpoint(wsUrl, '/api/settings/auth')
  const response = await fetch(endpoint, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(values) })
  if (!response.ok) throw new Error(await readApiError(response))
}

export async function deleteSettingsAuthProvider(wsUrl: string, provider: SettingsAuthProviderId): Promise<void> {
  const endpoint = resolveApiEndpoint(wsUrl, `/api/settings/auth/${encodeURIComponent(provider)}`)
  const response = await fetch(endpoint, { method: 'DELETE' })
  if (!response.ok) throw new Error(await readApiError(response))
}

export async function startSettingsAuthOAuthLoginStream(
  wsUrl: string,
  provider: SettingsAuthProviderId,
  handlers: SettingsAuthOAuthStreamHandlers,
  signal: AbortSignal,
): Promise<void> {
  const endpoint = resolveApiEndpoint(wsUrl, `/api/settings/auth/login/${encodeURIComponent(provider)}`)
  const response = await fetch(endpoint, { method: 'POST', signal })
  if (!response.ok) throw new Error(await readApiError(response))
  if (!response.body) throw new Error('OAuth login stream is unavailable.')

  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let lineBuffer = ''
  let eventName = 'message'
  let eventDataLines: string[] = []

  const flushEvent = (): void => {
    if (eventDataLines.length === 0) { eventName = 'message'; return }
    const rawData = eventDataLines.join('\n')
    eventDataLines = []

    if (eventName === 'auth_url') {
      const payload = parseSettingsAuthOAuthEventData(rawData)
      if (typeof payload.url !== 'string' || !payload.url.trim()) throw new Error('OAuth auth_url event is missing a URL.')
      handlers.onAuthUrl({ url: payload.url, instructions: typeof payload.instructions === 'string' ? payload.instructions : undefined })
    } else if (eventName === 'prompt') {
      const payload = parseSettingsAuthOAuthEventData(rawData)
      if (typeof payload.message !== 'string' || !payload.message.trim()) throw new Error('OAuth prompt event is missing a message.')
      handlers.onPrompt({ message: payload.message, placeholder: typeof payload.placeholder === 'string' ? payload.placeholder : undefined })
    } else if (eventName === 'progress') {
      const payload = parseSettingsAuthOAuthEventData(rawData)
      if (typeof payload.message === 'string' && payload.message.trim()) handlers.onProgress({ message: payload.message })
    } else if (eventName === 'complete') {
      const payload = parseSettingsAuthOAuthEventData(rawData)
      const providerId = normalizeSettingsAuthProviderId(payload.provider)
      if (!providerId || payload.status !== 'connected') throw new Error('OAuth complete event payload is invalid.')
      handlers.onComplete({ provider: providerId, status: 'connected' })
    } else if (eventName === 'error') {
      const payload = parseSettingsAuthOAuthEventData(rawData)
      const message = typeof payload.message === 'string' && payload.message.trim() ? payload.message : 'OAuth login failed.'
      handlers.onError(message)
    }
    eventName = 'message'
  }

  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    lineBuffer += decoder.decode(value, { stream: true })
    let newlineIndex = lineBuffer.indexOf('\n')
    while (newlineIndex >= 0) {
      let line = lineBuffer.slice(0, newlineIndex)
      lineBuffer = lineBuffer.slice(newlineIndex + 1)
      if (line.endsWith('\r')) line = line.slice(0, -1)
      if (!line) flushEvent()
      else if (line.startsWith(':')) { /* comment */ }
      else if (line.startsWith('event:')) eventName = line.slice('event:'.length).trim()
      else if (line.startsWith('data:')) eventDataLines.push(line.slice('data:'.length).trimStart())
      newlineIndex = lineBuffer.indexOf('\n')
    }
  }
  flushEvent()
}

export async function submitSettingsAuthOAuthPrompt(wsUrl: string, provider: SettingsAuthProviderId, value: string): Promise<void> {
  const endpoint = resolveApiEndpoint(wsUrl, `/api/settings/auth/login/${encodeURIComponent(provider)}/respond`)
  const response = await fetch(endpoint, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ value }) })
  if (!response.ok) throw new Error(await readApiError(response))
}

/* ------------------------------------------------------------------ */
/*  Slack API                                                         */
/* ------------------------------------------------------------------ */

function resolveManagerIntegrationEndpoint(wsUrl: string, managerId: string, provider: 'slack' | 'telegram', suffix = ''): string {
  const normalizedManagerId = managerId.trim()
  if (!normalizedManagerId) {
    throw new Error('managerId is required.')
  }
  return resolveApiEndpoint(wsUrl, `/api/managers/${encodeURIComponent(normalizedManagerId)}/integrations/${provider}${suffix}`)
}

export async function fetchSlackSettings(wsUrl: string, managerId: string): Promise<{ config: SlackSettingsConfig; status: SlackStatusEvent | null }> {
  const endpoint = resolveManagerIntegrationEndpoint(wsUrl, managerId, 'slack')
  const response = await fetch(endpoint)
  if (!response.ok) throw new Error(await readApiError(response))
  const payload = (await response.json()) as { config?: unknown; status?: SlackStatusEvent }
  if (!isSlackSettingsConfig(payload.config)) throw new Error('Invalid Slack settings response from backend.')
  return { config: payload.config, status: payload.status ?? null }
}

export async function updateSlackSettings(wsUrl: string, managerId: string, patch: Record<string, unknown>): Promise<{ config: SlackSettingsConfig; status: SlackStatusEvent | null }> {
  const endpoint = resolveManagerIntegrationEndpoint(wsUrl, managerId, 'slack')
  const response = await fetch(endpoint, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(patch) })
  if (!response.ok) throw new Error(await readApiError(response))
  const payload = (await response.json()) as { config?: unknown; status?: SlackStatusEvent }
  if (!isSlackSettingsConfig(payload.config)) throw new Error('Invalid Slack settings response from backend.')
  return { config: payload.config, status: payload.status ?? null }
}

export async function disableSlackSettings(wsUrl: string, managerId: string): Promise<{ config: SlackSettingsConfig; status: SlackStatusEvent | null }> {
  const endpoint = resolveManagerIntegrationEndpoint(wsUrl, managerId, 'slack')
  const response = await fetch(endpoint, { method: 'DELETE' })
  if (!response.ok) throw new Error(await readApiError(response))
  const payload = (await response.json()) as { config?: unknown; status?: SlackStatusEvent }
  if (!isSlackSettingsConfig(payload.config)) throw new Error('Invalid Slack settings response from backend.')
  return { config: payload.config, status: payload.status ?? null }
}

export async function testSlackConnection(wsUrl: string, managerId: string, patch?: Record<string, unknown>): Promise<{ teamName?: string; teamId?: string; botUserId?: string }> {
  const endpoint = resolveManagerIntegrationEndpoint(wsUrl, managerId, 'slack', '/test')
  const response = await fetch(endpoint, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(patch ?? {}) })
  if (!response.ok) throw new Error(await readApiError(response))
  const payload = (await response.json()) as { result?: { teamName?: string; teamId?: string; botUserId?: string } }
  return payload.result ?? {}
}

export async function fetchSlackChannels(wsUrl: string, managerId: string, includePrivateChannels: boolean): Promise<SlackChannelDescriptor[]> {
  const endpoint = new URL(resolveManagerIntegrationEndpoint(wsUrl, managerId, 'slack', '/channels'))
  endpoint.searchParams.set('includePrivateChannels', includePrivateChannels ? 'true' : 'false')
  const response = await fetch(endpoint.toString())
  if (!response.ok) throw new Error(await readApiError(response))
  const payload = (await response.json()) as { channels?: unknown }
  if (!Array.isArray(payload.channels)) return []
  return payload.channels.filter(isSlackChannelDescriptor)
}

/* ------------------------------------------------------------------ */
/*  Telegram API                                                      */
/* ------------------------------------------------------------------ */

export async function fetchTelegramSettings(wsUrl: string, managerId: string): Promise<{ config: TelegramSettingsConfig; status: TelegramStatusEvent | null }> {
  const endpoint = resolveManagerIntegrationEndpoint(wsUrl, managerId, 'telegram')
  const response = await fetch(endpoint)
  if (!response.ok) throw new Error(await readApiError(response))
  const payload = (await response.json()) as { config?: unknown; status?: TelegramStatusEvent }
  if (!isTelegramSettingsConfig(payload.config)) throw new Error('Invalid Telegram settings response from backend.')
  return { config: payload.config, status: payload.status ?? null }
}

export async function updateTelegramSettings(wsUrl: string, managerId: string, patch: Record<string, unknown>): Promise<{ config: TelegramSettingsConfig; status: TelegramStatusEvent | null }> {
  const endpoint = resolveManagerIntegrationEndpoint(wsUrl, managerId, 'telegram')
  const response = await fetch(endpoint, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(patch) })
  if (!response.ok) throw new Error(await readApiError(response))
  const payload = (await response.json()) as { config?: unknown; status?: TelegramStatusEvent }
  if (!isTelegramSettingsConfig(payload.config)) throw new Error('Invalid Telegram settings response from backend.')
  return { config: payload.config, status: payload.status ?? null }
}

export async function disableTelegramSettings(wsUrl: string, managerId: string): Promise<{ config: TelegramSettingsConfig; status: TelegramStatusEvent | null }> {
  const endpoint = resolveManagerIntegrationEndpoint(wsUrl, managerId, 'telegram')
  const response = await fetch(endpoint, { method: 'DELETE' })
  if (!response.ok) throw new Error(await readApiError(response))
  const payload = (await response.json()) as { config?: unknown; status?: TelegramStatusEvent }
  if (!isTelegramSettingsConfig(payload.config)) throw new Error('Invalid Telegram settings response from backend.')
  return { config: payload.config, status: payload.status ?? null }
}

export async function testTelegramConnection(wsUrl: string, managerId: string, patch?: Record<string, unknown>): Promise<{ botId?: string; botUsername?: string; botDisplayName?: string }> {
  const endpoint = resolveManagerIntegrationEndpoint(wsUrl, managerId, 'telegram', '/test')
  const response = await fetch(endpoint, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(patch ?? {}) })
  if (!response.ok) throw new Error(await readApiError(response))
  const payload = (await response.json()) as { result?: { botId?: string; botUsername?: string; botDisplayName?: string } }
  return payload.result ?? {}
}

/* ------------------------------------------------------------------ */
/*  GSuite API                                                        */
/* ------------------------------------------------------------------ */

export async function fetchGsuiteSettings(wsUrl: string): Promise<{ config: GsuiteSettingsConfig; status: GsuiteSettingsStatus }> {
  const endpoint = resolveApiEndpoint(wsUrl, '/api/integrations/gsuite')
  const response = await fetch(endpoint)
  if (!response.ok) throw new Error(await readApiError(response))
  const payload = (await response.json()) as { config?: unknown; status?: unknown }
  if (!isGsuiteSettingsConfig(payload.config) || !isGsuiteSettingsStatus(payload.status)) throw new Error('Invalid G Suite settings response from backend.')
  return { config: payload.config, status: payload.status }
}

export async function updateGsuiteSettings(wsUrl: string, patch: Record<string, unknown>): Promise<{ config: GsuiteSettingsConfig; status: GsuiteSettingsStatus }> {
  const endpoint = resolveApiEndpoint(wsUrl, '/api/integrations/gsuite')
  const response = await fetch(endpoint, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(patch) })
  if (!response.ok) throw new Error(await readApiError(response))
  const payload = (await response.json()) as { config?: unknown; status?: unknown }
  if (!isGsuiteSettingsConfig(payload.config) || !isGsuiteSettingsStatus(payload.status)) throw new Error('Invalid G Suite settings response from backend.')
  return { config: payload.config, status: payload.status }
}

export async function disableGsuiteSettings(wsUrl: string): Promise<{ config: GsuiteSettingsConfig; status: GsuiteSettingsStatus }> {
  const endpoint = resolveApiEndpoint(wsUrl, '/api/integrations/gsuite')
  const response = await fetch(endpoint, { method: 'DELETE' })
  if (!response.ok) throw new Error(await readApiError(response))
  const payload = (await response.json()) as { config?: unknown; status?: unknown }
  if (!isGsuiteSettingsConfig(payload.config) || !isGsuiteSettingsStatus(payload.status)) throw new Error('Invalid G Suite settings response from backend.')
  return { config: payload.config, status: payload.status }
}

export async function submitGsuiteOAuthCredentials(wsUrl: string, oauthClientJson: string): Promise<{ config: GsuiteSettingsConfig; status: GsuiteSettingsStatus }> {
  const endpoint = resolveApiEndpoint(wsUrl, '/api/integrations/gsuite/oauth/credentials')
  const response = await fetch(endpoint, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ oauthClientJson }) })
  if (!response.ok) throw new Error(await readApiError(response))
  const payload = (await response.json()) as { config?: unknown; status?: unknown }
  if (!isGsuiteSettingsConfig(payload.config) || !isGsuiteSettingsStatus(payload.status)) throw new Error('Invalid G Suite credentials response from backend.')
  return { config: payload.config, status: payload.status }
}

export async function startGsuiteOAuth(wsUrl: string, payload: { email?: string; services?: string[] }): Promise<{ config: GsuiteSettingsConfig; status: GsuiteSettingsStatus; result: { authUrl: string; instructions?: string } }> {
  const endpoint = resolveApiEndpoint(wsUrl, '/api/integrations/gsuite/oauth/start')
  const response = await fetch(endpoint, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) })
  if (!response.ok) throw new Error(await readApiError(response))
  const body = (await response.json()) as { config?: unknown; status?: unknown; result?: { authUrl?: unknown; instructions?: unknown } }
  if (!isGsuiteSettingsConfig(body.config) || !isGsuiteSettingsStatus(body.status)) throw new Error('Invalid G Suite OAuth start response from backend.')
  const authUrl = typeof body.result?.authUrl === 'string' ? body.result.authUrl : ''
  if (!authUrl.trim()) throw new Error('Backend did not return a Google authorization URL.')
  return { config: body.config, status: body.status, result: { authUrl, instructions: typeof body.result?.instructions === 'string' ? body.result.instructions : undefined } }
}

export async function completeGsuiteOAuth(wsUrl: string, payload: { email?: string; authUrl: string; services?: string[] }): Promise<{ config: GsuiteSettingsConfig; status: GsuiteSettingsStatus }> {
  const endpoint = resolveApiEndpoint(wsUrl, '/api/integrations/gsuite/oauth/complete')
  const response = await fetch(endpoint, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) })
  if (!response.ok) throw new Error(await readApiError(response))
  const body = (await response.json()) as { config?: unknown; status?: unknown }
  if (!isGsuiteSettingsConfig(body.config) || !isGsuiteSettingsStatus(body.status)) throw new Error('Invalid G Suite OAuth complete response from backend.')
  return { config: body.config, status: body.status }
}

export async function testGsuiteConnection(wsUrl: string, payload: { email?: string }): Promise<{ config: GsuiteSettingsConfig; status: GsuiteSettingsStatus }> {
  const endpoint = resolveApiEndpoint(wsUrl, '/api/integrations/gsuite/test')
  const response = await fetch(endpoint, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) })
  if (!response.ok) throw new Error(await readApiError(response))
  const body = (await response.json()) as { config?: unknown; status?: unknown }
  if (!isGsuiteSettingsConfig(body.config) || !isGsuiteSettingsStatus(body.status)) throw new Error('Invalid G Suite test response from backend.')
  return { config: body.config, status: body.status }
}
