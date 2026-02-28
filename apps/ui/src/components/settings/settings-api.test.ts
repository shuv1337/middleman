import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  fetchSettingsEnvVariables,
  resolveApiEndpoint,
  startSettingsAuthOAuthLoginStream,
  toErrorMessage,
} from './settings-api'

afterEach(() => {
  vi.restoreAllMocks()
})

describe('settings-api', () => {
  it('resolves API endpoint from websocket URL', () => {
    expect(resolveApiEndpoint('ws://127.0.0.1:47187', '/api/settings/env')).toBe(
      'http://127.0.0.1:47187/api/settings/env',
    )

    expect(resolveApiEndpoint('wss://shuvlr.example.com/ws', '/api/settings/env')).toBe(
      'https://shuvlr.example.com/api/settings/env',
    )
  })

  it('normalizes unknown errors into user-safe text', () => {
    expect(toErrorMessage(new Error('boom'))).toBe('boom')
    expect(toErrorMessage('raw')).toBe('An unexpected error occurred.')
  })

  it('parses settings env payload and filters invalid entries', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          variables: [
            { name: 'BRAVE_API_KEY', skillName: 'brave-search', required: true, isSet: true },
            { invalid: true },
          ],
        }),
        {
          status: 200,
          headers: { 'content-type': 'application/json' },
        },
      ),
    )

    const variables = await fetchSettingsEnvVariables('ws://127.0.0.1:47187')

    expect(fetchSpy).toHaveBeenCalledTimes(1)
    expect(variables).toEqual([
      {
        name: 'BRAVE_API_KEY',
        skillName: 'brave-search',
        required: true,
        isSet: true,
      },
    ])
  })

  it('parses OAuth login SSE stream events', async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        const encoder = new TextEncoder()
        controller.enqueue(
          encoder.encode(
            [
              'event: auth_url',
              'data: {"url":"https://auth.example.com","instructions":"Open this URL"}',
              '',
              'event: progress',
              'data: {"message":"Waiting for OAuth callback"}',
              '',
              'event: complete',
              'data: {"provider":"anthropic","status":"connected"}',
              '',
            ].join('\n'),
          ),
        )
        controller.close()
      },
    })

    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(stream, {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      }),
    )

    const events: string[] = []

    await startSettingsAuthOAuthLoginStream(
      'ws://127.0.0.1:47187',
      'anthropic',
      {
        onAuthUrl(event) {
          events.push(`auth_url:${event.url}`)
        },
        onPrompt() {
          events.push('prompt')
        },
        onProgress(event) {
          events.push(`progress:${event.message}`)
        },
        onComplete(event) {
          events.push(`complete:${event.provider}:${event.status}`)
        },
        onError(message) {
          events.push(`error:${message}`)
        },
      },
      new AbortController().signal,
    )

    expect(events).toEqual([
      'auth_url:https://auth.example.com',
      'progress:Waiting for OAuth callback',
      'complete:anthropic:connected',
    ])
  })
})
