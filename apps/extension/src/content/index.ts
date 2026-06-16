import {
  extractText,
  getPostSelector,
  getVideoSelector,
  isAnalyzable,
  isMeetingHostname,
  truncate,
  verdictClass,
} from './utils'

const BADGE_THRESHOLD = 60
const VIDEO_SAMPLE_INTERVAL_MS = 5000
const VIDEO_BADGE_THRESHOLD = 75
const MEETING_VIDEO_BADGE_THRESHOLD = 65
const VIDEO_MAX_CAPTURE_WIDTH = 640
const VIDEO_SCAN_TICK_MS = 2000

const hostname = window.location.hostname.toLowerCase()

type TriageHighlight = {
  text: string   // verbatim phrase
  label: string  // "ai_generated" | "accurate" | "misleading"
}

type TriageResult = {
  verdict: string
  confidence: number
  summary: string
  highlights?: TriageHighlight[]
}

type DeepfakeFrameResult = {
  label: 'REAL' | 'SUSPECTED_FAKE' | 'UNVERIFIED'
  confidence: number
  deepfakeScore: number
  explainability: string
}

interface VideoFramePayload {
  platform: string
  videoUrl: string
  timestampMs: number
  frameB64: string
}

interface RuntimeResponse<T> {
  ok: boolean
  data?: T
  error?: string
}

interface ExtensionSettings {
  redFlagEnabled?: boolean
  meetingModeEnabled?: boolean
  apiBase?: string
}

interface VideoRiskState {
  sampleCount: number
  avgScore: number
  lastScore: number
  highRiskHits: number
  lastReason: string
  lastLabel: DeepfakeFrameResult['label']
}

interface MeetingModeStatus {
  enabled: boolean
  meetingHost: boolean
  activeVideos: number
  sampledFrames: number
  latestRiskScore: number | null
  latestLabel: DeepfakeFrameResult['label']
  latestReason: string
  updatedAt: number
}

let _redFlagEnabled = true
let _meetingModeEnabled = false
let _apiBase = 'http://localhost:8000'
let _sampledMeetingFrames = 0
let _latestMeetingRiskScore: number | null = null
let _latestMeetingLabel: DeepfakeFrameResult['label'] = 'UNVERIFIED'
let _latestMeetingReason = 'No analysis yet.'
let _meetingStatusUpdatedAt = 0

let _videoSampleTimes = new WeakMap<HTMLVideoElement, number>()
let _videoPending = new WeakSet<HTMLVideoElement>()
let _videoRiskState = new WeakMap<HTMLVideoElement, VideoRiskState>()

const _frameCanvas = document.createElement('canvas')
const _frameContext = _frameCanvas.getContext('2d')

/** Returns false when the extension has been reloaded and this content script is orphaned. */
function isExtensionAlive(): boolean {
  try {
    return !!chrome.runtime?.id
  } catch {
    return false
  }
}

if (isExtensionAlive()) {
  try {
    chrome.runtime.sendMessage({ type: 'GET_SETTINGS' }, (res: RuntimeResponse<ExtensionSettings>) => {
      if (chrome.runtime.lastError || !res?.ok || !res.data) return
      if (typeof res.data.redFlagEnabled === 'boolean') {
        _redFlagEnabled = res.data.redFlagEnabled
      }
      if (typeof res.data.meetingModeEnabled === 'boolean') {
        _meetingModeEnabled = res.data.meetingModeEnabled
      }
      if (typeof res.data.apiBase === 'string' && res.data.apiBase) {
        _apiBase = res.data.apiBase.replace(/\/+$/, '')
      }
    })
  } catch {
    // Context already gone — silently ignore
  }
}

function injectBadge(el: HTMLElement, verdict: string, confidence: number): void {
  if (el.querySelector('.tg-badge')) return

  const badge = document.createElement('div')
  badge.className = `tg-badge ${verdictClass(verdict)}`
  badge.title = `Veryfi: ${verdict} - ${confidence}% confidence`
  badge.innerHTML =
    `<span class="tg-badge-icon">[TG]</span>` +
    `<span class="tg-badge-verdict">${verdict}</span>` +
    `<span class="tg-badge-pct">${confidence}%</span>`
  el.appendChild(badge)
}

function removeTooltip(): void {
  document.getElementById('tg-tooltip')?.remove()
}

