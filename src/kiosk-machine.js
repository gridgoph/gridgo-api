/**
 * GRIDGO print kiosk.
 *
 * One machine record (tray, printer, A4 prices, map pin, payment QR) plus
 * short-lived upload sessions. The kiosk and the phone that scans its QR
 * use the public routes. Super Admin edits the machine. A C# coin acceptor
 * posts here with the coin key; it does not need the session id.
 */

import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { identityHasMembership } from './authorization-context.js'
import { inspectArtwork } from './artwork-inspection.js'

const COIN_VALUES = new Set([100, 500, 1000, 2000])
const PRINTER_STATUSES = new Set(['online', 'offline', 'out_of_paper', 'paper_jam'])
const MAX_FILE_BYTES = 50 * 1024 * 1024
const SESSION_TTL_MS = 2 * 60 * 60 * 1000

const DEFAULT_MACHINE = {
  id: 'kiosk_davao',
  name: 'GRIDGO Kiosk · Davao',
  paperCount: 240,
  printerStatus: 'online',
  paperSize: 'A4',
  priceBwMinor: 100,
  priceColorMinor: 500,
  lat: 7.0731,
  lng: 125.6128,
  paymentQrTemplate: 'https://gridgo.ph/pay?amount={amount}&order={order}&session={session}',
  paymentQrEnabled: true,
  publicBaseUrl: '',
  updatedAt: null,
}

export function kioskPathname(pathname) {
  const stripped = pathname.startsWith('/api/') ? pathname.slice(4) : pathname
  return stripped.length > 1 ? stripped.replace(/\/+$/, '') : stripped
}

export function isPublicKioskPath(pathname) {
  const path = kioskPathname(pathname)
  return path === '/kiosk/machine'
    || path === '/kiosk/machine/adjust'
    || path === '/kiosk/hardware/coins'
    || path === '/kiosk/hardware/status'
    || path === '/kiosk/sessions'
    || path.startsWith('/kiosk/sessions/')
}

export function isKioskFileUpload(method, pathname) {
  return method === 'POST' && /^\/kiosk\/sessions\/[^/]+\/file$/.test(kioskPathname(pathname))
}

export function isPublicKioskWrite(method, pathname) {
  if (method !== 'POST' && method !== 'PATCH') return false
  return isPublicKioskPath(pathname)
}

export function isAdminKioskPath(pathname) {
  return kioskPathname(pathname) === '/admin/kiosk'
}

function fail(status, code, message) {
  const error = new Error(message)
  error.status = status
  error.code = code
  throw error
}

function clampPaper(value) {
  return Math.max(0, Math.min(2000, Math.round(value)))
}

function publicMachine(machine) {
  return {
    id: machine.id,
    name: machine.name,
    paperCount: machine.paperCount,
    printerStatus: machine.printerStatus,
    paperSize: machine.paperSize,
    priceBwMinor: machine.priceBwMinor,
    priceColorMinor: machine.priceColorMinor,
    lat: machine.lat,
    lng: machine.lng,
    paymentQrTemplate: machine.paymentQrTemplate,
    paymentQrEnabled: machine.paymentQrEnabled !== false,
    publicBaseUrl: machine.publicBaseUrl,
    updatedAt: machine.updatedAt,
  }
}

function sessionView(session) {
  return {
    sessionId: session.id,
    status: session.status,
    document: session.document,
    revision: session.revision || 0,
    coinsInsertedMinor: session.coinsInsertedMinor,
    pay: session.pay,
  }
}

export function paymentQrValue(template, { amountMinor, orderCode, sessionId }) {
  const amount = (Number(amountMinor) / 100).toFixed(2)
  const source = template || DEFAULT_MACHINE.paymentQrTemplate
  return source
    .replaceAll('{amountMinor}', String(amountMinor))
    .replaceAll('{amount}', amount)
    .replaceAll('{order}', orderCode || '')
    .replaceAll('{session}', sessionId || '')
}

function pptxSlideCount(bytes) {
  const slides = new Set()
  const text = bytes.toString('latin1')
  for (const match of text.matchAll(/ppt\/slides\/slide(\d+)\.xml/g)) slides.add(match[1])
  return slides.size
}

