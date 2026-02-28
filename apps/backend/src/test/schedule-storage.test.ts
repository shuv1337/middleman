import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  getScheduleFilePath,
  getSchedulesDirectoryPath,
  normalizeManagerId,
} from '../scheduler/schedule-storage.js'

describe('schedule-storage', () => {
  it('normalizes manager id and rejects empty values', () => {
    expect(normalizeManagerId(' manager ')).toBe('manager')
    expect(() => normalizeManagerId('')).toThrow('managerId is required')
    expect(() => normalizeManagerId('   ')).toThrow('managerId is required')
  })

  it('resolves schedules directory and manager-scoped schedule files', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'swarm-schedules-path-'))

    expect(getSchedulesDirectoryPath(dataDir)).toBe(join(dataDir, 'schedules'))
    expect(getScheduleFilePath(dataDir, 'release-manager')).toBe(
      join(dataDir, 'schedules', 'release-manager.json'),
    )
  })
})
