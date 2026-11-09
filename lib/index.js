/**
 * dsh-usage-hud —— Host 半侧
 *
 * 只挂一条只读路由：GET /usage-hud/api/state，返回三块数据
 *   window  当前是高峰还是峰谷 + 距离下次切换还剩多久 + 本时段已走百分比
 *   usage   今日 token 用量与花费（读 $DSH_HOME/sessions 下会话日志里每条模型回复的 usage）
 *   balance 账户余额（GET https://api.deepseek.com/user/balance）
 *
 * 不写任何文件、不上报。定价与节假日可用 $DSH_HOME/usage-hud.json 覆盖。
 */

import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { zstdDecompressSync } from 'node:zlib'
import https from 'node:https'
import http from 'node:http'
import tls from 'node:tls'

export const name = 'dsh-usage-hud'

/** 硬依赖：宿主 webServer（路由载体）。 */
export const inject = ['webServer']

/* ─────────────────────────── 配置 ─────────────────────────── */

/** 官方单价：元 / 百万 tokens。peak = 高峰价，idle = 峰谷价。 */
const DEFAULT_PRICES = {
  'deepseek-flash': {
    peak: { cache_hit: 0.04, cache_miss: 2, output: 8 },
    idle: { cache_hit: 0.02, cache_miss: 1, output: 4 },
  },
  'deepseek-v4-pro': {
    peak: { cache_hit: 0.3, cache_miss: 9, output: 27 },
    idle: { cache_hit: 0.15, cache_miss: 4.5, output: 13.5 },
  },
}

const DEFAULT_ALIASES = {
  'deepseek-v4-flash': 'deepseek-flash',
  'deepseek-v4-flash-vision-exp': 'deepseek-flash',
  'deepseek-chat': 'deepseek-flash',
  'deepseek-reasoner': 'deepseek-flash',
}

/** 国务院公布的法定节假日（放假日，含调休连休）。 */
const DEFAULT_HOLIDAYS = {
  2026: [
    '2026-01-01', '2026-01-02', '2026-01-03',
    '2026-02-15', '2026-02-16', '2026-02-17', '2026-02-18', '2026-02-19',
    '2026-02-20', '2026-02-21', '2026-02-22', '2026-02-23',
    '2026-04-04', '2026-04-05', '2026-04-06',
    '2026-05-01', '2026-05-02', '2026-05-03', '2026-05-04', '2026-05-05',
    '2026-06-19', '2026-06-20', '2026-06-21',
    '2026-09-25', '2026-09-26', '2026-09-27',
    '2026-10-01', '2026-10-02', '2026-10-03', '2026-10-04',
    '2026-10-05', '2026-10-06', '2026-10-07',
  ],
  2027: ['2027-01-01', '2027-01-02', '2027-01-03'],
}

const DEFAULTS = {
  peakWindows: [['09:00', '12:00'], ['14:00', '18:00']],
  defaultModel: 'deepseek-flash',
  balanceTtlMs: 60000,
  balanceTimeoutMs: 12000,
  /* 界面：白光款式 A/B/C，右下角小卡与窗口底/右的距离（px） */
  wave: 'pull',
  cardBottom: 67,
  cardRight: 18,
}

function dshHome() {
  if (process.env.DSH_HOME) return process.env.DSH_HOME
  return join(homedir(), '.dsh')
}

/** 读配置：允许 `//` 整行注释与尾逗号，方便手写（真 JSON 里写注释会解析失败）。 */
function parseJsonc(text) {
  const stripped = String(text)
    .split('\n')
    .filter((line) => !/^\s*\/\//.test(line))
    .join('\n')
    .replace(/,(\s*[}\]])/g, '$1')
  return JSON.parse(stripped)
}

