import { useEffect, useId, useMemo, useRef, useState } from 'react'
import {
  AlertCircle,
  Check,
  ChevronDown,
  ChevronRight,
  File,
  FileText,
  Loader2,
  MessageSquare,
  Terminal,
  Users,
  X,
  type LucideIcon,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import type { ArtifactReference } from '@/lib/artifacts'
import { isImageAttachment } from '@/lib/file-attachments'
import { cn } from '@/lib/utils'
import type {
  ConversationAttachment,
  ConversationEntry,
  ConversationImageAttachment,
  MessageSourceContext,
} from '@/lib/ws-types'
import { MarkdownMessage } from './MarkdownMessage'

interface MessageListProps {
  messages: ConversationEntry[]
  isLoading: boolean
  activeAgentId?: string | null
  onSuggestionClick?: (suggestion: string) => void
  onArtifactClick?: (artifact: ArtifactReference) => void
}

const suggestions = ['Plan a Shuvlr workflow', 'Debug manager state', 'Summarize latest run']
const AUTO_SCROLL_THRESHOLD_PX = 100

type ConversationMessageEntry = Extract<ConversationEntry, { type: 'conversation_message' }>
type ConversationLogEntry = Extract<ConversationEntry, { type: 'conversation_log' }>
type AgentMessageEntry = Extract<ConversationEntry, { type: 'agent_message' }>
type AgentToolCallEntry = Extract<ConversationEntry, { type: 'agent_tool_call' }>
type ToolExecutionLogEntry = ConversationLogEntry & {
  kind: 'tool_execution_start' | 'tool_execution_update' | 'tool_execution_end'
}
type ToolExecutionEvent = ToolExecutionLogEntry | AgentToolCallEntry

type ToolDisplayStatus = 'pending' | 'completed' | 'cancelled' | 'error'

type ToolConfig = {
  label: string
  activeLabel: string
  cancelledLabel: string
  errorLabel: string
  icon?: LucideIcon
  getDetail?: (input: Record<string, unknown>) => string | null
}

interface ToolExecutionDisplayEntry {
  id: string
  actorAgentId?: string
  toolName?: string
  toolCallId?: string
  inputPayload?: string
  latestPayload?: string
  outputPayload?: string
  timestamp: string
  latestKind: ToolExecutionEvent['kind']
  isError?: boolean
}

type DisplayEntry =
  | {
      type: 'conversation_message'
      id: string
      message: ConversationMessageEntry
    }
  | {
      type: 'agent_message'
      id: string
      message: AgentMessageEntry
    }
  | {
      type: 'tool_execution'
      id: string
      entry: ToolExecutionDisplayEntry
    }
  | {
      type: 'runtime_error_log'
      id: string
      entry: ConversationLogEntry
    }

const TOOL_CONFIG: Record<string, ToolConfig> = {
  bash: {
    label: 'Ran command',
    activeLabel: 'Running command',
    cancelledLabel: 'Command cancelled',
    errorLabel: 'Command failed',
    icon: Terminal,
    getDetail: (input) => {
      const command = pickString(input, ['description', 'command'])
      return command ? truncate(command, 72) : null
    },
  },
  read: {
    label: 'Read file',
    activeLabel: 'Reading file',
    cancelledLabel: 'Read cancelled',
    errorLabel: 'Read failed',
    icon: FileText,
    getDetail: (input) => {
      const path = pickString(input, ['path'])
      return path ? truncate(path, 72) : null
    },
  },
  write: {
    label: 'Wrote file',
    activeLabel: 'Writing file',
    cancelledLabel: 'Write cancelled',
    errorLabel: 'Write failed',
    icon: FileText,
    getDetail: (input) => {
      const path = pickString(input, ['path'])
      return path ? truncate(path, 72) : null
    },
  },
  edit: {
    label: 'Edited file',
    activeLabel: 'Editing file',
    cancelledLabel: 'Edit cancelled',
    errorLabel: 'Edit failed',
    icon: FileText,
    getDetail: (input) => {
      const path = pickString(input, ['path'])
      return path ? truncate(path, 72) : null
    },
  },
  list_agents: {
    label: 'Checked agents',
    activeLabel: 'Checking agents',
    cancelledLabel: 'Agent check cancelled',
    errorLabel: 'Agent check failed',
    icon: Users,
  },
  send_message_to_agent: {
    label: 'Sent agent message',
    activeLabel: 'Sending agent message',
    cancelledLabel: 'Message cancelled',
    errorLabel: 'Message failed',
    icon: MessageSquare,
    getDetail: (input) => pickString(input, ['targetAgentId']) ?? null,
  },
}

function formatTimestamp(iso: string): string {
  try {
    return new Date(iso).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
  } catch {
    return ''
  }
}

function formatSourceBadge(sourceContext?: MessageSourceContext): string | null {
  if (!sourceContext) {
    return null
  }

  if (sourceContext.channel === 'web') {
    return 'Web'
  }

  const isSlack = sourceContext.channel === 'slack'
  const isTelegram = sourceContext.channel === 'telegram'
  const isDm =
    sourceContext.channelType === 'dm' || (isSlack && sourceContext.channelId?.startsWith('D'))
  let label = isTelegram ? 'Telegram' : 'Slack'

  if (isDm) {
    if (isTelegram) {
      label = sourceContext.userId ? `Telegram DM ${sourceContext.userId}` : 'Telegram DM'
    } else {
      label = sourceContext.userId ? `Slack DM ${sourceContext.userId}` : 'Slack DM'
    }
  } else if (sourceContext.channelId) {
    label = isTelegram ? `Telegram ${sourceContext.channelId}` : `Slack #${sourceContext.channelId}`
  }

  if (sourceContext.threadTs) {
    return `${label} → thread`
  }

  return label
}

function SourceBadge({
  sourceContext,
  isUser = false,
}: {
  sourceContext?: MessageSourceContext
  isUser?: boolean
}) {
  const label = formatSourceBadge(sourceContext)
  if (!label || !sourceContext) {
    return null
  }

  return (
    <span
      className={cn(
        'inline-flex items-center rounded-full border px-1.5 py-0.5 text-[10px] font-medium leading-none',
        isUser
          ? 'border-primary-foreground/30 bg-primary-foreground/10 text-primary-foreground/90'
          : sourceContext.channel === 'slack'
            ? 'border-[rgba(199,146,234,0.45)] bg-[rgba(199,146,234,0.14)] text-[color:var(--fleet-purple)]'
            : sourceContext.channel === 'telegram'
              ? 'border-primary/45 bg-primary/14 text-primary'
              : 'border-[rgba(173,219,103,0.45)] bg-[rgba(173,219,103,0.14)] text-[color:var(--fleet-ok)]',
      )}
    >
      [{label}]
    </span>
  )
}

function truncate(str: string, maxLen: number): string {
  if (str.length <= maxLen) return str
  return `${str.slice(0, maxLen)}…`
}

function pickString(record: Record<string, unknown>, keys: string[]): string | null {
  for (const key of keys) {
    const value = record[key]
    if (typeof value === 'string' && value.trim().length > 0) {
      return value.trim()
    }
  }

  return null
}

function parseJsonRecord(input: string | undefined): Record<string, unknown> {
  if (!input) return {}

  try {
    const parsed = JSON.parse(input)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return {}
    }

    return parsed as Record<string, unknown>
  } catch {
    return {}
  }
}

