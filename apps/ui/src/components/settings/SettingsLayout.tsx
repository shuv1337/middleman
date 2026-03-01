import { ArrowLeft, Settings, KeyRound, Blocks, Wrench } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'

export type SettingsTab = 'general' | 'auth' | 'integrations' | 'skills'

interface NavItem {
  id: SettingsTab
  label: string
  icon: React.ReactNode
}

const NAV_ITEMS: NavItem[] = [
  { id: 'general', label: 'General', icon: <Settings className="size-4" /> },
  { id: 'auth', label: 'Authentication', icon: <KeyRound className="size-4" /> },
  { id: 'integrations', label: 'Integrations', icon: <Blocks className="size-4" /> },
  { id: 'skills', label: 'Skills', icon: <Wrench className="size-4" /> },
]

interface SettingsLayoutProps {
  activeTab: SettingsTab
  onTabChange: (tab: SettingsTab) => void
  onBack?: () => void
  children: React.ReactNode
}

export function SettingsLayout({ activeTab, onTabChange, onBack, children }: SettingsLayoutProps) {
  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden bg-[rgba(1,17,29,0.58)] backdrop-blur-lg">
      <header className="flex h-[62px] shrink-0 items-center border-b border-border/80 bg-card/72 px-2 shadow-[0_10px_24px_rgba(1,17,29,0.34)] backdrop-blur-xl md:px-4">
        <div className="flex min-w-0 flex-1 items-center gap-2">
          {onBack ? (
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="h-9 w-9 shrink-0 border border-transparent text-muted-foreground hover:border-border/60 hover:bg-secondary/75 hover:text-foreground"
              onClick={onBack}
              aria-label="Back to chat"
            >
              <ArrowLeft className="size-4" />
            </Button>
          ) : null}
          <h1 className="truncate text-sm font-semibold text-foreground">Settings</h1>
        </div>
      </header>

      {/* Mobile: horizontal scrolling tab bar */}
      <nav className="flex shrink-0 gap-1 overflow-x-auto border-b border-border/70 bg-secondary/30 px-2 py-1.5 backdrop-blur-md md:hidden">
        {NAV_ITEMS.map((item) => {
          const isActive = activeTab === item.id
          return (
            <button
              key={item.id}
              type="button"
              onClick={() => onTabChange(item.id)}
              className={cn(
                'flex min-h-[36px] shrink-0 items-center gap-1.5 rounded-md border border-transparent px-3 py-1.5 text-sm transition-[background-color,border-color,color,box-shadow]',
                'hover:bg-secondary/70',
                isActive
                  ? 'border-ring/35 bg-secondary/85 text-foreground font-medium shadow-[0_8px_18px_rgba(0,0,0,0.24)]'
                  : 'text-muted-foreground hover:border-border/60 hover:text-foreground',
              )}
            >
              <span className="flex shrink-0">{item.icon}</span>
              <span className="whitespace-nowrap">{item.label}</span>
            </button>
          )
        })}
      </nav>

      <div className="flex min-h-0 flex-1 overflow-hidden">
        {/* Desktop: left nav */}
        <nav className="hidden w-48 shrink-0 border-r border-border/70 bg-secondary/30 backdrop-blur-md md:block">
          <div className="flex flex-col gap-0.5 p-2 pt-3">
            {NAV_ITEMS.map((item) => {
              const isActive = activeTab === item.id
              return (
                <button
                  key={item.id}
                  type="button"
                  onClick={() => onTabChange(item.id)}
                  className={cn(
                    'flex h-8 w-full items-center gap-2 rounded-md border border-transparent px-3 text-left text-sm transition-[background-color,border-color,color,box-shadow]',
                    'hover:bg-secondary/70',
                    isActive
                      ? 'border-ring/35 bg-secondary/85 text-foreground font-medium shadow-[0_8px_18px_rgba(0,0,0,0.24)]'
                      : 'text-muted-foreground hover:border-border/60 hover:text-foreground',
                  )}
                >
                  <span className="flex shrink-0">{item.icon}</span>
                  <span className="truncate">{item.label}</span>
                </button>
              )
            })}
          </div>
        </nav>

        {/* Content area */}
        <div className="fleet-scrollbar min-h-0 flex-1 overflow-y-auto">
          <div className="mx-auto max-w-3xl px-4 py-4 pb-[calc(var(--tab-bar-height)+var(--safe-bottom)+0.75rem)] md:px-6 md:py-5 md:pb-5">
            {children}
          </div>
        </div>
      </div>
    </div>
  )
}