function loadConfig() {
  const cfg = {
    prices: structuredClone(DEFAULT_PRICES),
    aliases: { ...DEFAULT_ALIASES },
    holidays: { ...DEFAULT_HOLIDAYS },
    ...DEFAULTS,
  }
  try {
    const file = join(dshHome(), 'usage-hud.json')
    if (existsSync(file)) {
      const user = parseJsonc(readFileSync(file, 'utf8'))
      if (user && typeof user === 'object') {
        if (user.prices && typeof user.prices === 'object') cfg.prices = user.prices
        if (user.aliases && typeof user.aliases === 'object') cfg.aliases = user.aliases
        if (user.holidays && typeof user.holidays === 'object') cfg.holidays = user.holidays
        if (Array.isArray(user.peakWindows) && user.peakWindows.length > 0) cfg.peakWindows = user.peakWindows
        if (typeof user.defaultModel === 'string') cfg.defaultModel = user.defaultModel
        if (Number.isFinite(user.balanceTtlMs)) cfg.balanceTtlMs = Number(user.balanceTtlMs)
        if (Number.isFinite(user.balanceTimeoutMs)) cfg.balanceTimeoutMs = Number(user.balanceTimeoutMs)
        if (typeof user.wave === 'string') {
          const w = user.wave.trim().toLowerCase()
          cfg.wave = w === 'pull' ? 'pull' : (w.toUpperCase() === 'A' || w.toUpperCase() === 'B' || w.toUpperCase() === 'C' ? w.toUpperCase() : cfg.wave)
        }
        if (Number.isFinite(user.cardBottom)) cfg.cardBottom = Math.max(0, Math.min(600, Number(user.cardBottom)))
        if (Number.isFinite(user.cardRight)) cfg.cardRight = Math.max(0, Math.min(600, Number(user.cardRight)))
      }
    }
  } catch {
    /* 配置坏了就用默认值 */
  }
  cfg.windows = cfg.peakWindows.map(([a, b]) => [hhmm(a), hhmm(b)])
  const holidaySet = new Set()
  for (const days of Object.values(cfg.holidays)) {
    for (const day of Array.isArray(days) ? days : []) holidaySet.add(String(day))
  }
  cfg.holidaySet = holidaySet
  return cfg
}

function hhmm(text) {
  const [h, m] = String(text).split(':')
  return (Number(h) || 0) * 60 + (Number(m) || 0)
}

let CONFIG = loadConfig()

/* ─────────────────────── 北京时间与峰谷 ─────────────────────── */

const pad2 = (n) => String(n).padStart(2, '0')

function beijing(tsMs) {
  const d = new Date(Number(tsMs) + 8 * 3600 * 1000)
  return {
    key: `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`,
    minutes: d.getUTCHours() * 60 + d.getUTCMinutes(),
    dow: d.getUTCDay(),
  }
}

function peakOf(tsMs) {
  const t = beijing(tsMs)
  if (CONFIG.holidaySet.has(t.key)) return { mode: 'idle', reason: '法定节假日' }
  if (t.dow === 0 || t.dow === 6) return { mode: 'idle', reason: '周末' }
  for (const [start, end] of CONFIG.windows) {
    if (t.minutes >= start && t.minutes < end) return { mode: 'peak', reason: '高峰' }
  }
  return { mode: 'idle', reason: '非高峰' }
}

function nextSwitch(tsMs) {
  const now = Math.floor(tsMs / 60000) * 60000
  const current = peakOf(now).mode
  for (let step = 1; step <= 60 * 24 * 9; step += 1) {
    const probe = now + step * 60000
    if (peakOf(probe).mode !== current) return probe
  }
  return null
}

function prevSwitch(tsMs) {
  const now = Math.floor(tsMs / 60000) * 60000
  const current = peakOf(now).mode
  for (let step = 1; step <= 60 * 24 * 9; step += 1) {
    const probe = now - step * 60000
    if (peakOf(probe).mode !== current) return probe
  }
  return null
}

/* ─────────────────────── 会话日志里的用量 ─────────────────────── */

const ZSTD_MAGIC = 0xfd2fb528
const FILE_CACHE = new Map()

/** 多帧 zstd：Node 只有一次性 API，按 magic 逐个试帧边界。 */
function decodeZstdFrames(buf) {
  const hits = []
  for (let i = 0; i + 4 <= buf.length; i += 1) {
    if (buf.readUInt32LE(i) === ZSTD_MAGIC) hits.push(i)
  }
  hits.push(buf.length)
  const chunks = []
  let i = 0
  while (i < hits.length - 1) {
    let advanced = false
    for (let j = i + 1; j < hits.length; j += 1) {
      try {
        chunks.push(zstdDecompressSync(buf.subarray(hits[i], hits[j])))
        i = j
        advanced = true
        break
      } catch {
        /* 不是帧尾，往后试 */
      }
    }
    if (!advanced) i += 1
  }
  return Buffer.concat(chunks).toString('utf8')
}

