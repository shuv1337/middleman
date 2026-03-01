import { Link } from '@tanstack/react-router'
import { useState } from 'react'
import { Home, Menu, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { ScrollArea } from '@/components/ui/scroll-area'
import { cn } from '@/lib/utils'

export default function Header() {
  const [isOpen, setIsOpen] = useState(false)

  return (
    <>
      <header className="flex items-center border-b border-border/80 bg-card/72 p-3 text-foreground shadow-[0_10px_24px_rgba(1,17,29,0.34)] backdrop-blur-xl">
        <Button
          type="button"
          variant="ghost"
          size="icon"
          onClick={() => setIsOpen(true)}
          className="size-10 rounded-lg border border-transparent text-muted-foreground hover:border-border/60 hover:bg-secondary/75 hover:text-foreground"
          aria-label="Open menu"
        >
          <Menu className="size-5" />
        </Button>
        <h1 className="ml-4 text-xl font-semibold">
          <Link to="/">
            <img
              src="/tanstack-word-logo-white.svg"
              alt="TanStack Logo"
              className="h-10"
            />
          </Link>
        </h1>
      </header>

      <aside
        className={cn(
          'fixed left-0 top-0 z-50 flex h-full w-80 max-w-[88vw] flex-col border-r border-border/80 bg-[linear-gradient(180deg,rgba(1,17,29,0.98),rgba(1,17,29,0.9))] text-foreground shadow-[var(--fleet-shadow)] backdrop-blur-xl transition-transform duration-300 ease-in-out',
          isOpen ? 'translate-x-0' : '-translate-x-full',
        )}
      >
        <div className="flex items-center justify-between border-b border-border/70 p-4">
          <h2 className="text-base font-semibold tracking-wide text-[color:var(--fleet-salmon)]">Navigation</h2>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            onClick={() => setIsOpen(false)}
            className="size-9 rounded-lg border border-transparent text-muted-foreground hover:border-border/60 hover:bg-secondary/75 hover:text-foreground"
            aria-label="Close menu"
          >
            <X className="size-5" />
          </Button>
        </div>

        <ScrollArea className="flex-1">
          <nav className="space-y-2 p-4">
            <Link
              to="/"
              onClick={() => setIsOpen(false)}
              className="flex items-center gap-3 rounded-lg border border-transparent px-3 py-3 text-sm text-muted-foreground transition-[background-color,border-color,color] hover:border-border/60 hover:bg-secondary/75 hover:text-foreground"
              activeProps={{
                className:
                  'flex items-center gap-3 rounded-lg border border-primary/45 bg-primary/15 px-3 py-3 text-sm text-primary transition-[background-color,border-color,color]',
              }}
            >
              <Home className="size-4" />
              <span className="font-medium">Home</span>
            </Link>

            {/* Demo Links Start */}

            {/* Demo Links End */}
          </nav>
        </ScrollArea>
      </aside>
    </>
  )
}
