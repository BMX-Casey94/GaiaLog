"use client"

import { useState } from "react"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Switch } from "@/components/ui/switch"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Badge } from "@/components/ui/badge"
import { Textarea } from "@/components/ui/textarea"
import { useSettings } from "@/hooks/use-settings"
import { ISO_COUNTRIES } from "@/lib/constants"
import { useToast } from "@/hooks/use-toast"
import { Key, Database, Clock, Bell, Palette, Download, Upload, RotateCcw, Eye, EyeOff } from "lucide-react"

export function SettingsPanel() {
  const { settings, updateSettings, resetSettings, validateApiKey, exportSettings, importSettings } = useSettings()
  const { toast } = useToast()
  const [showPrivateKey, setShowPrivateKey] = useState(false)
  const [importData, setImportData] = useState("")

  const handleApiKeyChange = (provider: string, value: string) => {
    updateSettings({
      apiKeys: {
        ...settings.apiKeys,
        [provider]: value,
      },
    })
  }

  const handleBlockchainChange = (key: string, value: any) => {
    updateSettings({
      blockchain: {
        ...settings.blockchain,
        [key]: value,
      },
    })
  }

  const handlePollingChange = (key: string, value: any) => {
    updateSettings({
      polling: {
        ...settings.polling,
        [key]: value,
      },
    })
  }

  const handleNotificationChange = (key: string, value: any) => {
    updateSettings({
      notifications: {
        ...settings.notifications,
        [key]: value,
      },
    })
  }

  const handleDisplayChange = (key: string, value: any) => {
    updateSettings({
      display: {
        ...settings.display,
        [key]: value,
      },
    })
  }

  const handleExport = () => {
    try {
      const data = exportSettings()
      const blob = new Blob([data], { type: "application/json" })
      const url = URL.createObjectURL(blob)
      const a = document.createElement("a")
      a.href = url
      a.download = `gaialog-settings-${new Date().toISOString().split("T")[0]}.json`
      document.body.appendChild(a)
      a.click()
      document.body.removeChild(a)
      URL.revokeObjectURL(url)
      toast({
        title: "Settings Exported",
        description: "Your settings have been exported successfully.",
      })
    } catch (error) {
      toast({
        title: "Export Failed",
        description: "Failed to export settings.",
        variant: "destructive",
      })
    }
  }

  const handleImport = () => {
    try {
      if (importSettings(importData)) {
        setImportData("")
        toast({
          title: "Settings Imported",
          description: "Your settings have been imported successfully.",
        })
      } else {
        throw new Error("Invalid JSON format")
      }
    } catch (error) {
      toast({
        title: "Import Failed",
        description: "Failed to import settings. Please check the JSON format.",
        variant: "destructive",
      })
    }
  }

  const handleReset = () => {
    resetSettings()
    toast({
      title: "Settings Reset",
      description: "All settings have been reset to defaults.",
    })
  }

  return (
    <div className="p-6">
      <div className="mb-6">
        <h1 className="text-2xl font-bold font-space-grotesk mb-2">Settings</h1>
        <p className="text-muted-foreground">Configure API keys, blockchain settings, and application preferences</p>
      </div>

      <Tabs defaultValue="api-keys" className="space-y-6">
        <TabsList className="flex w-full flex-wrap gap-2 overflow-x-auto">
          <TabsTrigger value="api-keys">API Keys</TabsTrigger>
          <TabsTrigger value="blockchain">Blockchain</TabsTrigger>
          <TabsTrigger value="polling">Data Polling</TabsTrigger>
          <TabsTrigger value="notifications">Notifications</TabsTrigger>
          <TabsTrigger value="display">Display</TabsTrigger>
          <TabsTrigger value="countries">Country Toggles</TabsTrigger>
        </TabsList>

        <TabsContent value="api-keys">
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <Key className="h-5 w-5" />
                API Configuration
              </CardTitle>
              <CardDescription>Configure API keys for environmental data sources</CardDescription>
            </CardHeader>
            <CardContent className="space-y-6">
              <div className="space-y-2">
                <Label htmlFor="waqi-key">WAQI API Key</Label>
                <div className="flex gap-2">
                  <Input
                    id="waqi-key"
                    type="password"
                    placeholder="Enter your WAQI API key"
                    value={settings.apiKeys.waqi || ""}
                    onChange={(e) => handleApiKeyChange("waqi", e.target.value)}
                  />
                  {settings.apiKeys.waqi && (
                    <Badge variant={validateApiKey("waqi", settings.apiKeys.waqi) ? "secondary" : "destructive"} className="rounded-sm">
                      {validateApiKey("waqi", settings.apiKeys.waqi) ? "Valid" : "Invalid"}
                    </Badge>
                  )}
                </div>
                <p className="text-xs text-muted-foreground">
                  Get your API key from{" "}
                  <a href="https://aqicn.org/api/" target="_blank" rel="noopener noreferrer" className="underline">
                    aqicn.org/api
                  </a>
                </p>
              </div>

              <div className="space-y-2">
                <Label htmlFor="google-key">Google Environment API Key</Label>
                <div className="flex gap-2">
                  <Input
                    id="google-key"
                    type="password"
                    placeholder="Enter your Google API key"
                    value={settings.apiKeys.google || ""}
                    onChange={(e) => handleApiKeyChange("google", e.target.value)}
                  />
                  {settings.apiKeys.google && (
                    <Badge variant={validateApiKey("google", settings.apiKeys.google) ? "secondary" : "destructive"} className="rounded-sm">
                      {validateApiKey("google", settings.apiKeys.google) ? "Valid" : "Invalid"}
                    </Badge>
                  )}
                </div>
                <p className="text-xs text-muted-foreground">
                  Get your API key from{" "}
                  <a
                    href="https://console.cloud.google.com/"
                    target="_blank"
                    rel="noopener noreferrer"
                    className="underline"
                  >
                    Google Cloud Console
                  </a>
                </p>
              </div>

              <div className="space-y-2">
                <Label htmlFor="ibm-key">IBM Environmental Intelligence API Key</Label>
                <div className="flex gap-2">
                  <Input
                    id="ibm-key"
                    type="password"
                    placeholder="Enter your IBM API key"
                    value={settings.apiKeys.ibm || ""}
                    onChange={(e) => handleApiKeyChange("ibm", e.target.value)}
                  />
                  {settings.apiKeys.ibm && (
                    <Badge variant={validateApiKey("ibm", settings.apiKeys.ibm) ? "secondary" : "destructive"} className="rounded-sm">
                      {validateApiKey("ibm", settings.apiKeys.ibm) ? "Valid" : "Invalid"}
                    </Badge>
                  )}
                </div>
                <p className="text-xs text-muted-foreground">
                  Get your API key from{" "}
                  <a
                    href="https://www.ibm.com/products/environmental-intelligence-suite"
                    target="_blank"
                    rel="noopener noreferrer"
                    className="underline"
                  >
                    IBM Environmental Intelligence Suite
                  </a>
                </p>
              </div>
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="blockchain">
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <Database className="h-5 w-5" />
                Blockchain Configuration
              </CardTitle>
              <CardDescription>Configure BSV blockchain settings and wallet</CardDescription>
            </CardHeader>
            <CardContent className="space-y-6">
              <div className="space-y-2">
                <Label htmlFor="private-key">Private Key (Optional)</Label>
                <div className="flex gap-2">
                  <Input
                    id="private-key"
                    type={showPrivateKey ? "text" : "password"}
                    placeholder="Enter your BSV private key"
                    value={settings.blockchain.privateKey || ""}
                    onChange={(e) => handleBlockchainChange("privateKey", e.target.value)}
                  />
                  <Button variant="outline" size="sm" onClick={() => setShowPrivateKey(!showPrivateKey)}>
                    {showPrivateKey ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                  </Button>
                </div>
                <p className="text-xs text-muted-foreground">
                  Leave empty to use a generated wallet. For production, import your own private key.
                </p>
              </div>

              <div className="flex items-center justify-between">
                <div className="space-y-0.5">
                  <Label>Auto-record to Blockchain</Label>
                  <p className="text-xs text-muted-foreground">
                    Automatically record environmental data to BSV blockchain
                  </p>
                </div>
                <Switch
                  checked={settings.blockchain.autoRecord}
                  onCheckedChange={(checked) => handleBlockchainChange("autoRecord", checked)}
                />
              </div>

              <div className="space-y-2">
                <Label htmlFor="network-fee">Network Fee (BSV)</Label>
                <Input
                  id="network-fee"
                  type="number"
                  step="0.00001"
                  min="0.00001"
                  value={settings.blockchain.networkFee}
                  onChange={(e) => handleBlockchainChange("networkFee", Number.parseFloat(e.target.value))}
                />
                <p className="text-xs text-muted-foreground">
                  Transaction fee in BSV. Lower fees may result in slower confirmation times.
                </p>
              </div>
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="polling">
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <Clock className="h-5 w-5" />
                Data Polling Configuration
              </CardTitle>
              <CardDescription>Configure how often environmental data is fetched</CardDescription>
            </CardHeader>
            <CardContent className="space-y-6">
              <div className="flex items-center justify-between">
                <div className="space-y-0.5">
                  <Label>Enable Automatic Polling</Label>
                  <p className="text-xs text-muted-foreground">
                    Automatically fetch new environmental data at regular intervals
                  </p>
                </div>
                <Switch
                  checked={settings.polling.enabled}
                  onCheckedChange={(checked) => handlePollingChange("enabled", checked)}
                />
              </div>

              <div className="space-y-2">
                <Label htmlFor="polling-interval">Polling Interval (minutes)</Label>
                <Select
                  value={settings.polling.interval.toString()}
                  onValueChange={(value) => handlePollingChange("interval", Number.parseInt(value))}
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="5">5 minutes</SelectItem>
                    <SelectItem value="10">10 minutes</SelectItem>
                    <SelectItem value="15">15 minutes</SelectItem>
                    <SelectItem value="30">30 minutes</SelectItem>
                    <SelectItem value="60">1 hour</SelectItem>
                  </SelectContent>
                </Select>
                <p className="text-xs text-muted-foreground">
                  More frequent polling may consume API quotas faster but provides more up-to-date data.
                </p>
              </div>
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="notifications">
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <Bell className="h-5 w-5" />
                Notification Settings
              </CardTitle>
              <CardDescription>Configure alerts and notifications</CardDescription>
            </CardHeader>
            <CardContent className="space-y-6">
              <div className="flex items-center justify-between">
                <div className="space-y-0.5">
                  <Label>Enable Notifications</Label>
                  <p className="text-xs text-muted-foreground">Receive alerts for environmental threshold breaches</p>
                </div>
                <Switch
                  checked={settings.notifications.enabled}
                  onCheckedChange={(checked) => handleNotificationChange("enabled", checked)}
                />
              </div>

              {settings.notifications.enabled && (
                <>
                  <div className="space-y-2">
                    <Label htmlFor="notification-email">Email Address</Label>
                    <Input
                      id="notification-email"
                      type="email"
                      placeholder="your@email.com"
                      value={settings.notifications.email || ""}
                      onChange={(e) => handleNotificationChange("email", e.target.value)}
                    />
                  </div>

                  <div className="space-y-2">
                    <Label htmlFor="webhook-url">Webhook URL (Optional)</Label>
                    <Input
                      id="webhook-url"
                      type="url"
                      placeholder="https://your-webhook-url.com"
                      value={settings.notifications.webhookUrl || ""}
                      onChange={(e) => handleNotificationChange("webhookUrl", e.target.value)}
                    />
                    <p className="text-xs text-muted-foreground">Send notifications to a custom webhook endpoint</p>
                  </div>
                </>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="display">
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <Palette className="h-5 w-5" />
                Display Preferences
              </CardTitle>
              <CardDescription>Customize the appearance and behavior of the dashboard</CardDescription>
            </CardHeader>
            <CardContent className="space-y-6">
              <div className="space-y-2">
                <Label>Theme</Label>
                <Select value={settings.display.theme} onValueChange={(value) => handleDisplayChange("theme", value)}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="light">Light</SelectItem>
                    <SelectItem value="dark">Dark</SelectItem>
                    <SelectItem value="system">System</SelectItem>
                  </SelectContent>
                </Select>
              </div>

              <div className="flex items-center justify-between">
                <div className="space-y-0.5">
                  <Label>Compact Mode</Label>
                  <p className="text-xs text-muted-foreground">
                    Use a more compact layout to fit more information on screen
                  </p>
                </div>
                <Switch
                  checked={settings.display.compactMode}
                  onCheckedChange={(checked) => handleDisplayChange("compactMode", checked)}
                />
              </div>

              <div className="flex items-center justify-between">
                <div className="space-y-0.5">
                  <Label>Show Advanced Metrics</Label>
                  <p className="text-xs text-muted-foreground">
                    Display advanced environmental metrics in the dashboard
                  </p>
                </div>
                <Switch
                  checked={settings.display.showAdvancedMetrics}
                  onCheckedChange={(checked) => handleDisplayChange("showAdvancedMetrics", checked)}
                />
              </div>
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="countries">
          <Card>
            <CardHeader>
              <CardTitle>Per‑Provider Country Toggles</CardTitle>
              <CardDescription>Allow/Deny and quotas by provider and country (ISO codes)</CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <ProviderCountryEditor providerId="weatherapi" label="WeatherAPI (OWM/Advanced)" />
              <ProviderCountryEditor providerId="waqi" label="WAQI (Air Quality)" />
              <ProviderCountryEditor providerId="usgs" label="USGS (Seismic)" />
              <ProviderCountryEditor providerId="noaa" label="NOAA (Water Levels)" />
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>

      <Card className="mt-6">
        <CardHeader>
          <CardTitle>Settings Management</CardTitle>
          <CardDescription>Export, import, or reset your settings</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex gap-2">
            <Button variant="outline" onClick={handleExport}>
              <Download className="h-4 w-4 mr-2" />
              Export Settings
            </Button>
            <Button variant="outline" onClick={handleReset}>
              <RotateCcw className="h-4 w-4 mr-2" />
              Reset to Defaults
            </Button>
          </div>

          <div className="space-y-2">
            <Label htmlFor="import-settings">Import Settings</Label>
            <Textarea
              id="import-settings"
              placeholder="Paste your exported settings JSON here..."
              value={importData}
              onChange={(e) => setImportData(e.target.value)}
              rows={4}
            />
            <Button onClick={handleImport} disabled={!importData.trim()}>
              <Upload className="h-4 w-4 mr-2" />
              Import Settings
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  )
}

function ProviderCountryEditor({ providerId, label }: { providerId: string; label: string }) {
  const [allow, setAllow] = useState<string>('')
  const [deny, setDeny] = useState<string>('')
  const [loading, setLoading] = useState(false)
  const { toast } = useToast()

  const load = async () => {
    try {
      const res = await fetch('/api/providers/settings')
      const json = await res.json()
      const row = (json?.items || []).find((r: any) => r.provider === providerId)
      if (row) {
        setAllow(Array.isArray(row.allow) ? row.allow.join(',') : '')
        setDeny(Array.isArray(row.deny) ? row.deny.join(',') : '')
      }
      // Load provider-specific country list
      const cRes = await fetch(`/api/providers/countries?provider=${providerId}`)
      const cJson = await cRes.json()
      const providerCodes: string[] = Array.isArray(cJson?.codes) ? cJson.codes : []
      if (providerCodes.length) {
        const codeSet = new Set(providerCodes)
        // Filter ISO_COUNTRIES to intersection; append unknowns
        const filtered = ISO_COUNTRIES.filter(c => codeSet.has(c.code))
        if (filtered.length) {
          // Replace ISO_COUNTRIES usage locally by closure var
          ;(ProviderCountryEditor as any)._codes = filtered
        }
      }
    } catch {}
  }

  const save = async () => {
    setLoading(true)
    try {
      const body = {
        provider: providerId,
        allow: allow.split(',').map((s) => s.trim()).filter(Boolean),
        deny: deny.split(',').map((s) => s.trim()).filter(Boolean),
        quotas: {},
      }
      await fetch('/api/providers/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      toast({ title: 'Saved', description: `${label} settings updated` })
    } catch {
      toast({ title: 'Save failed', description: 'Could not update settings', variant: 'destructive' })
    } finally {
      setLoading(false)
    }
  }

  // Load once on mount
  useState(() => { load() })

  const allowSet = new Set(allow.split(',').map(s => s.trim()).filter(Boolean))
  const denySet = new Set(deny.split(',').map(s => s.trim()).filter(Boolean))

  const toggle = (code: string, list: 'allow' | 'deny') => {
    const set = list === 'allow' ? allowSet : denySet
    if (set.has(code)) {
      set.delete(code)
    } else {
      set.add(code)
    }
    const out = Array.from(set).join(',')
    list === 'allow' ? setAllow(out) : setDeny(out)
  }

  const CODES: typeof ISO_COUNTRIES = (ProviderCountryEditor as any)._codes || ISO_COUNTRIES

  return (
    <div className="space-y-3 border rounded-md p-4">
      <div className="font-medium">{label}</div>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        <div>
          <Label>Allow</Label>
          <div className="flex flex-wrap gap-2 mt-2 max-h-40 overflow-auto p-2 border rounded-md">
            {CODES.map(c => (
              <Button key={c.code} size="sm" variant={allowSet.has(c.code) ? 'secondary' : 'outline'} onClick={() => toggle(c.code, 'allow')}>
                {c.code}
              </Button>
            ))}
          </div>
        </div>
        <div>
          <Label>Deny</Label>
          <div className="flex flex-wrap gap-2 mt-2 max-h-40 overflow-auto p-2 border rounded-md">
            {CODES.map(c => (
              <Button key={c.code} size="sm" variant={denySet.has(c.code) ? 'secondary' : 'outline'} onClick={() => toggle(c.code, 'deny')}>
                {c.code}
              </Button>
            ))}
          </div>
        </div>
      </div>
      <div className="flex gap-2">
        <Button onClick={save} disabled={loading}>{loading ? 'Saving...' : 'Save'}</Button>
        <Button variant="outline" onClick={load} disabled={loading}>Reload</Button>
      </div>
    </div>
  )
}