function pageCountFor(mime, bytes) {
  if (String(mime).startsWith('image/')) return 1
  if (mime === 'application/vnd.openxmlformats-officedocument.presentationml.presentation') {
    const slides = pptxSlideCount(bytes)
    if (slides > 0) return Math.min(2000, slides)
  }
  const pages = inspectArtwork(bytes, mime)?.pageCount
  if (Number.isInteger(pages) && pages > 0) return Math.min(2000, pages)
  return 1
}

function fileSizeLabel(size) {
  return size < 1024 * 1024 ? `${Math.max(1, Math.round(size / 1024))} KB` : `${(size / (1024 * 1024)).toFixed(1)} MB`
}

const PRINT_TYPES = {
  '.pdf': { mime: 'application/pdf', kind: 'pdf' },
  '.png': { mime: 'image/png', kind: 'png' },
  '.jpg': { mime: 'image/jpeg', kind: 'jpeg' },
  '.jpeg': { mime: 'image/jpeg', kind: 'jpeg' },
  '.gif': { mime: 'image/gif', kind: 'gif' },
  '.webp': { mime: 'image/webp', kind: 'webp' },
  '.bmp': { mime: 'image/bmp', kind: 'bmp' },
  '.doc': { mime: 'application/msword', kind: 'ole' },
  '.ppt': { mime: 'application/vnd.ms-powerpoint', kind: 'ole' },
  '.docx': { mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', kind: 'docx' },
  '.pptx': { mime: 'application/vnd.openxmlformats-officedocument.presentationml.presentation', kind: 'pptx' },
}

function hasSignature(bytes, signature) {
  if (bytes.length < signature.length) return false
  for (let index = 0; index < signature.length; index += 1) {
    if (bytes[index] !== signature[index]) return false
  }
  return true
}

function matchesPrintKind(bytes, kind) {
  if (kind === 'pdf') return bytes.length >= 5 && bytes.subarray(0, 5).toString('latin1') === '%PDF-'
  if (kind === 'png') return hasSignature(bytes, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
  if (kind === 'jpeg') return hasSignature(bytes, Buffer.from([0xff, 0xd8, 0xff]))
  if (kind === 'gif') {
    const head = bytes.length >= 6 ? bytes.subarray(0, 6).toString('latin1') : ''
    return head === 'GIF87a' || head === 'GIF89a'
  }
  if (kind === 'webp') {
    return bytes.length >= 12
      && bytes.subarray(0, 4).toString('latin1') === 'RIFF'
      && bytes.subarray(8, 12).toString('latin1') === 'WEBP'
  }
  if (kind === 'bmp') return hasSignature(bytes, Buffer.from('BM'))
  if (kind === 'ole') return hasSignature(bytes, Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]))
  if (kind === 'docx' || kind === 'pptx') {
    if (!hasSignature(bytes, Buffer.from([0x50, 0x4b, 0x03, 0x04]))) return false
    const marker = kind === 'docx' ? 'word/document.xml' : 'ppt/presentation.xml'
    return bytes.includes(Buffer.from(marker))
  }
  return false
}

function safePrintName(filename, extension) {
  const base = path.basename(String(filename || '').replace(/[\u0000-\u001f]/g, ''))
  const cleaned = base.replace(/[^A-Za-z0-9._ ()-]/g, '').replace(/^\.+/, '').slice(0, 120)
  if (!cleaned.toLowerCase().endsWith(extension)) return `document${extension}`
  return cleaned
}

export function validatePrintFile({ filename, bytes }) {
  if (!bytes?.length) fail(400, 'file_required', 'Choose a file to send to the kiosk.')
  if (bytes.length > MAX_FILE_BYTES) fail(413, 'file_too_large', 'This file is over 50 MB. Choose a smaller file.')
  const extension = path.extname(String(filename || '')).toLowerCase()
  const type = PRINT_TYPES[extension]
  if (!type) fail(415, 'file_type_rejected', 'Send a PDF, Word, PowerPoint, or image file.')
  if (!matchesPrintKind(bytes, type.kind)) {
    fail(415, 'file_type_rejected', 'This file does not match its type. Send a real PDF, Word, PowerPoint, or image.')
  }
  return { filename: safePrintName(filename, extension), mime: type.mime, bytes }
}

