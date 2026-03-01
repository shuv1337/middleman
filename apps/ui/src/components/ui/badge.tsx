import * as React from 'react'
import { cva, type VariantProps } from 'class-variance-authority'
import { cn } from '@/lib/utils'

const badgeVariants = cva(
  'inline-flex items-center rounded-full border px-2.5 py-0.5 text-xs font-semibold transition-colors',
  {
    variants: {
      variant: {
        default: 'border-primary/45 bg-primary/20 text-primary',
        secondary: 'border-border/80 bg-secondary/65 text-secondary-foreground',
        destructive: 'border-[rgba(239,83,80,0.42)] bg-[rgba(239,83,80,0.16)] text-[color:var(--fleet-danger)]',
        outline: 'border-border text-foreground',
        info: 'border-[rgba(130,170,255,0.5)] bg-[rgba(130,170,255,0.16)] text-primary',
        teal: 'border-[rgba(127,219,202,0.5)] bg-[rgba(127,219,202,0.16)] text-[color:var(--accent)]',
        ok: 'border-[rgba(173,219,103,0.45)] bg-[rgba(173,219,103,0.16)] text-[color:var(--fleet-ok)]',
        warn: 'border-[rgba(247,140,108,0.45)] bg-[rgba(247,140,108,0.16)] text-[color:var(--fleet-warn)]',
        danger: 'border-[rgba(239,83,80,0.45)] bg-[rgba(239,83,80,0.16)] text-[color:var(--fleet-danger)]',
        muted: 'border-border/80 bg-muted/60 text-muted-foreground',
      },
    },
    defaultVariants: {
      variant: 'default',
    },
  },
)

export interface BadgeProps extends React.HTMLAttributes<HTMLDivElement>, VariantProps<typeof badgeVariants> {}

function Badge({ className, variant, ...props }: BadgeProps) {
  return <div className={cn(badgeVariants({ variant }), className)} {...props} />
}

export { Badge, badgeVariants }