function formatPayload(value: string): string {
  try {
    return JSON.stringify(JSON.parse(value), null, 2)
  } catch {
    return value
  }
}

function humanizeToolName(toolName: string): string {
  return toolName
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/[_-]/g, ' ')
    .trim()
}

function isNearBottom(container: HTMLElement, threshold = AUTO_SCROLL_THRESHOLD_PX): boolean {
  const distanceFromBottom = container.scrollHeight - container.scrollTop - container.clientHeight
  return distanceFromBottom <= threshold
}

function isToolExecutionLog(entry: ConversationLogEntry): entry is ToolExecutionLogEntry {
  return (
    entry.kind === 'tool_execution_start' ||
    entry.kind === 'tool_execution_update' ||
    entry.kind === 'tool_execution_end'
  )
}

function isToolExecutionEvent(entry: ConversationEntry): entry is ToolExecutionEvent {
  if (entry.type === 'agent_tool_call') {
    return true
  }

  return entry.type === 'conversation_log' && isToolExecutionLog(entry)
}

function resolveToolExecutionEventActorAgentId(event: ToolExecutionEvent): string {
  return event.type === 'agent_tool_call' ? event.actorAgentId : event.agentId
}

function mapToolStatus(entry: ToolExecutionDisplayEntry): ToolDisplayStatus {
  if (entry.latestKind !== 'tool_execution_end') {
    return 'pending'
  }

  if (!entry.isError) {
    return 'completed'
  }

  const lowered = (entry.outputPayload ?? entry.latestPayload ?? '').toLowerCase()
  if (lowered.includes('[aborted]') || lowered.includes('cancel')) {
    return 'cancelled'
  }

  return 'error'
}

