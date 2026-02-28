#!/usr/bin/env node
import { readdir, readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { homedir } from 'node:os'

const dataDir = resolve(process.env.SHUVLR_DATA_DIR ?? resolve(homedir(), '.shuvlr'))
const memoryDir = resolve(dataDir, 'memory')
const shuvdoApi = process.env.SHUVDO_API?.trim()
const shuvdoToken = process.env.SHUVDO_TOKEN?.trim()
const defaultList = process.env.SHUVDO_FOLLOWUPS_LIST?.trim() ?? 'follow-ups'
const apply = process.argv.includes('--apply')

const followups = []

for (const entry of await readdir(memoryDir, { withFileTypes: true }).catch(() => [])) {
  if (!entry.isFile() || !entry.name.endsWith('.md')) continue

  const filePath = resolve(memoryDir, entry.name)
  const content = await readFile(filePath, 'utf8')
  const extracted = extractOpenFollowups(content)
  for (const item of extracted) {
    followups.push({ filePath, ...item })
  }
}

if (followups.length === 0) {
  console.log('No legacy "Open Follow-ups" bullets found.')
  process.exit(0)
}

console.log(`Found ${followups.length} follow-up bullets in legacy memory sections.`)
for (const item of followups) {
  console.log(`- ${item.filePath}: ${item.text}`)
}

if (!apply) {
  console.log('\nDry run only. Re-run with --apply to create Shuvdo tasks.')
  process.exit(0)
}

if (!shuvdoApi || !shuvdoToken) {
  console.error('Missing SHUVDO_API/SHUVDO_TOKEN for --apply mode.')
  process.exit(1)
}

for (const item of followups) {
  const listName = item.list ?? defaultList
  const payload = {
    text: item.text,
    note: `Migrated from ${item.filePath}`,
  }

  const response = await fetch(`${shuvdoApi}/api/list/${encodeURIComponent(listName)}/add`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${shuvdoToken}`,
    },
    body: JSON.stringify(payload),
  })

  if (!response.ok) {
    const body = await response.text()
    console.error(`Failed to migrate "${item.text}": ${response.status} ${body}`)
    continue
  }

  console.log(`Migrated to list "${listName}": ${item.text}`)
}

function extractOpenFollowups(markdown) {
  const lines = markdown.split(/\r?\n/)
  const results = []
  let inSection = false

  for (const rawLine of lines) {
    const line = rawLine.trim()

    if (/^##\s+open\s+follow-ups\s*$/i.test(line)) {
      inSection = true
      continue
    }

    if (inSection && /^##\s+/.test(line)) {
      inSection = false
    }

    if (!inSection) continue

    const bullet = /^[-*]\s+(.+)$/.exec(line)
    if (!bullet) continue

    const text = bullet[1].trim()
    if (!text || text === '(none yet)') continue

    results.push({ text })
  }

  return results
}