export function parseMultipartFile(buffer, contentType) {
  const match = /boundary=(?:"([^"]+)"|([^;\s]+))/i.exec(String(contentType || ''))
  if (!match) fail(400, 'invalid_upload', 'Upload the file as multipart form data.')
  const boundary = Buffer.from(`--${match[1] || match[2]}`)
  let cursor = buffer.indexOf(boundary)
  while (cursor !== -1) {
    const next = buffer.indexOf(boundary, cursor + boundary.length)
    if (next === -1) break
    let start = cursor + boundary.length
    if (buffer[start] === 13 && buffer[start + 1] === 10) start += 2
    const chunk = buffer.subarray(start, next)
    const sep = chunk.indexOf('\r\n\r\n')
    if (sep >= 0) {
      const head = chunk.subarray(0, sep).toString('utf8')
      if (/name="file"/i.test(head)) {
        let bytes = chunk.subarray(sep + 4)
        if (bytes.length >= 2 && bytes[bytes.length - 2] === 13 && bytes[bytes.length - 1] === 10) {
          bytes = bytes.subarray(0, -2)
        }
        const name = /filename="([^"]*)"/i.exec(head)?.[1] || 'document'
        const mime = /Content-Type:\s*([^\r\n]+)/i.exec(head)?.[1]?.trim() || 'application/octet-stream'
        return { filename: path.basename(name).slice(0, 180) || 'document', mime, bytes }
      }
    }
    cursor = next
  }
  fail(400, 'file_required', 'Choose a file to send to the kiosk.')
}

async function readRaw(req, maxBytes) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > maxBytes) fail(413, 'file_too_large', 'This file is over 50 MB. Choose a smaller file.')
    chunks.push(chunk)
  }
  return Buffer.concat(chunks)
}

function jsonBody(req) {
  if (req && Object.hasOwn(req, 'gridgoParsedBody')) return req.gridgoParsedBody || {}
  return {}
}

