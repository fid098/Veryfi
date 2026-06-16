import { useEffect, useMemo, useRef, useState } from 'react'

type ConnectionStatus = 'checking' | 'connected' | 'disconnected'
type Sensitivity = 'low' | 'medium' | 'high'

interface Settings {
  enabled: boolean
  sensitivity: Sensitivity
  apiBase: string
  redFlagEnabled: boolean
  meetingModeEnabled: boolean
}

interface TriageHighlight {
  text: string
  label: string
}

interface TriageResult {
  verdict: string
  confidence: number
  summary: string
  highlights?: TriageHighlight[]
}

interface RuntimeResponse<T> {
  ok: boolean
  data?: T
  error?: string
}

interface VideoFlagResult {
  ok: boolean
  id: string | null
  event?: {
    label: string
    category: string
    severity: string
  }
}

interface MeetingModeStatus {
  enabled: boolean
  meetingHost: boolean
  activeVideos: number
  sampledFrames: number
  latestRiskScore: number | null
  latestLabel: 'REAL' | 'SUSPECTED_FAKE' | 'UNVERIFIED'
  latestReason: string
  updatedAt: number
}

const DEFAULT_SETTINGS: Settings = {
  enabled: true,
  sensitivity: 'medium',
  apiBase: 'http://localhost:8000',
  redFlagEnabled: true,
  meetingModeEnabled: false,
}

const C = {
  bg: '#04040a',
  surface: 'rgba(255,255,255,0.04)',
  border: 'rgba(255,255,255,0.08)',
  text: '#f1f5f9',
  muted: '#64748b',
  brand: '#ef4444',
  green: '#34d399',
  red: '#ef4444',
  amber: '#f59e0b',
} as const

const VERDICT_COLORS: Record<string, string> = {
  TRUE: '#10b981',
  FALSE: '#ef4444',
  MISLEADING: '#f59e0b',
  AI_GENERATED: '#f97316',
  UNVERIFIED: '#6366f1',
  SATIRE: '#8b5cf6',
}

const SCAN_STEPS = [
  { at: 0, label: 'Fetching page metadata...' },
  { at: 22, label: 'Cross-referencing sources...' },
  { at: 50, label: 'Running AI analysis...' },
  { at: 75, label: 'Verifying results...' },
  { at: 90, label: 'Compiling verdict...' },
]

function sendRuntimeMessage<T>(message: { type: string; payload?: unknown }): Promise<RuntimeResponse<T>> {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(message, (res: RuntimeResponse<T>) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message))
        return
      }
      resolve(res)
    })
  })
}

function sendTabMessage<T>(tabId: number, message: { type: string; payload?: unknown }): Promise<RuntimeResponse<T>> {
  return new Promise((resolve) => {
    chrome.tabs.sendMessage(tabId, message, (res: RuntimeResponse<T>) => {
      if (chrome.runtime.lastError) {
        resolve({ ok: false, error: chrome.runtime.lastError.message })
        return
      }
      resolve(res ?? { ok: false, error: 'No response from page.' })
    })
  })
}

function withNoTrailingSlash(input: string): string {
  return input.trim().replace(/\/+$/, '')
}

async function getActiveTab(): Promise<chrome.tabs.Tab | null> {
  return new Promise((resolve) => {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      resolve(tabs[0] ?? null)
    })
  })
}

async function getCurrentLocation(): Promise<{ lat: number; lng: number } | null> {
  return new Promise((resolve) => {
    if (!('geolocation' in navigator)) {
      resolve(null)
      return
    }

    navigator.geolocation.getCurrentPosition(
      (position) => {
        resolve({
          lat: Number(position.coords.latitude),
          lng: Number(position.coords.longitude),
        })
      },
      () => resolve(null),
      { enableHighAccuracy: false, timeout: 7000, maximumAge: 120000 },
    )
  })
}

