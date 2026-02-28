import { describe, expect, it, vi } from 'vitest'
import { SlackInboundRouter } from '../integrations/slack/slack-router.js'
import type { SlackIntegrationConfig } from '../integrations/slack/slack-types.js'

function makeConfig(overrides?: Partial<SlackIntegrationConfig>): SlackIntegrationConfig {
  return {
    profileId: 'default',
    enabled: true,
    mode: 'socket',
    appToken: 'xapp-test',
    botToken: 'xoxb-test',
    listen: {
      dm: true,
      channelIds: [],
      includePrivateChannels: true,
    },
    response: {
      respondInThread: true,
      replyBroadcast: false,
      wakeWords: [],
    },
    attachments: {
      maxFileBytes: 1024 * 1024,
      allowImages: true,
      allowText: true,
      allowBinary: false,
    },
    ...overrides,
  }
}

describe('SlackInboundRouter', () => {
  it('deduplicates inbound events by event_id', async () => {
    const handleUserMessage = vi.fn(async () => {})

    const router = new SlackInboundRouter({
      swarmManager: {
        handleUserMessage,
      } as any,
      managerId: 'manager',
      integrationProfileId: 'default',
      slackClient: {
        downloadFile: vi.fn(),
        getFileInfo: vi.fn(),
      } as any,
      getConfig: () => makeConfig(),
      getBotUserId: () => 'U_BOT',
    })

    const envelope = {
      type: 'events_api',
      body: {
        event_id: 'evt-1',
        team_id: 'T123',
        event: {
          type: 'message',
          user: 'U123',
          text: 'hello manager',
          channel: 'C123',
          ts: '100.1',
          channel_type: 'channel',
        },
      },
    }

    await router.handleEnvelope(envelope as any)
    await router.handleEnvelope(envelope as any)

    expect(handleUserMessage).toHaveBeenCalledTimes(1)
  })

  it('ignores messages from disallowed channels', async () => {
    const handleUserMessage = vi.fn(async () => {})

    const router = new SlackInboundRouter({
      swarmManager: {
        handleUserMessage,
      } as any,
      managerId: 'manager',
      integrationProfileId: 'default',
      slackClient: {
        downloadFile: vi.fn(),
        getFileInfo: vi.fn(),
      } as any,
      getConfig: () =>
        makeConfig({
          listen: {
            dm: false,
            channelIds: ['C_ALLOWED'],
            includePrivateChannels: false,
          },
        }),
      getBotUserId: () => 'U_BOT',
    })

    await router.handleEnvelope({
      type: 'events_api',
      body: {
        event_id: 'evt-2',
        team_id: 'T123',
        event: {
          type: 'message',
          user: 'U123',
          text: 'hello from disallowed channel',
          channel: 'C_DENIED',
          ts: '200.1',
          channel_type: 'channel',
        },
      },
    } as any)

    expect(handleUserMessage).not.toHaveBeenCalled()
  })

  it('routes channel messages into thread context when respondInThread is enabled', async () => {
    const handleUserMessage = vi.fn(async () => {})

    const router = new SlackInboundRouter({
      swarmManager: {
        handleUserMessage,
      } as any,
      managerId: 'manager',
      integrationProfileId: 'default',
      slackClient: {
        downloadFile: vi.fn(),
        getFileInfo: vi.fn(),
      } as any,
      getConfig: () => makeConfig({ response: { respondInThread: true, replyBroadcast: false, wakeWords: [] } }),
      getBotUserId: () => 'U_BOT',
    })

    await router.handleEnvelope({
      type: 'events_api',
      body: {
        event_id: 'evt-3',
        team_id: 'T123',
        event: {
          type: 'message',
          user: 'U123',
          text: 'thread me',
          channel: 'C123',
          ts: '300.1',
          channel_type: 'channel',
        },
      },
    } as any)

    expect(handleUserMessage).toHaveBeenCalledTimes(1)
    expect(handleUserMessage).toHaveBeenCalledWith('thread me', {
      targetAgentId: 'manager',
      attachments: [],
      sourceContext: expect.objectContaining({
        channel: 'slack',
        channelId: 'C123',
        threadTs: '300.1',
        integrationProfileId: 'default',
      }),
    })
  })
})