function showTooltip(text: string, rect: DOMRect): void {
  removeTooltip()

  // Capture the container element NOW — clicking the button will clear the selection
  const sel = window.getSelection()
  if (sel?.rangeCount) {
    const anchor = sel.getRangeAt(0).commonAncestorContainer
    _pendingHighlightTarget = anchor instanceof Element ? anchor : anchor.parentElement
  }

  const tip = document.createElement('div')
  tip.id = 'tg-tooltip'
  tip.className = 'tg-tooltip'
  tip.innerHTML =
    `<span class="tg-tooltip-icon">[TG]</span>` +
    `<span class="tg-tooltip-label">Analyze: <em>${truncate(text, 40)}</em></span>` +
    `<button class="tg-tooltip-btn" id="tg-analyze-btn">Check -></button>`

  tip.style.top = `${rect.bottom + window.scrollY + 6}px`
  tip.style.left = `${rect.left + window.scrollX}px`
  document.body.appendChild(tip)

  document.getElementById('tg-analyze-btn')?.addEventListener('click', () => {
    removeTooltip()
    const highlightTarget = _pendingHighlightTarget
    _pendingHighlightTarget = null
    sendAnalyze(text, (result) => {
      showResultBanner(result.verdict, result.confidence, result.summary, result.highlights)
      if (highlightTarget && result.highlights?.length) {
        clearHighlights(highlightTarget)
        applyHighlights(highlightTarget, result.highlights)
      }
    })
  })
}

function showResultBanner(
  verdict: string,
  confidence: number,
  summary: string,
  highlights?: TriageHighlight[],
): void {
  document.getElementById('tg-result-banner')?.remove()

  const banner = document.createElement('div')
  banner.id = 'tg-result-banner'
  banner.className = `tg-result-banner ${verdictClass(verdict)}`

  // Header
  const header = document.createElement('div')
  header.className = 'tg-result-header'
  header.innerHTML =
    `<span class="tg-badge-icon">[TG]</span>` +
    `<strong>Veryfi</strong>` +
    `<span class="tg-result-verdict">${verdict} - ${confidence}%</span>` +
    `<button class="tg-result-close" id="tg-result-close">x</button>`
  banner.appendChild(header)

  // Summary
  const summaryEl = document.createElement('p')
  summaryEl.className = 'tg-result-summary'
  summaryEl.textContent = summary
  banner.appendChild(summaryEl)

  // Highlight chips (phrase-level annotations)
  if (highlights?.length) {
    const row = document.createElement('div')
    row.className = 'tg-highlights-row'
    for (const h of highlights) {
      const chip = document.createElement('span')
      chip.className = `tg-hl-chip tg-hl-${h.label.replace(/_/g, '-')}`
      const icon = h.label === 'ai_generated' ? '🤖' : h.label === 'accurate' ? '✓' : '⚠'
      chip.textContent = `${icon} ${truncate(h.text, 48)}`
      chip.title = h.text
      row.appendChild(chip)
    }
    banner.appendChild(row)
  }

  document.body.appendChild(banner)
  document.getElementById('tg-result-close')?.addEventListener('click', () => banner.remove())
  setTimeout(() => banner.remove(), 15000)
}

