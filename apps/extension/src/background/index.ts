/**
 * Background Service Worker — Phase 4 implementation.
 *
 * DEVELOPER: Fidel
 * ─────────────────────────────────────────────────────────────────────────────
 * This is the extension's "backend" — a service worker that runs persistently
 * in the background. It acts as the secure message broker between content
 * scripts, the popup, and the TruthGuard API.
 *
 * RESPONSIBILITIES
 * ─────────────────
 * 1. Context menu — registers "Analyze with TruthGuard" on right-click.
 *    When triggered, calls the API and sends the result to the content script.
 * 2. Message routing — handles ANALYZE_TEXT, GET_SETTINGS, SET_SETTINGS.
 * 3. API proxy — all fetch() calls to the backend happen here, not in content scripts.
 *    Content scripts cannot call the API directly (blocked by CORS).
 * 4. Badge counter — increments the red number badge on the toolbar icon
 *    each time a flagged post is detected.
 * 5. Settings storage — reads/writes user preferences via chrome.storage.sync.
 *    chrome.storage.sync (used here) syncs across the user's devices.
 *    chrome.storage.local (not used here) stays on one device only.
 *
 * SECURITY
 * ─────────
 * - No API keys are stored here. The backend validates requests server-side.
 * - All API calls use settings.apiBase (defaults to localhost:8000).
 * - CORS is validated server-side; the extension's origin bypasses the page CORS.
 *
 * THE `return true` PATTERN (CRITICAL — do not remove)
 * ──────────────────────────────────────────────────────
 * chrome.runtime.onMessage.addListener() is synchronous by default.
 * If you return without calling sendResponse, the channel closes immediately.
 * But our API calls are ASYNC (they involve a fetch() that takes time).
 * Returning `true` from the listener tells Chrome: "I will call sendResponse
 * asynchronously — keep the channel open."
 * Without `return true`, the content script callback receives `undefined`
 * instead of the API result because Chrome closed the channel before fetch() resolved.
 *
 * See docs/developers/FIDEL.md for full architecture diagram and task list.
 */

// ── Types ──────────────────────────────────────────────────────────────────────

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

interface VideoFramePayload {
  platform: string
  videoUrl: string
  timestampMs: number
  frameB64: string
}

interface DeepfakeFrameResult {
  label: 'REAL' | 'SUSPECTED_FAKE' | 'UNVERIFIED'
  confidence: number
  deepfakeScore: number
  explainability: string
}