function recordsOf(path) {
  let stat
  try {
    stat = statSync(path)
  } catch {
    return []
  }
  const cached = FILE_CACHE.get(path)
  if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) return cached.records

  const records = []
  try {
    const text = decodeZstdFrames(readFileSync(path))
    for (const line of text.split('\n')) {
      if (line.length === 0) continue
      let event
      try {
        event = JSON.parse(line)
      } catch {
        continue
      }
      if (!event || event.type !== 'assistant/message') continue
      const usage = event.data && event.data.usage
      if (!usage || typeof usage !== 'object') continue
      const source = (event.data.message && event.data.message.source) || {}
      records.push({
        ts: Number(event.time) || 0,
        model: typeof source.model === 'string' && source.model !== '' ? source.model : CONFIG.defaultModel,
        miss: Number(usage.inputTokens) || 0,
        hit: Number(usage.cacheReadTokens) || 0,
        out: Number(usage.outputTokens) || 0,
      })
    }
  } catch {
    /* 单个文件坏了不影响整体 */
  }
  FILE_CACHE.set(path, { mtimeMs: stat.mtimeMs, size: stat.size, records })
  return records
}

function priceTableOf(model) {
  const key = CONFIG.aliases[model] || model
  const id = CONFIG.prices[key] ? key : CONFIG.defaultModel
  return { id, table: CONFIG.prices[id] || {} }
}

function costOf(record, mode) {
  const { table } = priceTableOf(record.model)
  const row = table[mode] || {}
  return (
    (record.miss / 1e6) * Number(row.cache_miss || 0)
    + (record.hit / 1e6) * Number(row.cache_hit || 0)
    + (record.out / 1e6) * Number(row.output || 0)
  )
}

function sessionFiles() {
  const root = join(dshHome(), 'sessions')
  const out = []
  let dirs = []
  try {
    dirs = readdirSync(root, { withFileTypes: true })
  } catch {
    return out
  }
  for (const dir of dirs) {
    if (!dir.isDirectory()) continue
    const workspaceDir = join(root, dir.name)
    let sessions = []
    try {
      sessions = readdirSync(workspaceDir, { withFileTypes: true })
    } catch {
      continue
    }
    for (const session of sessions) {
      if (!session.isDirectory()) continue
      const sessionDir = join(workspaceDir, session.name)
      let files = []
      try {
        files = readdirSync(sessionDir)
      } catch {
        continue
      }
      for (const file of files) {
        if (/^session.*\.jsonl(\.zstd)?$/.test(file)) out.push(join(sessionDir, file))
      }
    }
  }
  return out
}

let usageCache = { at: 0, value: null }

function usageSummary() {
  const nowMs = Date.now()
  if (usageCache.value !== null && nowMs - usageCache.at < 4000) return usageCache.value

  const today = beijing(nowMs).key
  const total = { cache_miss: 0, cache_hit: 0, output: 0, cost: 0, calls: 0 }
  const byMode = {
    peak: { cache_miss: 0, cache_hit: 0, output: 0, cost: 0 },
    idle: { cache_miss: 0, cache_hit: 0, output: 0, cost: 0 },
  }
  for (const file of sessionFiles()) {
    let stat
    try {
      stat = statSync(file)
    } catch {
      continue
    }
    if (stat.mtimeMs < nowMs - 36 * 3600 * 1000) continue
    for (const record of recordsOf(file)) {
      if (beijing(record.ts).key !== today) continue
      const { mode } = peakOf(record.ts)
      const cost = costOf(record, mode)
      total.cache_miss += record.miss
      total.cache_hit += record.hit
      total.output += record.out
      total.cost += cost
      total.calls += 1
      const bucket = byMode[mode]
      bucket.cache_miss += record.miss
      bucket.cache_hit += record.hit
      bucket.output += record.out
      bucket.cost += cost
    }
  }
  total.total = total.cache_miss + total.cache_hit + total.output
  const value = { date: today, totals: total, byMode }
  usageCache = { at: nowMs, value }
  return value
}

/** 只解第一帧，用来读会话头（id / delegationDepth / parentSession），不必展开整份日志。 */
function firstEventOf(path) {
  try {
    const buf = readFileSync(path)
    let end = buf.length
    for (let i = 4; i + 4 <= buf.length; i += 1) {
      if (buf.readUInt32LE(i) === ZSTD_MAGIC) {
        end = i
        break
      }
    }
    const text = zstdDecompressSync(buf.subarray(0, end)).toString('utf8')
    const line = text.split('\n').find((l) => l.trim() !== '') || ''
    return JSON.parse(line)
  } catch {
    return null
  }
}

