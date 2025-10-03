"use client"

import { useState, useEffect } from "react"
import { settingsManager, type AppSettings } from "@/lib/settings"

export function useSettings() {
  const [settings, setSettings] = useState<AppSettings>(settingsManager.getSettings())
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    const unsubscribe = settingsManager.subscribe(setSettings)
    return unsubscribe
  }, [])

  const updateSettings = async (updates: Partial<AppSettings>) => {
    try {
      setLoading(true)
      setError(null)
      settingsManager.updateSettings(updates)
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to update settings")
    } finally {
      setLoading(false)
    }
  }

  const resetSettings = async () => {
    try {
      setLoading(true)
      setError(null)
      settingsManager.resetSettings()
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to reset settings")
    } finally {
      setLoading(false)
    }
  }

  const validateApiKey = (provider: string, key: string) => {
    return settingsManager.validateApiKey(provider, key)
  }

  const exportSettings = () => {
    return settingsManager.exportSettings()
  }

  const importSettings = (jsonData: string) => {
    return settingsManager.importSettings(jsonData)
  }

  return {
    settings,
    loading,
    error,
    updateSettings,
    resetSettings,
    validateApiKey,
    exportSettings,
    importSettings,
  }
}
