import { describe, expect, it } from 'vitest'
import { extractAuthUrlFromOutput, parseGogJsonOutput } from '../integrations/gsuite/gsuite-gog.js'

describe('gsuite-gog helpers', () => {
  it('parses JSON output directly', () => {
    expect(parseGogJsonOutput('{"ok":true}')).toEqual({ ok: true })
  })

  it('parses trailing JSON line after noisy logs', () => {
    const stdout = [
      'Starting oauth flow...',
      'Waiting for redirect URL',
      '{"auth_url":"https://accounts.google.com/o/oauth2/auth?mock=1"}',
    ].join('\n')

    expect(parseGogJsonOutput(stdout)).toEqual({
      auth_url: 'https://accounts.google.com/o/oauth2/auth?mock=1',
    })
  })

  it('extracts auth URL from direct and nested payload shapes', () => {
    expect(extractAuthUrlFromOutput({ auth_url: 'https://example.com/direct' })).toBe(
      'https://example.com/direct',
    )
    expect(
      extractAuthUrlFromOutput({
        data: {
          authUrl: 'https://example.com/nested',
        },
      }),
    ).toBe('https://example.com/nested')
  })

  it('throws a clear error for non-JSON output', () => {
    expect(() => parseGogJsonOutput('not json at all')).toThrow('Failed to parse JSON output from gog')
  })
})
