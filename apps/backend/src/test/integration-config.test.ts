import { describe, expect, it } from 'vitest'
import {
  createDefaultSlackConfig,
  maskSlackConfig,
  mergeSlackConfig,
} from '../integrations/slack/slack-config.js'
import {
  createDefaultTelegramConfig,
  maskTelegramConfig,
  mergeTelegramConfig,
} from '../integrations/telegram/telegram-config.js'

describe('integration config merge + mask', () => {
  it('merges and masks slack config safely', () => {
    const base = createDefaultSlackConfig('manager')

    const merged = mergeSlackConfig(base, {
      appToken: ' xapp-super-secret ',
      botToken: ' xoxb-super-secret ',
      listen: {
        channelIds: ['C1', ' C1 ', 'C2'],
      },
      attachments: {
        maxFileBytes: 999,
      },
    })

    expect(merged.appToken).toBe('xapp-super-secret')
    expect(merged.botToken).toBe('xoxb-super-secret')
    expect(merged.listen.channelIds).toEqual(['C1', 'C2'])
    expect(merged.attachments.maxFileBytes).toBeGreaterThanOrEqual(1024)

    const masked = maskSlackConfig(merged)
    expect(masked.hasAppToken).toBe(true)
    expect(masked.hasBotToken).toBe(true)
    expect(masked.appToken).not.toBe('xapp-super-secret')
    expect(masked.botToken).not.toBe('xoxb-super-secret')
  })

  it('merges and masks telegram config safely', () => {
    const base = createDefaultTelegramConfig('manager')

    const merged = mergeTelegramConfig(base, {
      botToken: ' 123456:ABCDEF ',
      allowedUserIds: ['100', '100', '200'],
      polling: {
        timeoutSeconds: 999,
        limit: 0,
      },
    })

    expect(merged.botToken).toBe('123456:ABCDEF')
    expect(merged.allowedUserIds).toEqual(['100', '200'])
    expect(merged.polling.timeoutSeconds).toBeLessThanOrEqual(60)
    expect(merged.polling.limit).toBeGreaterThanOrEqual(1)

    const masked = maskTelegramConfig(merged)
    expect(masked.hasBotToken).toBe(true)
    expect(masked.botToken).not.toBe('123456:ABCDEF')
  })
})