export function createKioskStore({ root }) {
  const file = path.join(root, 'kiosk-machine.json')
  const filesDir = path.join(root, 'kiosk-files')
  fs.mkdirSync(filesDir, { recursive: true })

  const state = load()
  let chain = Promise.resolve()

  function enqueue(fn) {
    const run = chain.then(() => fn())
    chain = run.then(() => {}, () => {})
    return run
  }

  function load() {
    try {
      const parsed = JSON.parse(fs.readFileSync(file, 'utf8'))
      const sessions = parsed.sessions || {}
      for (const session of Object.values(sessions)) {
        session.coinEvents ||= []
        session.coinsInsertedMinor ||= 0
      }
      return {
        machine: { ...DEFAULT_MACHINE, ...parsed.machine, coinKey: parsed.machine?.coinKey || crypto.randomBytes(18).toString('hex') },
        sessions,
      }
    } catch {
      const fresh = {
        machine: { ...DEFAULT_MACHINE, coinKey: crypto.randomBytes(18).toString('hex'), updatedAt: new Date().toISOString() },
        sessions: {},
      }
      fs.writeFileSync(file, JSON.stringify(fresh))
      return fresh
    }
  }

  function persist() {
    const snapshot = JSON.stringify({
      machine: state.machine,
      sessions: state.sessions,
    })
    return fs.promises.writeFile(file, snapshot)
  }

  function sweep() {
    const cutoff = Date.now() - SESSION_TTL_MS
    for (const [id, session] of Object.entries(state.sessions)) {
      if (Date.parse(session.createdAt) < cutoff) {
        if (session.filePath) fs.rmSync(session.filePath, { force: true })
        delete state.sessions[id]
      }
    }
  }

  function requireSession(id) {
    sweep()
    const session = state.sessions[id]
    if (!session) fail(404, 'session_not_found', 'This upload session has expired. Scan the kiosk QR again.')
    return session
  }

  function activePaySession() {
    return Object.values(state.sessions).find((session) => session.pay?.active) || null
  }

  function addCoin(session, denominationMinor, eventId, source) {
    if (!COIN_VALUES.has(denominationMinor)) {
      fail(400, 'invalid_coin', 'The coin slot accepts ₱1, ₱5, ₱10, and ₱20.')
    }
    const id = String(eventId || crypto.randomUUID())
    if (session.coinEvents.some((event) => event.eventId === id)) {
      return sessionView(session)
    }
    session.coinEvents.push({ eventId: id, denominationMinor, source, at: new Date().toISOString() })
    session.coinsInsertedMinor += denominationMinor
    return sessionView(session)
  }

  return {
    async machine() {
      return publicMachine(state.machine)
    },
    async adminView() {
      return {
        ...publicMachine(state.machine),
        coinKey: state.machine.coinKey,
        hardware: {
          coinsPath: '/api/kiosk/hardware/coins',
          statusPath: '/api/kiosk/hardware/status',
          header: 'X-Kiosk-Coin-Key',
          denominationsMinor: [...COIN_VALUES],
        },
      }
    },
    async updateMachine(patch) {
      return enqueue(async () => {
        const machine = state.machine
        if (typeof patch.name === 'string' && patch.name.trim()) machine.name = patch.name.trim().slice(0, 80)
        if (typeof patch.publicBaseUrl === 'string') machine.publicBaseUrl = patch.publicBaseUrl.trim().replace(/\/$/, '').slice(0, 200)
        if (typeof patch.paymentQrTemplate === 'string' && patch.paymentQrTemplate.trim()) {
          machine.paymentQrTemplate = patch.paymentQrTemplate.trim().slice(0, 500)
        }
        if (typeof patch.paymentQrEnabled === 'boolean') machine.paymentQrEnabled = patch.paymentQrEnabled
        if (Number.isFinite(Number(patch.lat)) && Number.isFinite(Number(patch.lng))) {
          const lat = Number(patch.lat)
          const lng = Number(patch.lng)
          if (lat >= -90 && lat <= 90 && lng >= -180 && lng <= 180) {
            machine.lat = lat
            machine.lng = lng
          }
        }
        if (Number.isFinite(Number(patch.priceBwMinor))) machine.priceBwMinor = Math.max(0, Math.round(Number(patch.priceBwMinor)))
        if (Number.isFinite(Number(patch.priceColorMinor))) machine.priceColorMinor = Math.max(0, Math.round(Number(patch.priceColorMinor)))
        if (Number.isFinite(Number(patch.paperCount))) machine.paperCount = clampPaper(Number(patch.paperCount))
        if (typeof patch.printerStatus === 'string' && PRINTER_STATUSES.has(patch.printerStatus)) {
          machine.printerStatus = patch.printerStatus
        }
        if (machine.paperCount === 0 && machine.printerStatus === 'online') machine.printerStatus = 'out_of_paper'
        if (patch.rotateCoinKey === true) machine.coinKey = crypto.randomBytes(18).toString('hex')
        machine.updatedAt = new Date().toISOString()
        await persist()
        return publicMachine(machine)
      })
    },
    async adjust(patch) {
      return enqueue(async () => {
        const machine = state.machine
        if (Number.isFinite(Number(patch.paperDelta))) {
          machine.paperCount = clampPaper(machine.paperCount + Number(patch.paperDelta))
          if (machine.paperCount === 0) machine.printerStatus = 'out_of_paper'
          else if (machine.printerStatus === 'out_of_paper') machine.printerStatus = 'online'
        }
        if (typeof patch.printerStatus === 'string' && PRINTER_STATUSES.has(patch.printerStatus)) {
          machine.printerStatus = patch.printerStatus === 'online' && machine.paperCount === 0
            ? 'out_of_paper'
            : patch.printerStatus
        }
        machine.updatedAt = new Date().toISOString()
        await persist()
        return publicMachine(machine)
      })
    },
    async openSession(requestedId) {
      return enqueue(async () => {
        sweep()
        const id = /^[A-Za-z0-9_-]{4,40}$/.test(String(requestedId || ''))
          ? String(requestedId)
          : crypto.randomBytes(6).toString('hex')
        if (!state.sessions[id]) {
          state.sessions[id] = {
            id,
            status: 'waiting',
            document: null,
            filePath: null,
            revision: 0,
            coinsInsertedMinor: 0,
            coinEvents: [],
            pay: null,
            createdAt: new Date().toISOString(),
          }
          await persist()
        }
        return sessionView(state.sessions[id])
      })
    },
    async readSession(id) {
      return sessionView(requireSession(id))
    },
    async saveUpload(id, file) {
      return enqueue(async () => {
        const session = requireSession(id)
        if (session.document) {
          fail(409, 'session_closed', 'This upload session is already closed. Scan the kiosk QR again.')
        }
        const accepted = validatePrintFile(file)
        const stored = path.join(filesDir, `${id}-${Date.now()}`)
        await fs.promises.writeFile(stored, accepted.bytes)
        if (session.filePath) fs.rmSync(session.filePath, { force: true })
        session.filePath = stored
        session.status = 'ready'
        session.revision = (session.revision || 0) + 1
        session.document = {
          fileName: accepted.filename,
          fileSize: fileSizeLabel(accepted.bytes.length),
          pageCount: pageCountFor(accepted.mime, accepted.bytes),
          mime: accepted.mime,
        }
        await persist()
        return sessionView(session)
      })
    },
    async clearUpload(id) {
      return enqueue(async () => {
        const session = requireSession(id)
        if (session.filePath) fs.rmSync(session.filePath, { force: true })
        session.filePath = null
        session.document = null
        session.status = 'waiting'
        session.revision = (session.revision || 0) + 1
        await persist()
        return sessionView(session)
      })
    },
    async readFile(id) {
      const session = requireSession(id)
      if (!session.filePath) fail(404, 'file_missing', 'The kiosk does not have this file yet.')
      const filename = session.document?.fileName || 'document'
      const mime = session.document?.mime || 'application/octet-stream'
      return {
        mime,
        filename,
        inline: mime === 'application/pdf' || mime.startsWith('image/'),
        bytes: await fs.promises.readFile(session.filePath),
      }
    },
    async markSample(id) {
      return enqueue(async () => {
        const session = requireSession(id)
        session.status = 'ready'
        session.document = { fileName: 'Thesis_Chapter1.pdf', fileSize: '1.8 MB', pageCount: 24 }
        await persist()
        return sessionView(session)
      })
    },
    async setPay(id, patch) {
      return enqueue(async () => {
        const session = requireSession(id)
        const active = patch.active !== false
        for (const other of Object.values(state.sessions)) {
          if (other.id !== id && other.pay) other.pay = { ...other.pay, active: false }
        }
        session.pay = {
          active,
          totalMinor: Math.max(0, Math.round(Number(patch.totalMinor) || 0)),
          orderCode: String(patch.orderCode || session.pay?.orderCode || '').slice(0, 40),
        }
        await persist()
        return sessionView(session)
      })
    },
    async insertScreenCoin(id, body) {
      return enqueue(async () => {
        const session = requireSession(id)
        if (!session.pay?.active) fail(409, 'payment_not_active', 'Open the pay screen before inserting coins.')
        const view = addCoin(session, Math.round(Number(body.denominationMinor)), body.eventId, 'screen')
        await persist()
        return view
      })
    },
    async insertHardwareCoin(body, coinKey) {
      return enqueue(async () => {
        if (!coinKey || coinKey !== state.machine.coinKey) {
          fail(401, 'invalid_coin_key', 'The coin key does not match this kiosk.')
        }
        const session = activePaySession()
        if (!session) fail(409, 'payment_not_active', 'The kiosk is not waiting for coins.')
        const view = addCoin(session, Math.round(Number(body.denominationMinor)), body.eventId, 'hardware')
        await persist()
        return view
      })
    },
    async hardwareStatus() {
      const session = activePaySession()
      if (!session?.pay?.active) {
        return { accepting: false, sessionId: null, amountDueMinor: 0, insertedMinor: 0, remainingMinor: 0 }
      }
      const due = session.pay.totalMinor
      const inserted = session.coinsInsertedMinor
      return {
        accepting: inserted < due,
        sessionId: session.id,
        orderCode: session.pay.orderCode,
        amountDueMinor: due,
        insertedMinor: inserted,
        remainingMinor: Math.max(0, due - inserted),
      }
    },
  }
}