function getFriendlyToolMessage(
  toolName: string | undefined,
  input: Record<string, unknown>,
  status: ToolDisplayStatus,
): string {
  const normalizedToolName = (toolName ?? '').trim()
  const config = normalizedToolName ? TOOL_CONFIG[normalizedToolName] : undefined

  if (!config) {
    const friendlyName = humanizeToolName(normalizedToolName) || 'tool'

    if (status === 'completed') return `Ran ${friendlyName}`
    if (status === 'cancelled') return `Cancelled ${friendlyName}`
    if (status === 'error') return `${friendlyName} failed`
    return `Running ${friendlyName}`
  }

  const baseLabel =
    status === 'completed'
      ? config.label
      : status === 'cancelled'
        ? config.cancelledLabel
        : status === 'error'
          ? config.errorLabel
          : config.activeLabel

  const detail = config.getDetail?.(input)
  return detail ? `${baseLabel}: ${detail}` : baseLabel
}

function hydrateToolDisplayEntry(displayEntry: ToolExecutionDisplayEntry, event: ToolExecutionEvent): void {
  displayEntry.actorAgentId = resolveToolExecutionEventActorAgentId(event)
  displayEntry.toolName = event.toolName ?? displayEntry.toolName
  displayEntry.toolCallId = event.toolCallId ?? displayEntry.toolCallId
  displayEntry.timestamp = event.timestamp
  displayEntry.latestKind = event.kind

  if (event.kind === 'tool_execution_start') {
    displayEntry.inputPayload = event.text
    displayEntry.latestPayload = event.text
    displayEntry.outputPayload = undefined
    displayEntry.isError = false
    return
  }

  if (event.kind === 'tool_execution_update') {
    displayEntry.latestPayload = event.text
    return
  }

  displayEntry.outputPayload = event.text
  displayEntry.latestPayload = event.text
  displayEntry.isError = event.isError
}

function buildDisplayEntries(messages: ConversationEntry[]): DisplayEntry[] {
  const displayEntries: DisplayEntry[] = []
  const toolEntriesByCallId = new Map<string, ToolExecutionDisplayEntry>()

  for (const [index, message] of messages.entries()) {
    if (message.type === 'conversation_message') {
      displayEntries.push({
        type: 'conversation_message',
        id: `message-${message.timestamp}-${index}`,
        message,
      })
      continue
    }

    if (message.type === 'agent_message') {
      displayEntries.push({
        type: 'agent_message',
        id: `agent-message-${message.timestamp}-${index}`,
        message,
      })
      continue
    }

    if (isToolExecutionEvent(message)) {
      const actorAgentId = resolveToolExecutionEventActorAgentId(message)
      const callId = message.toolCallId?.trim()
      if (callId) {
        const toolGroupKey = `${actorAgentId}:${callId}`
        let displayEntry = toolEntriesByCallId.get(toolGroupKey)

        if (!displayEntry) {
          displayEntry = {
            id: `tool-${toolGroupKey}`,
            actorAgentId,
            toolName: message.toolName,
            toolCallId: callId,
            timestamp: message.timestamp,
            latestKind: message.kind,
          }

          displayEntries.push({
            type: 'tool_execution',
            id: displayEntry.id,
            entry: displayEntry,
          })

          toolEntriesByCallId.set(toolGroupKey, displayEntry)
        }

        hydrateToolDisplayEntry(displayEntry, message)
        continue
      }

      const displayEntry: ToolExecutionDisplayEntry = {
        id: `tool-${message.timestamp}-${index}`,
        actorAgentId,
        toolName: message.toolName,
        toolCallId: message.toolCallId,
        timestamp: message.timestamp,
        latestKind: message.kind,
      }

      hydrateToolDisplayEntry(displayEntry, message)

      displayEntries.push({
        type: 'tool_execution',
        id: displayEntry.id,
        entry: displayEntry,
      })

      continue
    }

    if (message.type === 'conversation_log' && message.isError) {
      displayEntries.push({
        type: 'runtime_error_log',
        id: `runtime-log-${message.timestamp}-${index}`,
        entry: message,
      })
    }
  }

  return displayEntries
}

