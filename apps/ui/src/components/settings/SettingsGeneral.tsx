import { MoonStar, RotateCcw } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { SettingsSection, SettingsWithCTA } from './settings-row'
import { resolveApiEndpoint } from '@/components/settings/settings-api'

interface SettingsGeneralProps {
  wsUrl: string
}

export function SettingsGeneral({ wsUrl }: SettingsGeneralProps) {
  return (
    <div className="flex flex-col gap-8">
      <SettingsSection
        label="Appearance"
        description="Fleet theme is optimized for dark command-center workflows"
      >
        <SettingsWithCTA
          label="Theme"
          description="Dark mode is always enabled for consistent fleet visibility"
        >
          <Badge variant="teal" className="gap-1.5 px-2.5 py-1 text-[11px]">
            <MoonStar className="size-3.5" />
            Fleet Dark
          </Badge>
        </SettingsWithCTA>
      </SettingsSection>

      <SettingsSection
        label="System"
        description="Manage the Shuvlr daemon"
      >
        <SettingsWithCTA
          label="Reboot"
          description="Restart the Shuvlr daemon and all agents"
        >
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              const endpoint = resolveApiEndpoint(wsUrl, '/api/reboot')
              void fetch(endpoint, { method: 'POST' }).catch(() => {})
            }}
          >
            <RotateCcw className="mr-1.5 size-3.5" />
            Reboot
          </Button>
        </SettingsWithCTA>
      </SettingsSection>
    </div>
  )
}