function directTriage(text: string, callback: (result: TriageResult) => void): void {
  fetch(`${_apiBase}/api/v1/triage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text }),
    signal: AbortSignal.timeout(55000),
  })
    .then((r) => r.json())
    .then((data: TriageResult) => callback(data))
    .catch(() => {})
}

function sendAnalyze(text: string, callback: (result: TriageResult) => void): void {
  directTriage(text, callback)
}


function sendAnalyzeVideoFrame(
  payload: VideoFramePayload,
  callback: (result: DeepfakeFrameResult | null) => void,
): void {
  // Call the deepfake API directly from the content script to avoid MV3
  // service-worker port timeouts on long-running Gemini requests.
  fetch(`${_apiBase}/api/v1/deepfake/image`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      image_b64: payload.frameB64,
      filename: `${payload.platform || 'video'}-frame.jpg`,
    }),
    signal: AbortSignal.timeout(45000),
  })
    .then((res) => {
      if (!res.ok) { callback(null); return }
      return res.json()
    })
    .then((data?: { is_deepfake?: boolean; confidence?: number; reasoning?: string }) => {
      if (!data) { callback(null); return }
      const norm = Math.max(0, Math.min(1, Number(data.confidence ?? 0)))
      const pct = Math.round(norm * 100)
      callback({
        label: data.is_deepfake ? 'SUSPECTED_FAKE' : 'REAL',
        confidence: pct,
        deepfakeScore: data.is_deepfake ? pct : (100 - pct),
        explainability: data.reasoning ?? 'Frame analysis complete.',
      })
    })
    .catch(() => callback(null))
}

function platformNameFromHost(host: string): string {
  if (host.includes('meet.google.com')) return 'google_meet'
  if (host.includes('zoom.us')) return 'zoom'
  if (host.includes('youtube')) return 'youtube'
  if (host.includes('tiktok')) return 'tiktok'
  if (host.includes('instagram')) return 'instagram'
  if (host.includes('twitter') || host.includes('x.com')) return 'x'
  if (host.includes('telegram')) return 'telegram'
  if (host.includes('facebook')) return 'facebook'
  return 'web'
}

function getMeetingModeStatus(): MeetingModeStatus {
  const selector = getVideoSelector(hostname)
  const activeVideos = selector ? document.querySelectorAll<HTMLVideoElement>(selector).length : 0
  return {
    enabled: _meetingModeEnabled,
    meetingHost: isMeetingHostname(hostname),
    activeVideos,
    sampledFrames: _sampledMeetingFrames,
    latestRiskScore: _latestMeetingRiskScore,
    latestLabel: _latestMeetingLabel,
    latestReason: _latestMeetingReason,
    updatedAt: _meetingStatusUpdatedAt,
  }
}

function clearVideoRiskBadges(): void {
  document.querySelectorAll<HTMLElement>('.tg-video-badge').forEach((badge) => badge.remove())
  document.querySelectorAll<HTMLElement>('.tg-video-container').forEach((container) => {
    container.classList.remove('tg-video-container')
  })

  _videoSampleTimes = new WeakMap<HTMLVideoElement, number>()
  _videoPending = new WeakSet<HTMLVideoElement>()
  _videoRiskState = new WeakMap<HTMLVideoElement, VideoRiskState>()
}

function shouldSampleVideo(video: HTMLVideoElement, now: number): boolean {
  if (_videoPending.has(video)) return false
  if (video.paused || video.ended) return false
  if (video.readyState < 2) return false

  const rect = video.getBoundingClientRect()
  if (rect.width < 160 || rect.height < 90) return false
  if (rect.bottom < 0 || rect.top > window.innerHeight) return false
  if (rect.right < 0 || rect.left > window.innerWidth) return false

  const lastSampleMs = _videoSampleTimes.get(video) ?? 0
  return now - lastSampleMs >= VIDEO_SAMPLE_INTERVAL_MS
}

function captureVideoFrame(video: HTMLVideoElement): string | null {
  if (!_frameContext) return null
  if (!video.videoWidth || !video.videoHeight) return null

  const scale = Math.min(1, VIDEO_MAX_CAPTURE_WIDTH / video.videoWidth)
  const targetWidth = Math.max(1, Math.round(video.videoWidth * scale))
  const targetHeight = Math.max(1, Math.round(video.videoHeight * scale))

  _frameCanvas.width = targetWidth
  _frameCanvas.height = targetHeight

  try {
    _frameContext.drawImage(video, 0, 0, targetWidth, targetHeight)
    const dataUrl = _frameCanvas.toDataURL('image/jpeg', 0.82)
    return dataUrl.split(',')[1] ?? null
  } catch {
    // Some protected media streams taint canvas reads.
    return null
  }
}

function getOrCreateRiskState(video: HTMLVideoElement): VideoRiskState {
  const cached = _videoRiskState.get(video)
  if (cached) return cached

  const created: VideoRiskState = {
    sampleCount: 0,
    avgScore: 0,
    lastScore: 0,
    highRiskHits: 0,
    lastReason: 'No analysis yet.',
    lastLabel: 'UNVERIFIED',
  }
  _videoRiskState.set(video, created)
  return created
}

function computeRiskScore(state: VideoRiskState, result: DeepfakeFrameResult): number {
  const incoming = Math.max(0, Math.min(100, result.deepfakeScore))

  state.sampleCount += 1
  state.lastScore = incoming
  state.avgScore = Math.round(((state.avgScore * (state.sampleCount - 1)) + incoming) / state.sampleCount)

  const suspicious = result.label === 'SUSPECTED_FAKE' || incoming >= VIDEO_BADGE_THRESHOLD
  if (suspicious) {
    state.highRiskHits = Math.min(state.highRiskHits + 1, 6)
  } else {
    state.highRiskHits = Math.max(state.highRiskHits - 1, 0)
  }

  state.lastReason = result.explainability
  state.lastLabel = result.label

  const weighted = Math.round((state.avgScore * 0.7) + (state.lastScore * 0.3))
  const consistencyBoost = state.highRiskHits >= 2 ? Math.min(10, state.highRiskHits * 2) : 0
  return Math.min(100, weighted + consistencyBoost)
}

function upsertVideoRiskBadge(video: HTMLVideoElement, score: number, state: VideoRiskState): void {
  const threshold = isMeetingHostname(hostname) ? MEETING_VIDEO_BADGE_THRESHOLD : VIDEO_BADGE_THRESHOLD
  const container = video.parentElement ?? video
  const existing = container.querySelector<HTMLElement>('.tg-video-badge')

  if (score < threshold) {
    existing?.remove()
    return
  }

  if (!container.classList.contains('tg-video-container')) {
    container.classList.add('tg-video-container')
  }

  const badge = existing ?? document.createElement('div')
  badge.className = 'tg-video-badge tg-video-badge-risk'
  badge.textContent = `${isMeetingHostname(hostname) ? 'Meeting AI risk' : 'Possible deepfake'} ${score}%`
  badge.title = `Samples: ${state.sampleCount}. ${state.lastReason}`

  if (!existing) {
    container.appendChild(badge)
  }
}

// ── Text highlighting ────────────────────────────────────────────────────────

/** Element whose text content the current selection lives in. Captured before
 *  the tooltip button is clicked (clicking clears the selection). */
let _pendingHighlightTarget: Element | null = null

function highlightPhraseInElement(el: Element, phrase: string, className: string): void {
  if (!phrase.trim()) return
  const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT)
  let node: Text | null
  while ((node = walker.nextNode() as Text | null)) {
    const content = node.textContent ?? ''
    const idx = content.indexOf(phrase)
    if (idx === -1) continue
    const parent = node.parentNode
    if (!parent || (parent as Element).closest?.('.tg-hl')) continue  // skip already-highlighted

    const mark = document.createElement('mark')
    mark.className = `tg-hl ${className}`
    mark.setAttribute('data-tg-hl', '1')
    mark.textContent = phrase

    const before = content.slice(0, idx)
    const after = content.slice(idx + phrase.length)
    if (before) parent.insertBefore(document.createTextNode(before), node)
    parent.insertBefore(mark, node)
    if (after) parent.insertBefore(document.createTextNode(after), node)
    parent.removeChild(node)
    break  // only first occurrence
  }
}

function applyHighlights(container: Element, highlights: TriageHighlight[]): void {
  for (const h of highlights) {
    const cls = `tg-hl-${h.label.replace(/_/g, '-')}`
    highlightPhraseInElement(container, h.text, cls)
  }
}

function clearHighlights(container: Element): void {
  container.querySelectorAll<HTMLElement>('[data-tg-hl]').forEach((mark) => {
    const parent = mark.parentNode
    if (!parent) return
    parent.replaceChild(document.createTextNode(mark.textContent ?? ''), mark)
    parent.normalize()
  })
}

/**
 * Finds the best article body container to apply page-level highlights to.
 * Tries progressively broader selectors until one has enough text content.
 */
function findArticleBody(): Element {
  const candidates = [
    'article',
    'main',
    '[role="main"]',
    '.article-body',
    '.article-content',
    '.post-content',
    '.entry-content',
    '#article-body',
    '#content',
  ]
  for (const sel of candidates) {
    const el = document.querySelector(sel)
    if (el && (el.textContent?.trim().length ?? 0) > 200) return el
  }
  return document.body
}

// ── Video scanning ───────────────────────────────────────────────────────────

function scanVideos(): void {
  const selector = getVideoSelector(hostname)
  if (!selector) return

  const meetingHost = isMeetingHostname(hostname)

  if (!_redFlagEnabled) {
    clearVideoRiskBadges()
    return
  }

  if (meetingHost && !_meetingModeEnabled) {
    clearVideoRiskBadges()
    return
  }

  const now = Date.now()
  const platform = platformNameFromHost(hostname)

  document.querySelectorAll<HTMLVideoElement>(selector).forEach((video) => {
    if (!shouldSampleVideo(video, now)) return

    const frameB64 = captureVideoFrame(video)
    if (!frameB64) return

    _videoSampleTimes.set(video, now)
    _videoPending.add(video)

    const payload: VideoFramePayload = {
      platform,
      videoUrl: video.currentSrc || video.src || window.location.href,
      timestampMs: Math.round(video.currentTime * 1000),
      frameB64,
    }

    sendAnalyzeVideoFrame(payload, (result) => {
      _videoPending.delete(video)
      if (!result) return

      const state = getOrCreateRiskState(video)
      const score = computeRiskScore(state, result)
      upsertVideoRiskBadge(video, score, state)

      if (meetingHost) {
        _sampledMeetingFrames += 1
        _latestMeetingRiskScore = score
        _latestMeetingLabel = state.lastLabel
        _latestMeetingReason = state.lastReason
        _meetingStatusUpdatedAt = Date.now()
      }
    })
  })
}

function scanPosts(): void {
  const selector = getPostSelector(hostname)
  if (!selector) return

  document.querySelectorAll<HTMLElement>(selector).forEach((el) => {
    if (el.dataset.tgScanned) return
    el.dataset.tgScanned = 'true'

    const text = extractText(el)
    if (!isAnalyzable(text)) return

    sendAnalyze(text, (result) => {
      if (result.confidence >= BADGE_THRESHOLD) {
        const container = el.closest<HTMLElement>('article, [role="article"]') ?? el
        injectBadge(container, result.verdict, result.confidence)
      }
    })
  })
}

document.addEventListener('mouseup', () => {
  const selection = window.getSelection()
  const text = selection?.toString().trim() ?? ''

  if (isAnalyzable(text) && selection?.rangeCount) {
    const rect = selection.getRangeAt(0).getBoundingClientRect()
    showTooltip(text, rect)
  } else {
    removeTooltip()
  }
})

document.addEventListener('mousedown', (event: MouseEvent) => {
  if (!(event.target as HTMLElement).closest('#tg-tooltip')) {
    removeTooltip()
  }
})

chrome.runtime.onMessage.addListener(
  (
    message: { type: string; payload?: unknown },
    _sender: chrome.runtime.MessageSender,
    sendResponse: (response: unknown) => void,
  ) => {
    if (message.type === 'RUN_TRIAGE') {
      const text = message.payload as string | undefined
      if (text) {
        directTriage(text, (result) => {
          showResultBanner(result.verdict, result.confidence, result.summary, result.highlights)
        })
      }
      sendResponse({ ok: true })
      return true
    }

    if (message.type === 'SHOW_RESULT') {
      const payload = message.payload as TriageResult | undefined
      if (payload) {
        showResultBanner(payload.verdict, payload.confidence, payload.summary, payload.highlights)
      }
      sendResponse({ ok: true })
      return true
    }

    if (message.type === 'APPLY_PAGE_HIGHLIGHTS') {
      const highlights = message.payload as TriageHighlight[] | undefined
      if (highlights?.length) {
        const body = findArticleBody()
        clearHighlights(body)
        applyHighlights(body, highlights)
      }
      sendResponse({ ok: true })
      return true
    }

    if (message.type === 'TG_SET_MEETING_MODE') {
      const payload = message.payload as { enabled?: boolean } | undefined
      _meetingModeEnabled = Boolean(payload?.enabled)

      if (isMeetingHostname(hostname) && !_meetingModeEnabled) {
        clearVideoRiskBadges()
      }

      sendResponse({ ok: true, data: getMeetingModeStatus() })
      return true
    }

    if (message.type === 'TG_SETTINGS_PATCH') {
      const payload = message.payload as ExtensionSettings | undefined
      if (typeof payload?.redFlagEnabled === 'boolean') {
        _redFlagEnabled = payload.redFlagEnabled
      }
      if (typeof payload?.meetingModeEnabled === 'boolean') {
        _meetingModeEnabled = payload.meetingModeEnabled
      }

      if (!_redFlagEnabled || (isMeetingHostname(hostname) && !_meetingModeEnabled)) {
        clearVideoRiskBadges()
      }

      sendResponse({ ok: true, data: getMeetingModeStatus() })
      return true
    }

    if (message.type === 'TG_GET_MEETING_STATUS') {
      sendResponse({ ok: true, data: getMeetingModeStatus() })
      return true
    }

    if (message.type === 'TG_FORCE_SCAN_MEETING') {
      scanVideos()
      sendResponse({ ok: true, data: getMeetingModeStatus() })
      return true
    }

    return false
  },
)

scanPosts()
scanVideos()

const _scanInterval = window.setInterval(() => {
  if (!isExtensionAlive()) {
    clearInterval(_scanInterval)
    observer.disconnect()
    return
  }
  scanVideos()
}, VIDEO_SCAN_TICK_MS)

const observer = new MutationObserver(() => {
  if (!isExtensionAlive()) return
  scanPosts()
  scanVideos()
})

if (document.body) {
  observer.observe(document.body, { childList: true, subtree: true })
}

export {}