function ToolPayloadBlock({
  label,
  value,
  tone,
}: {
  label: string
  value: string
  tone: ToolDisplayStatus | 'neutral'
}) {
  return (
    <div>
      <p className="mb-1 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">{label}</p>
      <pre
        className={cn(
          'max-h-64 w-full overflow-auto rounded-md border p-2 font-mono text-[11px] leading-relaxed whitespace-pre-wrap break-words',
          tone === 'error'
            ? 'border-destructive/30 bg-destructive/10 text-destructive'
            : tone === 'cancelled'
              ? 'border-[rgba(247,140,108,0.35)] bg-[rgba(247,140,108,0.14)] text-[color:var(--fleet-warn)]'
              : 'border-border/70 bg-secondary/45 text-foreground',
        )}
      >
        {formatPayload(value)}
      </pre>
    </div>
  )
}

function ToolExecutionRow({ entry }: { entry: ToolExecutionDisplayEntry }) {
  const [isExpanded, setIsExpanded] = useState(false)
  const contentId = useId()

  const displayStatus = mapToolStatus(entry)
  const inputRecord = parseJsonRecord(entry.inputPayload ?? entry.latestPayload)
  const friendlyMessage = getFriendlyToolMessage(entry.toolName, inputRecord, displayStatus)
  const actorLabel = entry.actorAgentId?.trim()

  const config = entry.toolName ? TOOL_CONFIG[entry.toolName] : undefined
  const ToolIcon = config?.icon

  const outputPayload =
    entry.outputPayload ??
    (entry.latestPayload && entry.latestPayload !== entry.inputPayload ? entry.latestPayload : undefined)

  const outputLabel =
    displayStatus === 'pending'
      ? 'Update'
      : displayStatus === 'cancelled'
        ? 'Cancelled'
        : displayStatus === 'error'
          ? 'Error'
          : 'Result'

  return (
    <div className="rounded-md">
      <Button
        type="button"
        variant="ghost"
        className={cn(
          'group h-auto w-full items-start justify-start gap-1.5 rounded-md px-1 py-1 text-left text-sm font-normal text-foreground/70 italic transition-colors',
          'hover:text-foreground',
          'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60',
        )}
        aria-expanded={isExpanded}
        aria-controls={contentId}
        onClick={() => setIsExpanded((previous) => !previous)}
      >
        <span className="mt-0.5 inline-flex size-4 shrink-0 items-center justify-center">
          {displayStatus === 'completed' ? (
            ToolIcon ? (
              <ToolIcon className="size-3.5 text-[color:var(--fleet-ok)]" aria-hidden="true" />
            ) : (
              <Check className="size-3.5 text-[color:var(--fleet-ok)]" aria-hidden="true" />
            )
          ) : displayStatus === 'cancelled' ? (
            <X className="size-3.5 text-[color:var(--fleet-warn)]" aria-hidden="true" />
          ) : displayStatus === 'error' ? (
            <AlertCircle className="size-3.5 text-destructive" aria-hidden="true" />
          ) : (
            <Loader2 className="size-3.5 animate-spin text-foreground/50" aria-hidden="true" />
          )}
        </span>

        <span className="min-w-0 flex-1 break-words">
          {actorLabel ? (
            <span className="mr-1.5 inline-flex items-center rounded-sm border border-border/70 bg-muted/50 px-1.5 py-0.5 text-[10px] font-medium not-italic text-muted-foreground">
              {actorLabel}
            </span>
          ) : null}
          {friendlyMessage}
        </span>

        <ChevronRight
          className={cn(
            'mt-0.5 size-3.5 shrink-0 text-muted-foreground/80 opacity-0 transition-all group-hover:opacity-100',
            isExpanded && 'rotate-90',
          )}
          aria-hidden="true"
        />
      </Button>

      <div
        id={contentId}
        className={cn(
          'grid transition-[grid-template-rows] duration-200 ease-out',
          isExpanded ? 'grid-rows-[1fr]' : 'grid-rows-[0fr]',
        )}
      >
        <div className="overflow-hidden">
          <div className="ml-6 mt-1 space-y-2 pb-1">
            {entry.inputPayload ? <ToolPayloadBlock label="Input" value={entry.inputPayload} tone="neutral" /> : null}
            {outputPayload ? (
              <ToolPayloadBlock
                label={outputLabel}
                value={outputPayload}
                tone={displayStatus === 'pending' ? 'neutral' : displayStatus}
              />
            ) : null}

            <div className="flex flex-wrap items-center gap-1.5 text-[11px] text-muted-foreground">
              <span>{formatTimestamp(entry.timestamp)}</span>
              {actorLabel ? <span>• {actorLabel}</span> : null}
              {entry.toolName ? <span>• {entry.toolName}</span> : null}
              {entry.toolCallId ? <span>• {entry.toolCallId}</span> : null}
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}

function RuntimeErrorLog({ entry }: { entry: ConversationLogEntry }) {
  return (
    <div className="rounded-md border border-destructive/25 bg-destructive/10 px-3 py-2 text-sm text-destructive">
      <div className="mb-1 text-[11px] font-medium uppercase tracking-wide text-destructive/80">Runtime error</div>
      <p className="whitespace-pre-wrap break-words leading-relaxed">{entry.text}</p>
    </div>
  )
}

function AgentMessageRow({ message }: { message: AgentMessageEntry }) {
  const fromLabel =
    message.source === 'user_to_agent' ? 'User' : (message.fromAgentId?.trim() || 'Agent')
  const toLabel = message.toAgentId.trim() || 'Unknown'
  const normalizedText = message.text.trim()
  const attachmentCount = message.attachmentCount ?? 0
  const timestampLabel = formatTimestamp(message.timestamp)
  const sourceContext = message.sourceContext
  const deliveryLabel =
    message.requestedDelivery || message.acceptedMode
      ? [
          message.requestedDelivery ? `requested ${message.requestedDelivery}` : null,
          message.acceptedMode ? `accepted ${message.acceptedMode}` : null,
        ]
          .filter(Boolean)
          .join(' • ')
      : null

  return (
    <div className="rounded-lg border border-border/70 bg-secondary/35 px-3 py-2 text-sm text-foreground shadow-[inset_0_0_0_1px_rgba(130,170,255,0.04)]">
      <div className="flex flex-wrap items-center gap-1.5 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
        <span>{fromLabel}</span>
        <span>→</span>
        <span>{toLabel}</span>
        {deliveryLabel ? <span className="normal-case tracking-normal text-muted-foreground/80">• {deliveryLabel}</span> : null}
      </div>

      <div className="mt-1 space-y-1.5">
        {normalizedText ? <p className="whitespace-pre-wrap break-words leading-relaxed">{normalizedText}</p> : null}
        {attachmentCount > 0 ? (
          <p className="text-[11px] text-muted-foreground/85">
            Sent {attachmentCount} attachment{attachmentCount === 1 ? '' : 's'}
          </p>
        ) : null}
        {!normalizedText && attachmentCount === 0 ? (
          <p className="text-[11px] italic text-muted-foreground/75">(empty message)</p>
        ) : null}
      </div>

      {timestampLabel || sourceContext ? (
        <div className="mt-1 flex flex-wrap items-center gap-1.5 text-[11px] text-muted-foreground/80">
          <SourceBadge sourceContext={sourceContext} />
          {timestampLabel ? <span>{timestampLabel}</span> : null}
        </div>
      ) : null}
    </div>
  )
}

function MessageImageAttachments({
  attachments,
  isUser,
}: {
  attachments: ConversationImageAttachment[]
  isUser: boolean
}) {
  if (attachments.length === 0) {
    return null
  }

  return (
    <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
      {attachments.map((attachment, index) => {
        const src = `data:${attachment.mimeType};base64,${attachment.data}`
        return (
          <img
            key={`${attachment.mimeType}-${attachment.data.slice(0, 32)}-${index}`}
            src={src}
            alt={attachment.fileName || `Attached image ${index + 1}`}
            className={cn(
              'max-h-56 w-full rounded-lg object-cover',
              isUser ? 'border border-primary-foreground/25' : 'border border-border',
            )}
            loading="lazy"
          />
        )
      })}
    </div>
  )
}

function MessageFileAttachments({
  attachments,
  isUser,
}: {
  attachments: ConversationAttachment[]
  isUser: boolean
}) {
  if (attachments.length === 0) {
    return null
  }

  return (
    <div className="space-y-1.5">
      {attachments.map((attachment, index) => {
        const isTextFile = attachment.type === 'text'
        const fileName = attachment.fileName || `Attachment ${index + 1}`
        const subtitle = isTextFile ? 'Text file' : 'Binary file'

        return (
          <div
            key={`${attachment.mimeType}-${fileName}-${index}`}
            className={cn(
              'flex items-center gap-2 rounded-md border px-2 py-1.5',
              isUser
                ? 'border-primary-foreground/25 bg-primary-foreground/10 text-primary-foreground'
                : 'border-border bg-muted/35 text-foreground',
            )}
          >
            <span
              className={cn(
                'inline-flex size-6 items-center justify-center rounded',
                isUser ? 'bg-primary-foreground/15 text-primary-foreground' : 'bg-muted text-muted-foreground',
              )}
            >
              {isTextFile ? <FileText className="size-3.5" /> : <File className="size-3.5" />}
            </span>
            <span className="min-w-0">
              <p className="truncate text-xs font-medium">{fileName}</p>
              <p className={cn('truncate text-[11px]', isUser ? 'text-primary-foreground/80' : 'text-muted-foreground')}>
                {subtitle} • {attachment.mimeType}
              </p>
            </span>
          </div>
        )
      })}
    </div>
  )
}

function ConversationMessage({
  message,
  onArtifactClick,
}: {
  message: ConversationMessageEntry
  onArtifactClick?: (artifact: ArtifactReference) => void
}) {
  const normalizedText = message.text.trim()
  const hasText = normalizedText.length > 0 && normalizedText !== '.'
  const attachments = message.attachments ?? []
  const imageAttachments = attachments.filter(isImageAttachment)
  const fileAttachments = attachments.filter((attachment) => !isImageAttachment(attachment))
  const hasAttachments = imageAttachments.length > 0 || fileAttachments.length > 0

  if (!hasText && !hasAttachments) {
    return null
  }

  const timestampLabel = formatTimestamp(message.timestamp)
  const sourceContext = message.sourceContext

  if (message.role === 'system') {
    return (
      <div className="rounded-lg border border-[rgba(247,140,108,0.38)] bg-[rgba(247,140,108,0.12)] px-3 py-2 text-sm text-[color:var(--fleet-salmon)]">
        <div className="text-[11px] font-medium uppercase tracking-wide text-[color:var(--fleet-warn)]">System</div>
        <div className="mt-1 space-y-2">
          {hasText ? <p className="whitespace-pre-wrap break-words leading-relaxed">{normalizedText}</p> : null}
          <MessageImageAttachments attachments={imageAttachments} isUser={false} />
          <MessageFileAttachments attachments={fileAttachments} isUser={false} />
        </div>
        {timestampLabel || sourceContext ? (
          <div className="mt-1 flex items-center gap-1.5 text-[11px] text-[rgba(247,140,108,0.85)]">
            <SourceBadge sourceContext={sourceContext} />
            {timestampLabel ? <span>{timestampLabel}</span> : null}
          </div>
        ) : null}
      </div>
    )
  }

  if (message.role === 'user') {
    return (
      <div className="flex justify-end">
        <div className="max-w-[85%] rounded-lg rounded-tr-sm bg-primary px-3 py-2 text-primary-foreground">
          <div className="space-y-2">
            <MessageImageAttachments attachments={imageAttachments} isUser />
            <MessageFileAttachments attachments={fileAttachments} isUser />
            {hasText ? <p className="whitespace-pre-wrap break-words text-sm leading-relaxed">{normalizedText}</p> : null}
          </div>
          {timestampLabel || sourceContext ? (
            <div className="mt-1 flex items-center justify-end gap-1.5">
              <SourceBadge sourceContext={sourceContext} isUser />
              {timestampLabel ? (
                <p className="text-right text-[10px] leading-none text-primary-foreground/70">{timestampLabel}</p>
              ) : null}
            </div>
          ) : null}
        </div>
      </div>
    )
  }

  return (
    <div className="min-w-0 space-y-2 text-foreground">
      {hasText ? <MarkdownMessage content={normalizedText} onArtifactClick={onArtifactClick} /> : null}
      <MessageImageAttachments attachments={imageAttachments} isUser={false} />
      <MessageFileAttachments attachments={fileAttachments} isUser={false} />
      {timestampLabel || sourceContext ? (
        <div className="flex items-center gap-1.5 text-[11px] leading-none text-muted-foreground/70">
          <SourceBadge sourceContext={sourceContext} />
          {timestampLabel ? <span>{timestampLabel}</span> : null}
        </div>
      ) : null}
    </div>
  )
}

function LoadingIndicator() {
  return (
    <div className="mt-3 flex justify-start" role="status" aria-live="polite" aria-label="Assistant is working">
      <div className="flex items-center gap-0.5">
        <div className="size-1.5 animate-bounce rounded-full bg-foreground/40 [animation-duration:900ms]" />
        <div className="size-1.5 animate-bounce rounded-full bg-foreground/40 [animation-delay:150ms] [animation-duration:900ms]" />
        <div className="size-1.5 animate-bounce rounded-full bg-foreground/40 [animation-delay:300ms] [animation-duration:900ms]" />
      </div>
    </div>
  )
}

function EmptyState({
  activeAgentId,
  onSuggestionClick,
}: {
  activeAgentId?: string | null
  onSuggestionClick?: (suggestion: string) => void
}) {
  if (!activeAgentId) {
    return (
      <div className="flex h-full flex-col items-center justify-center p-6 text-center">
        <h2 className="mb-2 text-base font-medium text-foreground">No manager selected</h2>
        <p className="text-sm text-muted-foreground">
          Create a manager from the sidebar to start a thread.
        </p>
      </div>
    )
  }

  return (
    <div className="flex h-full flex-col items-center justify-center p-6 text-center">
      <h2 className="mb-4 text-base font-medium text-foreground">What can I do for you?</h2>
      {onSuggestionClick ? (
        <div className="flex max-w-[320px] flex-wrap justify-center gap-2">
          {suggestions.map((suggestion) => (
            <Button
              key={suggestion}
              onClick={() => onSuggestionClick(suggestion)}
              type="button"
              variant="outline"
              className="h-auto rounded-full bg-muted px-3 py-1.5 text-sm font-normal text-foreground transition-colors hover:bg-muted/80"
            >
              {suggestion}
            </Button>
          ))}
        </div>
      ) : null}
      <p className="mt-6 text-xs text-muted-foreground">AI can make mistakes. Always verify important actions.</p>
    </div>
  )
}

export function MessageList({
  messages,
  isLoading,
  activeAgentId,
  onSuggestionClick,
  onArtifactClick,
}: MessageListProps) {
  const scrollContainerRef = useRef<HTMLDivElement | null>(null)
  const bottomRef = useRef<HTMLDivElement | null>(null)
  const previousAgentIdRef = useRef<string | null>(null)
  const previousFirstEntryIdRef = useRef<string | null>(null)
  const previousEntryCountRef = useRef(0)
  const hasScrolledRef = useRef(false)
  const isAtBottomRef = useRef(true)
  const [showScrollButton, setShowScrollButton] = useState(false)

  const displayEntries = useMemo(() => buildDisplayEntries(messages), [messages])

  const updateIsAtBottom = () => {
    const container = scrollContainerRef.current
    if (!container) {
      isAtBottomRef.current = true
      setShowScrollButton(false)
      return
    }

    const isAtBottom = isNearBottom(container)
    isAtBottomRef.current = isAtBottom
    setShowScrollButton(!isAtBottom)
  }

  const handleScroll = () => {
    updateIsAtBottom()
  }

  useEffect(() => {
    const nextAgentId = activeAgentId ?? null
    const nextFirstEntryId = displayEntries[0]?.id ?? null
    const nextEntryCount = displayEntries.length

    const isInitialScroll = !hasScrolledRef.current
    const didAgentChange = previousAgentIdRef.current !== nextAgentId
    const didConversationReset =
      previousEntryCountRef.current > 0 &&
      (nextEntryCount === 0 ||
        previousFirstEntryIdRef.current !== nextFirstEntryId ||
        nextEntryCount < previousEntryCountRef.current)
    const didInitialConversationLoad = previousEntryCountRef.current === 0 && nextEntryCount > 0

    const shouldForceScroll =
      isInitialScroll || didAgentChange || didConversationReset || didInitialConversationLoad
    const shouldAutoScroll = shouldForceScroll || isAtBottomRef.current

    if (shouldAutoScroll) {
      bottomRef.current?.scrollIntoView({
        behavior: shouldForceScroll ? 'instant' : 'smooth',
        block: 'end',
      })
      isAtBottomRef.current = true
      setShowScrollButton(false)
    }

    hasScrolledRef.current = true
    previousAgentIdRef.current = nextAgentId
    previousFirstEntryIdRef.current = nextFirstEntryId
    previousEntryCountRef.current = nextEntryCount
  }, [activeAgentId, displayEntries, isLoading])

  if (displayEntries.length === 0 && !isLoading) {
    return <EmptyState activeAgentId={activeAgentId} onSuggestionClick={onSuggestionClick} />
  }

  const handleScrollToBottom = () => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' })
    isAtBottomRef.current = true
    setShowScrollButton(false)
  }

  return (
    <div className="relative min-h-0 flex flex-1 flex-col overflow-hidden bg-[linear-gradient(180deg,rgba(1,17,29,0.28),rgba(1,17,29,0.62))]">
      <div
        ref={scrollContainerRef}
        onScroll={handleScroll}
        className={cn(
          'min-h-0 flex-1 overflow-y-auto',
          '[&::-webkit-scrollbar]:w-1.5 [&::-webkit-scrollbar-track]:bg-transparent',
          '[&::-webkit-scrollbar-thumb]:rounded-full [&::-webkit-scrollbar-thumb]:bg-transparent',
          '[scrollbar-width:thin] [scrollbar-color:transparent_transparent]',
          'hover:[&::-webkit-scrollbar-thumb]:bg-border hover:[scrollbar-color:var(--color-border)_transparent]',
        )}
      >
        <div className="space-y-2 p-2 pb-[calc(var(--tab-bar-height)+var(--safe-bottom)+0.75rem)] md:p-3 md:pb-3">
          {displayEntries.map((entry) => {
            if (entry.type === 'conversation_message') {
              return (
                <ConversationMessage
                  key={entry.id}
                  message={entry.message}
                  onArtifactClick={onArtifactClick}
                />
              )
            }

            if (entry.type === 'agent_message') {
              return <AgentMessageRow key={entry.id} message={entry.message} />
            }

            if (entry.type === 'tool_execution') {
              return <ToolExecutionRow key={entry.id} entry={entry.entry} />
            }

            return <RuntimeErrorLog key={entry.id} entry={entry.entry} />
          })}
          {isLoading ? <LoadingIndicator /> : null}
          <div ref={bottomRef} />
        </div>
      </div>

      <div className="pointer-events-none absolute inset-x-0 bottom-[calc(var(--tab-bar-height)+var(--safe-bottom)+0.5rem)] z-10 flex justify-center px-4 md:bottom-4">
        <Button
          type="button"
          size="icon"
          tabIndex={showScrollButton ? 0 : -1}
          aria-hidden={!showScrollButton}
          aria-label="Scroll to latest message"
          onClick={handleScrollToBottom}
          className={cn(
            'size-9 rounded-full border border-border bg-card/90 text-foreground shadow-[var(--fleet-shadow)] backdrop-blur-md',
            'transition-opacity transition-transform duration-200',
            showScrollButton
              ? 'pointer-events-auto translate-y-0 opacity-100'
              : 'pointer-events-none translate-y-2 opacity-0',
          )}
        >
          <ChevronDown className="size-4" aria-hidden="true" />
        </Button>
      </div>
    </div>
  )
}