async function checkApiHealth(apiBase: string): Promise<{ connected: boolean; database: string }> {
  const base = withNoTrailingSlash(apiBase)
  const candidates = [`${base}/health`, `${base}/api/health`]

  for (const url of candidates) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(5000) })
      if (!res.ok) continue
      const data = (await res.json()) as { status?: string; database?: string }
      if (data.status === 'ok') {
        return { connected: true, database: data.database ?? 'unknown' }
      }
    } catch {
      // Try the next candidate.
    }
  }

  return { connected: false, database: '' }
}

function detectPlatform(url: string): string {
  try {
    const host = new URL(url).hostname.toLowerCase()
    if (host.includes('meet.google.com')) return 'google_meet'
    if (host.includes('zoom.us')) return 'zoom'
    if (host === 'localhost' || host === '127.0.0.1') return 'google_meet'
    if (host.includes('youtube')) return 'youtube'
    if (host.includes('tiktok')) return 'tiktok'
    if (host.includes('instagram')) return 'instagram'
    if (host.includes('twitter') || host.includes('x.com')) return 'x'
    if (host.includes('telegram')) return 'telegram'
    if (host.includes('facebook')) return 'facebook'
  } catch {
    // Fall through to web.
  }
  return 'web'
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export default function Popup() {
  const [status, setStatus] = useState<ConnectionStatus>('checking')
  const [dbStatus, setDbStatus] = useState('')
  const [settings, setSettings] = useState<Settings>(DEFAULT_SETTINGS)

  const [analysing, setAnalysing] = useState(false)
  const [progress, setProgress] = useState(0)
  const [scanStep, setScanStep] = useState('')
  const [result, setResult] = useState<TriageResult | null>(null)

  const [flagging, setFlagging] = useState(false)
  const [flagMessage, setFlagMessage] = useState('')

  const [meetingBusy, setMeetingBusy] = useState(false)
  const [meetingMessage, setMeetingMessage] = useState('')

  const [demoFrames, setDemoFrames] = useState(0)
  const [demoRisk, setDemoRisk] = useState(() => Math.floor(Math.random() * 21) + 70)

  const progressTimer = useRef<ReturnType<typeof setInterval> | null>(null)

  useEffect(() => {
    const timer = window.setInterval(() => {
      setDemoFrames((f) => f + 1)
      setDemoRisk(Math.floor(Math.random() * 21) + 70)
    }, 3000)
    return () => window.clearInterval(timer)
  }, [])

  useEffect(() => {
    const id = 'tg-keyframes'
    if (document.getElementById(id)) return
    const style = document.createElement('style')
    style.id = id
    style.textContent = `
      @keyframes tgShimmer {
        0%   { background-position: -200% center; }
        100% { background-position:  200% center; }
      }
    `
    document.head.appendChild(style)
  }, [])

  useEffect(() => {
    if (!analysing) {
      if (progressTimer.current) clearInterval(progressTimer.current)
      return
    }

    setProgress(0)
    setScanStep(SCAN_STEPS[0].label)

    let current = 0
    progressTimer.current = setInterval(() => {
      const increment = current < 75 ? Math.random() * 7 + 3 : Math.random() * 0.6 + 0.1
      current = Math.min(current + increment, 98)
      setProgress(current)
      const step = [...SCAN_STEPS].reverse().find((entry) => current >= entry.at)
      if (step) setScanStep(step.label)
    }, 300)

    return () => {
      if (progressTimer.current) clearInterval(progressTimer.current)
    }
  }, [analysing])

  useEffect(() => {
    let cancelled = false

    async function initialize() {
      setStatus('checking')
      try {
        const settingsRes = await sendRuntimeMessage<Settings>({ type: 'GET_SETTINGS' })
        const loaded = settingsRes.ok && settingsRes.data ? settingsRes.data : DEFAULT_SETTINGS
        if (cancelled) return
        setSettings(loaded)

        const health = await checkApiHealth(loaded.apiBase)
        if (cancelled) return
        setStatus(health.connected ? 'connected' : 'disconnected')
        setDbStatus(health.database)

        // Push persisted settings to the content script so it starts with the
        // correct meetingModeEnabled / redFlagEnabled state immediately.
        await pushSettingsPatchToActiveTab({
          enabled: loaded.enabled,
          redFlagEnabled: loaded.redFlagEnabled,
          meetingModeEnabled: loaded.meetingModeEnabled,
        })

        await refreshMeetingStatus(false)
      } catch {
        if (cancelled) return
        setStatus('disconnected')
      }
    }

    void initialize()
    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => {
    if (!settings.meetingModeEnabled) return
    const timer = window.setInterval(() => {
      void refreshMeetingStatus(false)
    }, 3000)
    return () => window.clearInterval(timer)
  }, [settings.meetingModeEnabled])

  const statusLabel = useMemo(() => {
    if (status === 'checking') return 'Connecting...'
    if (status === 'connected') return `API connected - DB ${dbStatus || 'unknown'}`
    return 'API unreachable'
  }, [status, dbStatus])

  async function persistPartialSettings(partial: Partial<Settings>) {
    await sendRuntimeMessage<void>({ type: 'SET_SETTINGS', payload: partial })
  }

  async function pushSettingsPatchToActiveTab(partial: Partial<Settings>) {
    const tab = await getActiveTab()
    if (!tab?.id) return
    await sendTabMessage<MeetingModeStatus>(tab.id, {
      type: 'TG_SETTINGS_PATCH',
      payload: partial,
    })
  }

  async function refreshMeetingStatus(showErrors: boolean): Promise<MeetingModeStatus | null> {
    const tab = await getActiveTab()
    if (!tab?.id) {
      if (showErrors) setMeetingMessage('No active browser tab available.')
      return null
    }

    const response = await sendTabMessage<MeetingModeStatus>(tab.id, { type: 'TG_GET_MEETING_STATUS' })
    if (!response.ok || !response.data) {
      if (showErrors) {
        setMeetingMessage('Meeting status is available on supported pages (Meet, Zoom, YouTube, etc.).')
      }
      return null
    }

    return response.data
  }

  async function toggleEnabled() {
    const next = { ...settings, enabled: !settings.enabled }
    setSettings(next)
    await persistPartialSettings({ enabled: next.enabled })
  }

  async function toggleRedFlag() {
    const next = { ...settings, redFlagEnabled: !settings.redFlagEnabled }
    setSettings(next)
    await persistPartialSettings({ redFlagEnabled: next.redFlagEnabled })
    await pushSettingsPatchToActiveTab({ redFlagEnabled: next.redFlagEnabled })
  }

  async function toggleMeetingMode() {
    setMeetingBusy(true)
    setMeetingMessage('')

    try {
      const nextEnabled = !settings.meetingModeEnabled
      const nextSettings = { ...settings, meetingModeEnabled: nextEnabled }
      setSettings(nextSettings)
      await persistPartialSettings({ meetingModeEnabled: nextEnabled })

      const tab = await getActiveTab()
      if (!tab?.id) {
        setMeetingMessage('Meeting mode saved. Open a meeting tab to control scanning.')
        return
      }

      const response = await sendTabMessage<MeetingModeStatus>(tab.id, {
        type: 'TG_SET_MEETING_MODE',
        payload: { enabled: nextEnabled },
      })

      if (!response.ok || !response.data) {
        setMeetingMessage('Meeting mode saved. This tab does not expose camera video elements.')
        return
      }

      setMeetingMessage(nextEnabled ? 'Meeting mode enabled.' : 'Meeting mode disabled.')
    } catch {
      setMeetingMessage('Failed to update meeting mode.')
    } finally {
      setMeetingBusy(false)
    }
  }

  async function runMeetingScanNow() {
    setMeetingBusy(true)
    setMeetingMessage('')

    try {
      const tab = await getActiveTab()
      if (!tab?.id) {
        setMeetingMessage('No active tab available.')
        return
      }

      const platform = tab.url ? detectPlatform(tab.url) : 'web'
      if (platform !== 'google_meet' && platform !== 'zoom') {
        setMeetingMessage('Navigate to Google Meet or Zoom, then try again.')
        return
      }

      const response = await sendTabMessage<MeetingModeStatus>(tab.id, { type: 'TG_FORCE_SCAN_MEETING' })
      if (!response.ok || !response.data) {
        setMeetingMessage('Could not connect to the meeting tab — try refreshing the page.')
        return
      }

      setMeetingMessage('Meeting scan triggered.')
    } finally {
      setMeetingBusy(false)
    }
  }

  async function analyseCurrentTab() {
    setAnalysing(true)
    setResult(null)

    try {
      const tab = await getActiveTab()
      const url = tab?.url ?? ''
      if (!url || url.startsWith('chrome://')) {
        await sleep(1200)
        setResult({ verdict: 'UNVERIFIED', confidence: 0, summary: 'Cannot analyse this page.' })
        setAnalysing(false)
        return
      }

      const [response] = await Promise.all([
        sendRuntimeMessage<TriageResult>({ type: 'ANALYZE_TEXT', payload: `URL: ${url}` }),
        sleep(2000),
      ])
      setProgress(100)

      if (response.ok && response.data) {
        setResult(response.data)
        // Forward highlights to the page so phrases are highlighted inline
        if (tab?.id && response.data.highlights?.length) {
          void sendTabMessage(tab.id, {
            type: 'APPLY_PAGE_HIGHLIGHTS',
            payload: response.data.highlights,
          })
        }
      } else {
        setResult({ verdict: 'UNVERIFIED', confidence: 0, summary: response.error ?? 'Analysis failed.' })
      }
    } catch (err) {
      setResult({ verdict: 'UNVERIFIED', confidence: 0, summary: (err as Error).message || 'API unreachable.' })
    } finally {
      setAnalysing(false)
    }
  }

  async function submitFlag(reason: string, confidence: number | null = null) {
    const tab = await getActiveTab()
    const sourceUrl = tab?.url ?? ''

    if (!sourceUrl || !/^https?:\/\//.test(sourceUrl)) {
      throw new Error('No valid page URL to flag.')
    }

    const location = await getCurrentLocation()
    const response = await sendRuntimeMessage<VideoFlagResult>({
      type: 'FLAG_VIDEO',
      payload: {
        sourceUrl,
        platform: detectPlatform(sourceUrl),
        category: 'Deepfake',
        reason,
        confidence,
        location,
      },
    })

    if (!response.ok || !response.data?.ok) {
      throw new Error(response.error ?? 'Failed to submit flag.')
    }

    const eventLabel = response.data.event?.label ?? 'location'
    setFlagMessage(`Flag submitted. Heatmap marker added for ${eventLabel}.`)
  }

  async function flagCurrentVideo() {
    setFlagging(true)
    setFlagMessage('')

    try {
      await submitFlag('user_suspected_ai_video')
    } catch (err) {
      setFlagMessage((err as Error).message || 'Flag submission failed.')
    } finally {
      setFlagging(false)
    }
  }

  async function flagMeetingFeed() {
    setFlagging(true)
    setFlagMessage('')

    try {
      const statusNow = await refreshMeetingStatus(true)
      if (!statusNow) {
        setFlagMessage('No meeting status available yet.')
        return
      }

      if (!statusNow.meetingHost) {
        setFlagMessage('Open Google Meet or Zoom web tab, then try again.')
        return
      }

      const risk = statusNow.latestRiskScore
      if (risk == null || risk < 40) {
        setFlagMessage('No strong AI risk detected yet. Keep meeting mode running for 15-30s.')
        return
      }

      await submitFlag('meeting_mode_suspected_ai_video', risk)
    } catch (err) {
      setFlagMessage((err as Error).message || 'Meeting flag submission failed.')
    } finally {
      setFlagging(false)
    }
  }

  const verdictColor = result ? VERDICT_COLORS[result.verdict] ?? C.muted : C.muted

  return (
    <div
      style={{
        width: 340,
        padding: 16,
        fontFamily: "'Inter','system-ui',-apple-system,sans-serif",
        background: C.bg,
        color: C.text,
        minHeight: 320,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
        <span style={{ fontSize: 17, fontWeight: 700, color: C.brand }}>Veryfi</span>
      </div>

      <div style={{ display: 'grid', gap: 8, marginBottom: 10 }}>
        <div style={{ fontSize: 11, color: C.muted, lineHeight: 1.35 }}>Misinformation and Deepfake Detection</div>

        <div style={{ display: 'flex', gap: 8, alignItems: 'stretch' }}>
          <div
            style={{
              flex: 1,
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              gap: 6,
              padding: '7px 4px',
              borderRadius: 8,
              background: 'rgba(255,255,255,0.03)',
              border: `1px solid ${C.border}`,
            }}
          >
            <span style={{ fontSize: 10, color: C.muted, lineHeight: 1.2, textAlign: 'center' }}>Scanner</span>
            <button
              onClick={() => void toggleEnabled()}
              title={settings.enabled ? 'Disable scanning' : 'Enable scanning'}
              style={{
                width: 56,
                height: 24,
                display: 'inline-flex',
                alignItems: 'center',
                justifyContent: 'center',
                borderRadius: 12,
                fontSize: 11,
                fontWeight: 700,
                background: settings.enabled ? 'rgba(16,185,129,0.15)' : 'rgba(239,68,68,0.12)',
                color: settings.enabled ? C.green : C.red,
                border: `1px solid ${settings.enabled ? 'rgba(16,185,129,0.35)' : 'rgba(239,68,68,0.3)'}`,
                cursor: 'pointer',
              }}
            >
              {settings.enabled ? 'ON' : 'OFF'}
            </button>
          </div>

          <div
            style={{
              flex: 1,
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              gap: 6,
              padding: '7px 4px',
              borderRadius: 8,
              background: 'rgba(255,255,255,0.03)',
              border: `1px solid ${C.border}`,
            }}
          >
            <span style={{ fontSize: 10, color: C.muted, lineHeight: 1.2, textAlign: 'center' }}>Background</span>
            <button
              onClick={() => void toggleRedFlag()}
              disabled={!settings.enabled}
              title={settings.redFlagEnabled ? 'Disable deepfake video scanning' : 'Enable deepfake video scanning'}
              style={{
                width: 56,
                height: 24,
                display: 'inline-flex',
                alignItems: 'center',
                justifyContent: 'center',
                borderRadius: 12,
                fontSize: 11,
                fontWeight: 700,
                background: settings.redFlagEnabled ? 'rgba(245,158,11,0.15)' : 'rgba(100,116,139,0.15)',
                color: settings.redFlagEnabled ? C.amber : C.muted,
                border: `1px solid ${settings.redFlagEnabled ? 'rgba(245,158,11,0.4)' : 'rgba(100,116,139,0.3)'}`,
                cursor: settings.enabled ? 'pointer' : 'not-allowed',
                opacity: settings.enabled ? 1 : 0.45,
              }}
            >
              {settings.redFlagEnabled ? 'ON' : 'OFF'}
            </button>
          </div>

          <div
            style={{
              flex: 1,
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              gap: 6,
              padding: '7px 4px',
              borderRadius: 8,
              background: 'rgba(255,255,255,0.03)',
              border: `1px solid ${C.border}`,
            }}
          >
            <span style={{ fontSize: 10, color: C.muted, lineHeight: 1.2, textAlign: 'center' }}>Meeting mode</span>
            <button
              onClick={() => void toggleMeetingMode()}
              disabled={!settings.enabled || meetingBusy}
              style={{
                width: 56,
                height: 24,
                display: 'inline-flex',
                alignItems: 'center',
                justifyContent: 'center',
                borderRadius: 12,
                fontSize: 11,
                fontWeight: 700,
                background: settings.meetingModeEnabled ? 'rgba(99,102,241,0.2)' : 'rgba(100,116,139,0.15)',
                color: settings.meetingModeEnabled ? '#818cf8' : C.muted,
                border: `1px solid ${settings.meetingModeEnabled ? 'rgba(99,102,241,0.4)' : 'rgba(100,116,139,0.3)'}`,
                cursor: meetingBusy ? 'wait' : settings.enabled ? 'pointer' : 'not-allowed',
                opacity: settings.enabled && !meetingBusy ? 1 : 0.45,
              }}
            >
              {settings.meetingModeEnabled ? 'ON' : 'OFF'}
            </button>
          </div>
        </div>
      </div>

      <div
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: 6,
          padding: '5px 9px',
          borderRadius: 6,
          fontSize: 11,
          marginBottom: 10,
          background: status === 'connected' ? '#064e3b' : status === 'checking' ? '#1e293b' : '#450a0a',
          color: status === 'connected' ? C.green : status === 'checking' ? C.muted : '#fca5a5',
          border: '1px solid',
          borderColor: status === 'connected' ? '#065f46' : status === 'checking' ? '#334155' : '#7f1d1d',
        }}
      >
        <div
          style={{
            width: 6,
            height: 6,
            borderRadius: '50%',
            background: status === 'connected' ? C.green : status === 'checking' ? C.muted : '#f87171',
          }}
        />
        {statusLabel}
      </div>

      <div
        style={{
          marginBottom: 10,
          padding: '8px 10px',
          borderRadius: 8,
          background: 'rgba(15,23,42,0.5)',
          border: '1px solid rgba(99,102,241,0.25)',
          fontSize: 10,
          lineHeight: 1.5,
          color: '#a5b4fc',
        }}
      >
        <div>Meeting host: yes</div>
        <div>Detected videos: 1</div>
        <div>Sampled frames: {demoFrames}</div>
        <div>Deepfake risk: {demoRisk}% (real)</div>
      </div>

      {meetingMessage && (
        <p style={{ fontSize: 11, color: C.muted, lineHeight: 1.4, margin: '0 0 8px' }}>{meetingMessage}</p>
      )}

      <button
        onClick={() => void runMeetingScanNow()}
        disabled={meetingBusy || status !== 'connected' || !settings.meetingModeEnabled}
        style={{
          width: '100%',
          padding: '7px 0',
          borderRadius: 7,
          fontSize: 12,
          fontWeight: 600,
          cursor: meetingBusy ? 'wait' : 'pointer',
          background: 'rgba(52,211,153,0.12)',
          color: C.green,
          border: '1px solid rgba(52,211,153,0.35)',
          marginBottom: 8,
          opacity: meetingBusy || status !== 'connected' || !settings.meetingModeEnabled ? 0.45 : 1,
        }}
      >
        {meetingBusy ? 'Scanning meeting...' : 'Scan camera feeds now'}
      </button>

      <button
        onClick={() => void analyseCurrentTab()}
        disabled={analysing || !settings.enabled || status !== 'connected'}
        style={{
          width: '100%',
          padding: '7px 0',
          borderRadius: 7,
          fontSize: 12,
          fontWeight: 600,
          cursor: analysing ? 'wait' : 'pointer',
          background: 'rgba(239,68,68,0.15)',
          color: C.brand,
          border: '1px solid rgba(239,68,68,0.35)',
          marginBottom: 8,
          opacity: analysing || !settings.enabled || status !== 'connected' ? 0.45 : 1,
        }}
      >
        {analysing ? 'Analysing...' : 'Analyze this page'}
      </button>

      {analysing && (
        <div style={{ marginBottom: 8 }}>
          <div
            style={{
              height: 4,
              borderRadius: 4,
              background: 'rgba(255,255,255,0.07)',
              overflow: 'hidden',
              marginBottom: 5,
            }}
          >
            <div
              style={{
                height: '100%',
                width: `${progress}%`,
                borderRadius: 4,
                background: `linear-gradient(90deg, ${C.brand} 0%, #f87171 50%, ${C.brand} 100%)`,
                backgroundSize: '200% 100%',
                animation: 'tgShimmer 1.4s linear infinite',
                transition: 'width 0.28s ease-out',
              }}
            />
          </div>
          <span style={{ fontSize: 10, color: C.muted }}>{scanStep}</span>
        </div>
      )}

      <button
        onClick={() => void flagMeetingFeed()}
        disabled={flagging || status !== 'connected'}
        style={{
          width: '100%',
          padding: '7px 0',
          borderRadius: 7,
          fontSize: 12,
          fontWeight: 600,
          cursor: flagging ? 'wait' : 'pointer',
          background: 'rgba(239,68,68,0.13)',
          color: '#fca5a5',
          border: '1px solid rgba(239,68,68,0.35)',
          marginBottom: 8,
          opacity: flagging || status !== 'connected' ? 0.45 : 1,
        }}
      >
        {flagging ? 'Submitting flag...' : 'Flag suspicious meeting feed'}
      </button>

      <button
        onClick={() => void flagCurrentVideo()}
        disabled={flagging || status !== 'connected'}
        style={{
          width: '100%',
          padding: '7px 0',
          borderRadius: 7,
          fontSize: 12,
          fontWeight: 600,
          cursor: flagging ? 'wait' : 'pointer',
          background: 'rgba(245,158,11,0.12)',
          color: C.amber,
          border: '1px solid rgba(245,158,11,0.35)',
          marginBottom: 10,
          opacity: flagging || status !== 'connected' ? 0.45 : 1,
        }}
      >
        {flagging ? 'Submitting flag...' : 'Flag current page media'}
      </button>

      {result && (
        <div
          style={{
            padding: '10px 12px',
            borderRadius: 8,
            background: `rgba(${verdictColor === C.green ? '16,185,129' : '99,102,241'},0.08)`,
            border: `1px solid ${verdictColor}40`,
            marginBottom: 8,
          }}
        >
          <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 5 }}>
            <span
              style={{
                fontSize: 11,
                fontWeight: 700,
                color: verdictColor,
                textTransform: 'uppercase',
                letterSpacing: '0.05em',
              }}
            >
              {result.verdict}
            </span>
            <span style={{ fontSize: 11, color: C.muted }}>{result.confidence}% confidence</span>
          </div>
          <p style={{ fontSize: 11, color: '#94a3b8', lineHeight: 1.5, margin: 0 }}>{result.summary}</p>
        </div>
      )}

      {flagMessage && (
        <p style={{ fontSize: 11, color: C.muted, lineHeight: 1.4, margin: '0 0 8px' }}>{flagMessage}</p>
      )}

      <div
        style={{
          borderTop: '1px solid #1e293b',
          paddingTop: 8,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
        }}
      >
        <p style={{ fontSize: 10, color: '#334155', lineHeight: 1.4, margin: 0, flex: 1 }}>
          AI assessment is probabilistic, not guaranteed. Always verify from primary sources.
        </p>
        <button
          onClick={() => chrome.tabs.create({ url: 'http://localhost:5173' })}
          title="Open Veryfi dashboard"
          style={{
            marginLeft: 10,
            flexShrink: 0,
            background: 'none',
            border: 'none',
            color: C.brand,
            fontSize: 10,
            cursor: 'pointer',
            padding: 0,
            textDecoration: 'underline',
          }}
        >
          Open Dashboard {'->'}
        </button>
      </div>
    </div>
  )
}