interface VideoFlagPayload {
  sourceUrl: string
  platform: string
  category?: string
  reason?: string
  confidence?: number
  location?: {
    lat: number
    lng: number
  } | null
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

// ── Default settings ────────────────────────────────────────────────────────────
// These are written to chrome.storage.sync on first install.
// On subsequent updates (reason === 'update'), these defaults are NOT re-applied
// so that any user customisations are preserved.
const DEFAULT_SETTINGS: Settings = {
  enabled: true,
  sensitivity: 'medium',
  apiBase: 'http://localhost:8000',  // change to production URL for deployment
  redFlagEnabled: true,
  meetingModeEnabled: false,
}

// ── Install / update handler ────────────────────────────────────────────────────

chrome.runtime.onInstalled.addListener((details) => {
  console.log('[TruthGuard BG] Installed/updated:', details.reason)

  // Register the right-click context menu entry.
  // contexts: ['selection'] means it only appears when the user has text selected.
  chrome.contextMenus.create({
    id:       'tg-analyze-selection',
    title:    'Analyze with Veryfi',
    contexts: ['selection'],
  })

  // Write default settings ONLY on first install (reason === 'install').
  // On updates we skip this so user's saved sensitivity/apiBase are preserved.
  if (details.reason === 'install') {
    chrome.storage.sync.set(DEFAULT_SETTINGS)
  }
})

// ── Context menu click handler ──────────────────────────────────────────────────

chrome.contextMenus.onClicked.addListener((info, tab) => {
  // Guard: ignore clicks on other menu items or if no text was selected
  if (info.menuItemId !== 'tg-analyze-selection' || !info.selectionText) return

  // Relay the selected text to the content script so it can call the API
  // directly. This avoids MV3 service-worker port timeouts on long Gemini calls.
  if (tab?.id) {
    chrome.tabs.sendMessage(tab.id, {
      type: 'RUN_TRIAGE',
      payload: info.selectionText,
    })
  }
})

// ── Message routing ─────────────────────────────────────────────────────────────
//
// Handles three message types from content scripts and the popup:
//
//   ANALYZE_TEXT: { type, payload: string }
//     → calls analyzeViaAPI(text), replies { ok: true, data: TriageResult }
//     → return true (REQUIRED for async response — see file header)
//
//   GET_SETTINGS: { type }
//     → reads chrome.storage.sync, replies { ok: true, data: Settings }
//     → return true (storage.get is async)
//
//   SET_SETTINGS: { type, payload: Partial<Settings> }
//     → writes to chrome.storage.sync, replies { ok: true }
//     → return true (storage.set is async)

chrome.runtime.onMessage.addListener(
  (
    message: { type: string; payload?: unknown },
    _sender: chrome.runtime.MessageSender,
    sendResponse: (response: unknown) => void,
  ) => {
    if (message.type === 'ANALYZE_TEXT') {
      const text = message.payload as string
      analyzeViaAPI(text)
        .then((result) => {
          sendResponse({ ok: true, data: result })
          // Increment the toolbar badge counter only for suspicious verdicts
          if (result.verdict !== 'TRUE' && result.verdict !== 'UNVERIFIED') {
            updateBadge()
          }
        })
        .catch((err: Error) => sendResponse({ ok: false, error: err.message }))
      return true   // ← KEEP THIS: tells Chrome to wait for the async sendResponse call
    }

    if (message.type === 'ANALYZE_VIDEO_FRAME') {
      const payload = message.payload as VideoFramePayload
      analyzeVideoFrame(payload)
        .then((result) => sendResponse({ ok: true, data: result }))
        .catch((err: Error) => sendResponse({ ok: false, error: err.message }))
      return true
    }

    if (message.type === 'FLAG_VIDEO') {
      const payload = message.payload as VideoFlagPayload
      submitVideoFlag(payload)
        .then((result) => sendResponse({ ok: true, data: result }))
        .catch((err: Error) => sendResponse({ ok: false, error: err.message }))
      return true
    }

    if (message.type === 'GET_SETTINGS') {
      // chrome.storage.sync.get() is async — that's why return true is needed here too
      chrome.storage.sync.get(DEFAULT_SETTINGS, (s) =>
        sendResponse({ ok: true, data: s }),
      )
      return true   // ← KEEP THIS
    }

    if (message.type === 'SET_SETTINGS') {
      // Partial update — merges payload with existing storage values
      chrome.storage.sync.set(message.payload as Partial<Settings>, () =>
        sendResponse({ ok: true }),
      )
      return true   // ← KEEP THIS
    }

    // Unknown message type — reply immediately (no async needed, return false)
    sendResponse({ ok: false, error: 'Unknown message type' })
    return false
  },
)

// ── API call helper ─────────────────────────────────────────────────────────────

// Reads current settings from storage. Returns DEFAULT_SETTINGS if storage is empty.
// Wrapped in a Promise because chrome.storage.sync.get() uses callbacks, not async/await.
async function getSettings(): Promise<Settings> {
  return new Promise((resolve) =>
    chrome.storage.sync.get(DEFAULT_SETTINGS, (s) => resolve(s as Settings)),
  )
}

// Core function: sends text to the TruthGuard API and returns a TriageResult.
// Checks settings.enabled first — if the user turned scanning off, returns
// a polite UNVERIFIED result without making an API call.
async function analyzeViaAPI(text: string): Promise<TriageResult> {
  const settings = await getSettings()

  if (!settings.enabled) {
    return { verdict: 'UNVERIFIED', confidence: 0, summary: 'Veryfi is disabled.' }
  }

  const res = await fetch(`${settings.apiBase}/api/v1/triage`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify({ text }),
    signal:  AbortSignal.timeout(55000),  // article fetch (~15s) + Gemini (~30s)
  })

  if (!res.ok) throw new Error(`API error ${res.status}`)
  return res.json()
}

