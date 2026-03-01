import * as React from 'react'
import { cva, type VariantProps } from 'class-variance-authority'
import { cn } from '@/lib/utils'

const buttonVariants = cva(
  'inline-flex items-center justify-center whitespace-nowrap rounded-md text-sm font-medium transition-[background-color,color,border-color,box-shadow,transform] disabled:pointer-events-none disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-[color:var(--fleet-bg-deep)] active:scale-[0.99]',
  {
    variants: {
      variant: {
        default:
          'border border-primary/40 bg-primary/95 text-primary-foreground shadow-[0_10px_24px_rgba(130,170,255,0.32)] hover:border-primary/60 hover:bg-primary hover:shadow-[0_14px_28px_rgba(130,170,255,0.4)]',
        secondary:
          'border border-border bg-secondary/85 text-secondary-foreground shadow-[0_6px_18px_rgba(0,0,0,0.18)] hover:border-ring/40 hover:bg-secondary',
        ghost:
          'text-muted-foreground hover:bg-secondary/75 hover:text-foreground',
        outline:
          'border border-border bg-card/50 text-foreground shadow-[inset_0_0_0_1px_rgba(130,170,255,0.05)] backdrop-blur-sm hover:border-ring/60 hover:bg-secondary/80 hover:text-foreground',
      },
      size: {
        default: 'h-9 px-4 py-2',
        sm: 'h-8 rounded-md px-3 text-xs',
        lg: 'h-10 rounded-md px-8',
        icon: 'h-9 w-9',
      },
    },
    defaultVariants: {
      variant: 'default',
      size: 'default',
    },
  },
)

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {}

const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, ...props }, ref) => {
    return (
      <button
        className={cn(buttonVariants({ variant, size, className }))}
        ref={ref}
        {...props}
      />
    )
  },
)
Button.displayName = 'Button'

export { Button, buttonVariants }
