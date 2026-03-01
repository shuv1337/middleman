import { Label } from '@/components/ui/label'
import { cn } from '@/lib/utils'

export function SettingsSection({
  label,
  description,
  children,
  cta,
}: {
  label: string
  description?: string | React.ReactNode
  children: React.ReactNode
  cta?: React.ReactNode
}) {
  return (
    <section className="space-y-4 rounded-xl border border-border/70 bg-card/55 p-4 shadow-[0_12px_26px_rgba(0,0,0,0.24)] backdrop-blur-md">
      <div className="flex items-start justify-between gap-4 border-b border-border/60 pb-3">
        <div className="flex-1">
          <h3 className="text-base font-semibold text-foreground">{label}</h3>
          {description ? (
            <p className="text-sm text-muted-foreground">{description}</p>
          ) : null}
        </div>
        {cta ? <div className="shrink-0">{cta}</div> : null}
      </div>

      <div className="space-y-3">{children}</div>
    </section>
  )
}

export function SettingsWithCTA({
  label,
  description,
  children,
  direction = 'row',
}: {
  label: string
  description?: string | React.ReactNode
  children: React.ReactNode
  direction?: 'row' | 'col'
}) {
  return (
    <div
      className={cn(
        'rounded-lg border border-border/60 bg-secondary/35 px-3 py-2.5',
        'flex items-start justify-between gap-4',
        {
          'flex-col gap-2': direction === 'col',
          'flex-col gap-3 sm:flex-row sm:items-start': direction === 'row',
        },
      )}
    >
      <div className="flex flex-1 flex-col gap-1">
        <Label className="text-sm font-semibold text-foreground">{label}</Label>
        {description ? (
          <span className="text-xs text-muted-foreground">{description}</span>
        ) : null}
      </div>
      {children}
    </div>
  )
}
