import { describe, expect, it } from 'vitest'
import {
  buildMessageKey,
  normalizeRuntimeError,
  normalizeRuntimeImageAttachments,
  normalizeRuntimeUserMessage,
  previewForLog,
} from '../swarm/runtime-utils.js'

describe('runtime-utils', () => {
  it('normalizes user message inputs and drops invalid images', () => {
    expect(normalizeRuntimeUserMessage('hello')).toEqual({
      text: 'hello',
      images: [],
    })

    expect(
      normalizeRuntimeUserMessage({
        text: 'with images',
        images: [
          { mimeType: 'image/png', data: ' abc ' },
          { mimeType: 'text/plain', data: 'nope' },
          { mimeType: 'image/jpeg', data: '' },
          null as any,
        ],
      }),
    ).toEqual({
      text: 'with images',
      images: [{ mimeType: 'image/png', data: 'abc' }],
    })
  })

  it('produces stable message keys from normalized image payloads', () => {
    const images = normalizeRuntimeImageAttachments([
      { mimeType: 'image/png', data: 'abcd1234' },
      { mimeType: 'image/jpeg', data: 'efgh5678' },
    ])

    const keyA = buildMessageKey('  hi there  ', images)
    const keyB = buildMessageKey('hi there', [
      { mimeType: 'image/png', data: 'abcd1234' },
      { mimeType: 'image/jpeg', data: 'efgh5678' },
    ])

    expect(keyA).toBeDefined()
    expect(keyA).toBe(keyB)
    expect(buildMessageKey('   ', [])).toBeUndefined()
  })

  it('truncates previews and normalizes runtime errors', () => {
    const preview = previewForLog('  one\n two\tthree   ', 8)
    expect(preview).toBe('one two ...')

    const error = new Error('boom')
    expect(normalizeRuntimeError(error)).toMatchObject({ message: 'boom' })
    expect(normalizeRuntimeError('plain')).toEqual({ message: 'plain' })
  })
})