/** 会话头缓存：按 mtime+size 失效，避免每次轮询都整读所有文件。 */
const HEADER_CACHE = new Map()

function headerOf(path) {
  let stat
  try {
    stat = statSync(path)
  } catch {
    return null
  }
  const cached = HEADER_CACHE.get(path)
  if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) return cached.header
  const header = firstEventOf(path)
  HEADER_CACHE.set(path, { mtimeMs: stat.mtimeMs, size: stat.size, header })
  return header
}

/** 全部会话的 id → { file, depth, parentId } 索引。 */
function sessionIndex() {
  const rows = new Map()
  for (const file of sessionFiles()) {
    const header = headerOf(file)
    if (!header) continue
    const id = typeof header.id === 'string' && header.id !== ''
      ? header.id
      : (file.split(/[\\/]/).slice(-2, -1)[0] || '')
    if (id === '') continue
    const parentId = typeof header.parentSession === 'string' && header.parentSession !== ''
      ? header.parentSession
      : null
    rows.set(id, { file, depth: Number(header.delegationDepth) || 0, parentId })
  }
  return rows
}

/** 某会话的全部子孙会话行（子代理 / 孙代理，递归；防环）。 */
function subSessionsOf(rootId) {
  const index = sessionIndex()
  const out = []
  const seen = new Set([rootId])
  let frontier = [rootId]
  while (frontier.length > 0) {
    const next = []
    for (const [id, row] of index) {
      if (row.parentId === null || seen.has(id)) continue
      if (frontier.indexOf(row.parentId) !== -1) {
        seen.add(id)
        next.push(id)
        out.push(row)
      }
    }
    frontier = next
  }
  return out
}

/** 当前「正在用的那个会话」：最近被写过、且不是子代理的几个根会话里最新的那个。 */
export function activeSessionUsage() {
  const files = []
  for (const file of sessionFiles()) {
    try {
      files.push({ file, mtimeMs: statSync(file).mtimeMs })
    } catch {
      /* 忽略 */
    }
  }
  files.sort((a, b) => b.mtimeMs - a.mtimeMs)
  for (const entry of files.slice(0, 6)) {
    const header = firstEventOf(entry.file)
    if (header && Number(header.delegationDepth) > 0) continue
    const id = header && typeof header.id === 'string'
      ? header.id
      : (entry.file.split(/[\\/]/).slice(-2, -1)[0] || '')
    const usage = sessionUsage(id)
    if (usage) return usage
  }
  return null
}

/** 单个会话的用量合计（右下角「本会话消耗」用）。
    文件夹大小逻辑：会话派生的子代理会话一起算进来；
    点进某个子代理会话时，显示的则是它自己那一支的合计。 */
export function sessionUsage(sessionId) {
  const id = String(sessionId || '')
  if (id === '') return null
  let file = null
  for (const candidate of sessionFiles()) {
    const dir = candidate.split(/[\\/]/).slice(-2, -1)[0] || ''
    if (dir === id) {
      file = candidate
      break
    }
  }
  if (file === null) return { id, found: false, tokens: 0, cost: 0, calls: 0 }

  const agg = { miss: 0, hit: 0, out: 0, cost: 0, calls: 0 }
  let model = CONFIG.defaultModel
  const addFile = (path) => {
    for (const record of recordsOf(path)) {
      const { mode } = peakOf(record.ts)
      agg.miss += record.miss
      agg.hit += record.hit
      agg.out += record.out
      agg.cost += costOf(record, mode)
      agg.calls += 1
      model = record.model
    }
  }

  addFile(file)
  const self = {
    tokens: agg.miss + agg.hit + agg.out,
    cost: agg.cost,
    calls: agg.calls,
    miss: agg.miss,
    hit: agg.hit,
    out: agg.out,
  }

  let subSessions = 0
  for (const sub of subSessionsOf(id)) {
    try {
      addFile(sub.file)
      subSessions += 1
    } catch {
      /* 单个子会话读不了就跳过，不影响整体 */
    }
  }

  return {
    id,
    found: true,
    model,
    tokens: agg.miss + agg.hit + agg.out,
    cacheMiss: agg.miss,
    cacheHit: agg.hit,
    output: agg.out,
    cost: agg.cost,
    calls: agg.calls,
    subSessions,
    selfTokens: self.tokens,
    selfCost: self.cost,
    selfCalls: self.calls,
  }
}

