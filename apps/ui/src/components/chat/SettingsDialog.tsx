import { useState } from 'react'
import { SettingsLayout, type SettingsTab } from '@/components/settings/SettingsLayout'
import { SettingsGeneral } from '@/components/settings/SettingsGeneral'
import { SettingsAuth } from '@/components/settings/SettingsAuth'
import { SettingsIntegrations } from '@/components/settings/SettingsIntegrations'
import { SettingsSkills } from '@/components/settings/SettingsSkills'
import type { AgentDescriptor, SlackStatusEvent, TelegramStatusEvent } from '@/lib/ws-types'

interface SettingsPanelProps {
  wsUrl: string
  managers: AgentDescriptor[]
  slackStatus?: SlackStatusEvent | null
  telegramStatus?: TelegramStatusEvent | null
  onBack?: () => void
}

export function SettingsPanel({
  wsUrl,
  managers,
  slackStatus,
  telegramStatus,
  onBack,
}: SettingsPanelProps) {
  const [activeTab, setActiveTab] = useState<SettingsTab>('general')

  return (
    <div className="min-h-0 flex flex-1 bg-[linear-gradient(180deg,rgba(1,17,29,0.4),rgba(1,17,29,0.7))]">
      <SettingsLayout activeTab={activeTab} onTabChange={setActiveTab} onBack={onBack}>
        {activeTab === 'general' && <SettingsGeneral wsUrl={wsUrl} />}
        {activeTab === 'auth' && <SettingsAuth wsUrl={wsUrl} />}
        {activeTab === 'integrations' && (
          <SettingsIntegrations
            wsUrl={wsUrl}
            managers={managers}
            slackStatus={slackStatus}
            telegramStatus={telegramStatus}
          />
        )}
        {activeTab === 'skills' && <SettingsSkills wsUrl={wsUrl} />}
      </SettingsLayout>
    </div>
  )
}