let singleton = null

export function kioskStore() {
  if (!singleton) {
    const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'data')
    singleton = createKioskStore({ root })
  }
  return singleton
}

function sessionIdFrom(pathname) {
  return /^\/kiosk\/sessions\/([^/]+)/.exec(kioskPathname(pathname))?.[1] || ''
}

export async function routePublicKiosk({ req, url }) {
  const method = req.method
  const pathname = kioskPathname(url.pathname)
  if (!isPublicKioskPath(url.pathname)) return null
  const store = kioskStore()

  if (method === 'GET' && pathname === '/kiosk/machine') {
    return { status: 200, body: { ok: true, machine: await store.machine() } }
  }
  if (method === 'POST' && pathname === '/kiosk/machine/adjust') {
    return { status: 200, body: { ok: true, machine: await store.adjust(jsonBody(req)) } }
  }
  if (method === 'GET' && pathname === '/kiosk/hardware/status') {
    return { status: 200, body: { ok: true, ...(await store.hardwareStatus()) } }
  }
  if (method === 'POST' && pathname === '/kiosk/hardware/coins') {
    const key = req.headers['x-kiosk-coin-key']
    return { status: 200, body: { ok: true, session: await store.insertHardwareCoin(jsonBody(req), key) } }
  }
  if (method === 'POST' && pathname === '/kiosk/sessions') {
    return { status: 201, body: { ok: true, session: await store.openSession(jsonBody(req).sessionId) } }
  }

  const id = sessionIdFrom(url.pathname)
  if (!id) return null
  if (method === 'GET' && pathname === `/kiosk/sessions/${id}`) {
    return { status: 200, body: { ok: true, session: await store.readSession(id) } }
  }
  if (method === 'GET' && pathname === `/kiosk/sessions/${id}/file`) {
    const file = await store.readFile(id)
    return { status: 200, file }
  }
  if (method === 'POST' && pathname === `/kiosk/sessions/${id}/clear`) {
    return { status: 200, body: { ok: true, session: await store.clearUpload(id) } }
  }
  if (method === 'POST' && pathname === `/kiosk/sessions/${id}/file`) {
    const raw = await readRaw(req, MAX_FILE_BYTES)
    const file = parseMultipartFile(raw, req.headers['content-type'])
    return { status: 201, body: { ok: true, session: await store.saveUpload(id, file) } }
  }
  if (method === 'POST' && pathname === `/kiosk/sessions/${id}/sample`) {
    return { status: 200, body: { ok: true, session: await store.markSample(id) } }
  }
  if (method === 'POST' && pathname === `/kiosk/sessions/${id}/pay`) {
    return { status: 200, body: { ok: true, session: await store.setPay(id, jsonBody(req)) } }
  }
  if (method === 'POST' && pathname === `/kiosk/sessions/${id}/coins`) {
    return { status: 200, body: { ok: true, session: await store.insertScreenCoin(id, jsonBody(req)) } }
  }
  return null
}

export async function routeAdminKiosk({ req, url, user }) {
  if (!isAdminKioskPath(url.pathname)) return null
  if (!user) fail(401, 'unauthorized', 'Sign in as Super Admin to change the kiosk.')
  const allowed = user.role === 'super_admin' || identityHasMembership(user, 'super_admin')
  if (!allowed) fail(403, 'forbidden', 'Only Super Admin can change the kiosk.')
  const store = kioskStore()
  if (req.method === 'GET') {
    return { status: 200, body: { ok: true, machine: await store.adminView() } }
  }
  if (req.method === 'PATCH') {
    const machine = await store.updateMachine(jsonBody(req))
    const admin = await store.adminView()
    return { status: 200, body: { ok: true, machine: { ...admin, ...machine, coinKey: admin.coinKey, hardware: admin.hardware } } }
  }
  return null
}