/* ─────────────────────────── 余额 ─────────────────────────── */

function apiKey() {
  if (process.env.DEEPSEEK_API_KEY) return process.env.DEEPSEEK_API_KEY.trim()
  try {
    const text = readFileSync(join(dshHome(), '.credentials.yaml'), 'utf8')
    const match = /^\s*DEEPSEEK_API_KEY:\s*(\S+)\s*$/m.exec(text)
    if (match) return match[1].trim().replace(/^['"]|['"]$/g, '')
  } catch {
    /* 没有就是没有 */
  }
  return null
}

function proxyOf() {
  for (const key of ['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy']) {
    if (process.env[key]) return process.env[key]
  }
  try {
    const text = readFileSync(join(dshHome(), '.env'), 'utf8')
    for (const line of text.split('\n')) {
      const m = /^\s*(HTTPS?_PROXY|https?_proxy)\s*=\s*(\S+)\s*$/.exec(line)
      if (m) return m[2]
    }
  } catch {
    /* 没有代理就直连 */
  }
  return null
}

function readAll(res, resolvePromise, rejectPromise) {
  let body = ''
  res.setEncoding('utf8')
  res.on('data', (chunk) => {
    body += chunk
    if (body.length > 1 << 20) {
      res.destroy()
      rejectPromise(new Error('response too large'))
    }
  })
  res.on('end', () => {
    try {
      resolvePromise(JSON.parse(body))
    } catch {
      rejectPromise(new Error('invalid JSON'))
    }
  })
  res.on('error', (error) => rejectPromise(error))
}

function getThroughProxy(proxyUrl, targetUrl, headers, timeoutMs) {
  return new Promise((resolvePromise, rejectPromise) => {
    let proxy
    try {
      proxy = new URL(proxyUrl)
    } catch {
      rejectPromise(new Error('bad proxy url'))
      return
    }
    const target = new URL(targetUrl)
    const port = Number(target.port) || 443
    const connectReq = http.request({
      host: proxy.hostname,
      port: Number(proxy.port) || 80,
      method: 'CONNECT',
      path: `${target.hostname}:${port}`,
      timeout: timeoutMs,
    })
    connectReq.on('connect', (res, socket) => {
      if (res.statusCode !== 200) {
        socket.destroy()
        rejectPromise(new Error('proxy CONNECT ' + res.statusCode))
        return
      }
      const req = https.request({
        host: target.hostname,
        port,
        path: target.pathname + target.search,
        method: 'GET',
        headers: { Host: target.hostname, ...headers },
        agent: false,
        timeout: timeoutMs,
        createConnection: () => tls.connect({ socket, servername: target.hostname }),
      }, (response) => readAll(response, resolvePromise, rejectPromise))
      req.on('timeout', () => req.destroy(new Error('timeout')))
      req.on('error', (error) => rejectPromise(error))
      req.end()
    })
    connectReq.on('timeout', () => connectReq.destroy(new Error('proxy timeout')))
    connectReq.on('error', (error) => rejectPromise(error))
    connectReq.end()
  })
}

function getDirect(targetUrl, headers, timeoutMs) {
  return new Promise((resolvePromise, rejectPromise) => {
    const req = https.request(targetUrl, { method: 'GET', headers, timeout: timeoutMs }, (res) => {
      if (res.statusCode !== 200) {
        res.resume()
        rejectPromise(new Error('HTTP ' + res.statusCode))
        return
      }
      readAll(res, resolvePromise, rejectPromise)
    })
    req.on('timeout', () => req.destroy(new Error('timeout')))
    req.on('error', (error) => rejectPromise(error))
    req.end()
  })
}

const BALANCE_URL = 'https://api.deepseek.com/user/balance'
let balanceCache = { at: 0, value: null, error: null }

async function fetchBalance() {
  const key = apiKey()
  if (!key) throw new Error('未找到 DEEPSEEK_API_KEY')
  const headers = { Authorization: 'Bearer ' + key, Accept: 'application/json' }
  let payload
  try {
    payload = await getDirect(BALANCE_URL, headers, CONFIG.balanceTimeoutMs)
  } catch (directError) {
    const proxy = proxyOf()
    if (!proxy) throw directError
    payload = await getThroughProxy(proxy, BALANCE_URL, headers, CONFIG.balanceTimeoutMs)
  }
  const infos = Array.isArray(payload.balance_infos) ? payload.balance_infos : []
  const cny = infos.find((info) => info.currency === 'CNY') || infos[0] || {}
  return {
    ok: true,
    currency: cny.currency || 'CNY',
    total: Number(cny.total_balance || 0),
    toppedUp: Number(cny.topped_up_balance || 0),
    granted: Number(cny.granted_balance || 0),
    isAvailable: payload.is_available === true,
  }
}

async function balanceState() {
  const age = Date.now() - balanceCache.at
  const ttl = balanceCache.error ? Math.min(15000, CONFIG.balanceTtlMs) : CONFIG.balanceTtlMs
  if (balanceCache.value !== null && age < ttl) {
    return { ...balanceCache.value, error: balanceCache.error, checkedAt: balanceCache.at }
  }
  try {
    const value = await fetchBalance()
    balanceCache = { at: Date.now(), value, error: null }
  } catch (error) {
    const message = error && error.message ? error.message : String(error)
    balanceCache = {
      at: Date.now(),
      value: balanceCache.value === null ? { ok: false, total: null } : balanceCache.value,
      error: message,
    }
  }
  return { ...balanceCache.value, error: balanceCache.error, checkedAt: balanceCache.at }
}

/* ─────────────────────────── 汇总 ─────────────────────────── */

export async function computeState() {
  const now = Date.now()
  const { mode, reason } = peakOf(now)
  const next = nextSwitch(now)
  const prev = prevSwitch(now)
  const span = next !== null && prev !== null ? next - prev : 0
  const prices = {}
  for (const [key, table] of Object.entries(CONFIG.prices)) {
    const row = table[mode] || {}
    prices[key] = { cache_hit: row.cache_hit, cache_miss: row.cache_miss, output: row.output }
  }
  const balance = await balanceState()
  return {
    now,
    ui: { wave: CONFIG.wave, cardBottom: CONFIG.cardBottom, cardRight: CONFIG.cardRight },
    window: {
      mode,
      label: mode === 'peak' ? '高峰' : '峰谷',
      reason,
      nextChange: next,
      phaseStart: prev,
      secondsToChange: next === null ? null : Math.max(0, Math.round((next - now) / 1000)),
      progress: span > 0 ? Math.min(1, Math.max(0, (now - prev) / span)) : 0,
      nextIsPeak: peakOf(next === null ? now : next).mode === 'peak',
      prices,
    },
    usage: usageSummary(),
    balance,
  }
}

/* ─────────────────────────── 路由 ─────────────────────────── */

function sendJson(res, status, value) {
  const body = JSON.stringify(value)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body),
  })
  res.end(body)
}

