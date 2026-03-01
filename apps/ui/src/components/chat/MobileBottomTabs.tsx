import type { ComponentType } from 'react'
import { Files, MessageSquare, Settings, Users2 } from 'lucide-react'
import { cn } from '@/lib/utils'

export type MobileChatTab = 'agents' | 'chat' | 'artifacts' | 'settings'

interface MobileBottomTabsProps {
  activeTab: MobileChatTab
  onTabChange: (tab: MobileChatTab) => void
}

const TABS: Array<{
  id: MobileChatTab
  label: string
  icon: ComponentType<{ className?: string }>
}> = [
  { id: 'agents', label: 'Agents', icon: Users2 },
  { id: 'chat', label: 'Chat', icon: MessageSquare },
  { id: 'artifacts', label: 'Artifacts', icon: Files },
  { id: 'settings', label: 'Settings', icon: Settings },
]

export function MobileBottomTabs({ activeTab, onTabChange }: MobileBottomTabsProps) {
  return (
    <nav
      className={cn(
        'fixed inset-x-0 bottom-0 z-30 flex min-h-[var(--tab-bar-height)] border-t border-border/80 bg-[rgba(1,17,29,0.94)] backdrop-blur-xl md:hidden',
        'px-[var(--safe-left)] pb-[max(0.2rem,var(--safe-bottom))] pr-[var(--safe-right)]',
      )}
      aria-label="Mobile navigation"
    >
      {TABS.map((tab) => {
        const Icon = tab.icon
        const isActive = activeTab === tab.id

        return (
          <button
            key={tab.id}
            type="button"
            onClick={() => onTabChange(tab.id)}
            className={cn(
              'flex min-h-[var(--tab-bar-height)] flex-1 flex-col items-center justify-center gap-0.5 px-1 text-[10px] uppercase tracking-[0.08em] transition-colors',
              isActive
                ? 'text-[color:var(--accent)] [text-shadow:0_0_10px_rgba(127,219,202,0.45)]'
                : 'text-muted-foreground hover:text-foreground',
            )}
            aria-pressed={isActive}
          >
            <Icon className="size-4" aria-hidden="true" />
            <span>{tab.label}</span>
          </button>
        )
      })}
    </nav>
  )
}
