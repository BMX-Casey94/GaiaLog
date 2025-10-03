export interface AppSettings {
  apiKeys: {
    waqi?: string
    google?: string
    ibm?: string
  }
  blockchain: {
    privateKey?: string
    autoRecord: boolean
    networkFee: number
  }
  polling: {
    interval: number // in minutes
    enabled: boolean
  }
  notifications: {
    enabled: boolean
    email?: string
    webhookUrl?: string
  }
  display: {
    theme: "light" | "dark" | "system"
    compactMode: boolean
    showAdvancedMetrics: boolean
  }
}

const DEFAULT_SETTINGS: AppSettings = {
  apiKeys: {},
  blockchain: {
    autoRecord: true,
    networkFee: 0.00001,
  },
  polling: {
    interval: 15,
    enabled: true,
  },
  notifications: {
    enabled: false,
  },
  display: {
    theme: "system",
    compactMode: false,
    showAdvancedMetrics: true,
  },
}

class SettingsManager {
  private settings: AppSettings = DEFAULT_SETTINGS
  private listeners: Array<(settings: AppSettings) => void> = []

  constructor() {
    this.loadSettings()
  }

  // Load settings from localStorage
  private loadSettings() {
    if (typeof window !== "undefined") {
      try {
        const stored = localStorage.getItem("gaialog-settings")
        if (stored) {
          this.settings = { ...DEFAULT_SETTINGS, ...JSON.parse(stored) }
        }
      } catch (error) {
        console.error("Failed to load settings:", error)
        this.settings = DEFAULT_SETTINGS
      }
    }
  }

  // Save settings to localStorage
  private saveSettings() {
    if (typeof window !== "undefined") {
      try {
        localStorage.setItem("gaialog-settings", JSON.stringify(this.settings))
        this.notifyListeners()
      } catch (error) {
        console.error("Failed to save settings:", error)
      }
    }
  }

  // Get current settings
  getSettings(): AppSettings {
    return { ...this.settings }
  }

  // Update settings
  updateSettings(updates: Partial<AppSettings>) {
    this.settings = {
      ...this.settings,
      ...updates,
      apiKeys: { ...this.settings.apiKeys, ...updates.apiKeys },
      blockchain: { ...this.settings.blockchain, ...updates.blockchain },
      polling: { ...this.settings.polling, ...updates.polling },
      notifications: { ...this.settings.notifications, ...updates.notifications },
      display: { ...this.settings.display, ...updates.display },
    }
    this.saveSettings()
  }

  // Reset to defaults
  resetSettings() {
    this.settings = { ...DEFAULT_SETTINGS }
    this.saveSettings()
  }

  // Subscribe to settings changes
  subscribe(listener: (settings: AppSettings) => void) {
    this.listeners.push(listener)
    return () => {
      this.listeners = this.listeners.filter((l) => l !== listener)
    }
  }

  private notifyListeners() {
    this.listeners.forEach((listener) => listener(this.settings))
  }

  // Validate API key format
  validateApiKey(provider: string, key: string): boolean {
    switch (provider) {
      case "waqi":
        return key.length >= 20 && /^[a-zA-Z0-9]+$/.test(key)
      case "google":
        return key.startsWith("AIza") && key.length === 39
      case "ibm":
        return key.length >= 32 && /^[a-zA-Z0-9_-]+$/.test(key)
      default:
        return key.length > 0
    }
  }

  // Export settings as JSON
  exportSettings(): string {
    const exportData = {
      ...this.settings,
      blockchain: {
        ...this.settings.blockchain,
        privateKey: undefined, // Don't export private key for security
      },
    }
    return JSON.stringify(exportData, null, 2)
  }

  // Import settings from JSON
  importSettings(jsonData: string): boolean {
    try {
      const imported = JSON.parse(jsonData)
      this.updateSettings(imported)
      return true
    } catch (error) {
      console.error("Failed to import settings:", error)
      return false
    }
  }
}

export const settingsManager = new SettingsManager()