function loopbackOnly(req) {
  const remote = req.socket && req.socket.remoteAddress ? String(req.socket.remoteAddress) : ''
  return remote === '127.0.0.1' || remote === '::1' || remote === '::ffff:127.0.0.1' || remote === ''
}

export function apply(ctx) {
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: '/usage-hud/api/state',
    handler: async (req, res) => {
      if (!loopbackOnly(req)) {
        sendJson(res, 403, { ok: false, error: 'loopback only' })
        return
      }
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        sendJson(res, 405, { ok: false, error: 'GET only' })
        return
      }
      try {
        CONFIG = loadConfig()
        /* ?fresh=1：右键刷新时把两份缓存都作废 */
        if (/[?&]fresh=1/.test(req.url || '')) {
          usageCache = { at: 0, value: null }
          balanceCache = { at: 0, value: balanceCache.value, error: null }
        }
        sendJson(res, 200, await computeState())
      } catch (error) {
        sendJson(res, 500, { ok: false, error: error && error.message ? error.message : String(error) })
      }
    },
  }), 'usage-hud: GET /usage-hud/api/state')

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: '/usage-hud/api/session',
    handler: async (req, res) => {
      if (!loopbackOnly(req)) {
        sendJson(res, 403, { ok: false, error: 'loopback only' })
        return
      }
      try {
        CONFIG = loadConfig()
        const match = /[?&]id=([^&]+)/.exec(req.url || '')
        if (match) {
          sendJson(res, 200, sessionUsage(decodeURIComponent(match[1])) || { found: false, tokens: 0, cost: 0, calls: 0 })
          return
        }
        sendJson(res, 200, activeSessionUsage() || { found: false, tokens: 0, cost: 0, calls: 0 })
      } catch (error) {
        sendJson(res, 500, { ok: false, error: error && error.message ? error.message : String(error) })
      }
    },
  }), 'usage-hud: GET /usage-hud/api/session')
}