/**
 * Runs quick deepfake analysis on a sampled video frame.
 *
 * Phase 1 implementation:
 * - Content script samples visible video frames as JPEG base64
 * - Background proxies to backend image endpoint
 * - Backend returns is_deepfake/confidence/reasoning
 * - We normalize into a video-friendly result shape
 */
async function analyzeVideoFrame(payload: VideoFramePayload): Promise<DeepfakeFrameResult> {
  const settings = await getSettings()

  if (!settings.enabled || !settings.redFlagEnabled) {
    return {
      label: 'UNVERIFIED',
      confidence: 0,
      deepfakeScore: 0,
      explainability: 'Red-Flag background protection is disabled.',
    }
  }

  if (!payload.frameB64) {
    throw new Error('Missing frame payload.')
  }

  // 10 s timeout: if the backend doesn't respond, the pending-video lock in the
  // content script would otherwise never be released for that video element.
  const res = await fetch(`${settings.apiBase}/api/v1/deepfake/image`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      image_b64: payload.frameB64,
      filename: `${payload.platform || 'video'}-frame.jpg`,
    }),
    signal: AbortSignal.timeout(10000),
  })

  if (!res.ok) {
    throw new Error(`Deepfake API error ${res.status}`)
  }

  const data = await res.json() as {
    is_deepfake?: boolean
    confidence?: number
    reasoning?: string
  }

  const normalizedScore = Math.max(0, Math.min(1, Number(data.confidence ?? 0)))
  const scorePercent = Math.round(normalizedScore * 100)
  // deepfakeScore = probability of being fake.
  // When is_deepfake=true, confidence IS the fake probability.
  // When is_deepfake=false, confidence is the "real" probability — invert it.
  const deepfakeScore = data.is_deepfake ? scorePercent : (100 - scorePercent)

  return {
    label: data.is_deepfake ? 'SUSPECTED_FAKE' : 'REAL',
    confidence: scorePercent,
    deepfakeScore,
    explainability: data.reasoning ?? 'Frame analysis complete.',
  }
}

/**
 * Save a user-submitted suspected-AI video flag for heatmap aggregation.
 */
async function submitVideoFlag(payload: VideoFlagPayload): Promise<VideoFlagResult> {
  const settings = await getSettings()

  if (!payload.sourceUrl?.trim()) {
    throw new Error('Missing source URL for flagged content.')
  }

  const res = await fetch(`${settings.apiBase}/api/v1/heatmap/flags`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      source_url: payload.sourceUrl,
      platform: payload.platform || 'web',
      category: payload.category ?? 'Deepfake',
      reason: payload.reason ?? 'user_suspected_ai_video',
      confidence: payload.confidence ?? null,
      location: payload.location ?? null,
    }),
  })

  if (!res.ok) {
    throw new Error(`Heatmap flag API error ${res.status}`)
  }

  const data = await res.json() as {
    ok?: boolean
    id?: string | null
    event?: { label?: string; category?: string; severity?: string }
  }

  return {
    ok: Boolean(data.ok),
    id: data.id ?? null,
    event: data.event ? {
      label: data.event.label ?? 'Unknown',
      category: data.event.category ?? 'Deepfake',
      severity: data.event.severity ?? 'medium',
    } : undefined,
  }
}

// ── Toolbar badge counter ───────────────────────────────────────────────────────
//
// The badge is the small red number shown on the extension icon in Chrome's toolbar.
// It increments every time a flagged post is detected anywhere in the browser.
//
// IMPORTANT: _flaggedCount is in-memory. Service workers are not persistent —
// Chrome may terminate and restart the background worker at any time.
// When restarted, _flaggedCount resets to 0. This is expected behaviour.
// To persist the count across restarts, store it in chrome.storage.local.
//
// TODO (Fidel): persist _flaggedCount to chrome.storage.local and load it on startup.

let _flaggedCount = 0

function updateBadge(): void {
  _flaggedCount += 1
  const label = _flaggedCount > 99 ? '99+' : String(_flaggedCount)
  chrome.action.setBadgeText({ text: label })
  chrome.action.setBadgeBackgroundColor({ color: '#ef4444' })   // red
}

export {}
