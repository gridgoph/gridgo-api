import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import zlib from 'node:zlib'
import { createKioskStore, paymentQrValue } from './kiosk-machine.js'

function pdfWithPages(count) {
  const hidden = zlib.deflateSync(
    Buffer.from(`<</Type /Pages /Count ${count} /MediaBox [0 0 595.276 841.89]>>`, 'latin1'),
  )
  const body = Buffer.concat([
    Buffer.from('%PDF-1.7\n4 0 obj<</Filter/FlateDecode/Length 99>>stream\n', 'latin1'),
    hidden,
    Buffer.from('\nendstream endobj\ntrailer<<>>\n%%EOF', 'latin1'),
  ])
  const bytes = Buffer.alloc(90_000)
  body.copy(bytes)
  return bytes
}

function tempStore() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gridgo-kiosk-'))
  return createKioskStore({ root })
}

test('payment QR fills the amount, order, and session', () => {
  const value = paymentQrValue('pay:{amount}:{order}:{session}', {
    amountMinor: 7200,
    orderCode: 'K-349864',
    sessionId: 'ABC',
  })
  assert.equal(value, 'pay:72.00:K-349864:ABC')
})

test('admin prices and tray are what the kiosk reads', async () => {
  const store = tempStore()
  await store.updateMachine({
    paperCount: 80,
    printerStatus: 'paper_jam',
    priceBwMinor: 300,
    priceColorMinor: 800,
    lat: 7.07,
    lng: 125.61,
  })
  const machine = await store.machine()
  assert.equal(machine.paperCount, 80)
  assert.equal(machine.printerStatus, 'paper_jam')
  assert.equal(machine.priceBwMinor, 300)
  assert.equal(machine.priceColorMinor, 800)
  assert.equal(machine.lat, 7.07)
  assert.equal(machine.paymentQrEnabled, true)
  const coinsOnly = await store.updateMachine({ paymentQrEnabled: false })
  assert.equal(coinsOnly.paymentQrEnabled, false)
  assert.equal((await store.machine()).paymentQrEnabled, false)
})

test('a phone upload is waiting on the session the kiosk polls', async () => {
  const store = tempStore()
  await store.openSession('SESSION1')
  const bytes = pdfWithPages(11)
  const saved = await store.saveUpload('SESSION1', {
    filename: '..\\..\\notes.pdf',
    mime: 'text/html',
    bytes,
  })
  assert.equal(saved.status, 'ready')
  assert.equal(saved.document.fileName, 'notes.pdf')
  assert.equal(saved.document.pageCount, 11)
  const polled = await store.readSession('SESSION1')
  assert.equal(polled.document.fileName, 'notes.pdf')
  assert.equal(polled.document.mime, 'application/pdf')
  const file = await store.readFile('SESSION1')
  assert.equal(file.mime, 'application/pdf')
  assert.equal(file.bytes.length, 90_000)
  assert.equal(file.inline, true)
})

test('a phone upload must be a real print file', async () => {
  const store = tempStore()
  await store.openSession('SESSION1')
  const html = Buffer.from('<html><script>alert(1)</script></html>')
  await assert.rejects(
    () => store.saveUpload('SESSION1', { filename: 'notes.pdf', mime: 'application/pdf', bytes: html }),
    (error) => error.code === 'file_type_rejected',
  )
  await assert.rejects(
    () => store.saveUpload('SESSION1', { filename: 'page.svg', mime: 'image/svg+xml', bytes: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>') }),
    (error) => error.code === 'file_type_rejected',
  )
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0])
  const saved = await store.saveUpload('SESSION1', { filename: 'photo.png', mime: 'text/html', bytes: png })
  assert.equal(saved.document.mime, 'image/png')
  assert.equal(saved.document.fileName, 'photo.png')
})

test('a received file closes the phone session until the kiosk removes it', async () => {
  const store = tempStore()
  await store.openSession('SESSION1')
  const bytes = Buffer.alloc(100)
  Buffer.from('%PDF-1.7\n').copy(bytes)
  const saved = await store.saveUpload('SESSION1', { filename: 'notes.pdf', mime: 'application/pdf', bytes })
  assert.equal(saved.revision, 1)
  await assert.rejects(
    () => store.saveUpload('SESSION1', { filename: 'notes.pdf', mime: 'application/pdf', bytes }),
    (error) => error.code === 'session_closed',
  )
  const cleared = await store.clearUpload('SESSION1')
  assert.equal(cleared.document, null)
  assert.equal(cleared.status, 'waiting')
  assert.equal(cleared.revision, 2)
  await assert.rejects(
    () => store.readFile('SESSION1'),
    (error) => error.code === 'file_missing',
  )
  const again = await store.saveUpload('SESSION1', { filename: 'notes.pdf', mime: 'application/pdf', bytes })
  assert.equal(again.document.fileName, 'notes.pdf')
  assert.equal(again.revision, 3)
})

test('hardware coins land on the active pay session once per event', async () => {
  const store = tempStore()
  await store.openSession('PAY1')
  await store.setPay('PAY1', { active: true, totalMinor: 2400, orderCode: 'K-1' })
  const admin = await store.adminView()
  const first = await store.insertHardwareCoin({ denominationMinor: 1000, eventId: 'coin-1' }, admin.coinKey)
  const repeat = await store.insertHardwareCoin({ denominationMinor: 1000, eventId: 'coin-1' }, admin.coinKey)
  assert.equal(first.coinsInsertedMinor, 1000)
  assert.equal(repeat.coinsInsertedMinor, 1000)
  const status = await store.hardwareStatus()
  assert.equal(status.accepting, true)
  assert.equal(status.remainingMinor, 1400)
})
