// Hermes Desktop half: the pairing code for the Clanker phone app, under Settings → Plugins.
// Plain ESM with jsx() calls, as Hermes loads it uncompiled. Data comes from this plugin's own
// backend route (dashboard/plugin_api.py), which only Hermes's signed-in owner can read.
import { Button, CopyButton } from '@hermes/plugin-sdk'
import { useCallback, useEffect, useState } from 'react'
import { jsx, jsxs } from 'react/jsx-runtime'

const muted = { margin: 0, fontSize: 13, lineHeight: 1.5, color: 'var(--ui-text-tertiary)' }
const label = { fontSize: 13, fontWeight: 500, color: 'var(--ui-text-secondary)', marginBottom: 6 }
const row = { display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }
const value = {
  flex: 1,
  minWidth: 0,
  padding: '6px 10px',
  border: '1px solid var(--ui-stroke-secondary)',
  borderRadius: 8,
  fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
  fontSize: 13,
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap'
}

// What each bridge state says when there's no code to show.
const NOTES = {
  'not-started': 'The bridge starts with the Hermes gateway.',
  starting: 'The bridge is starting…',
  'port-busy': 'Waiting for the bridge’s port.',
  failed: 'The bridge isn’t running.',
  stopped: 'The bridge isn’t running.'
}

function Field({ title, text, children }) {
  return jsxs('div', {
    children: [
      jsx('div', { style: label, children: title }),
      jsxs('div', { style: row, children: [jsx('div', { style: value, title: text, children: text }), children] })
    ]
  })
}

function PairingPage({ ctx }) {
  const [result, setResult] = useState({ loading: true })
  const [showToken, setShowToken] = useState(false)

  const load = useCallback(() => {
    setResult(current => ({ ...current, loading: true }))
    ctx.rest('/pairing').then(
      data => setResult({ data }),
      error => setResult({ error: error instanceof Error ? error.message : String(error) })
    )
  }, [ctx])

  useEffect(load, [load])
  // Until it's running, check again every few seconds so the page catches up on its own.
  const waiting = !result.error && result.data && result.data.state !== 'running'
  useEffect(() => {
    if (!waiting) return undefined
    const timer = setInterval(load, 4000)
    return () => clearInterval(timer)
  }, [waiting, load])

  const { data, error, loading } = result
  const header = jsxs('div', {
    style: { ...row, justifyContent: 'space-between' },
    children: [
      jsx('h3', { style: { margin: 0, fontSize: 15, fontWeight: 600 }, children: 'Pair Clanker' }),
      jsx(Button, { size: 'sm', variant: 'outline', disabled: loading, onClick: load, children: 'Refresh' })
    ]
  })
  const page = children => jsxs('div', { style: { display: 'flex', flexDirection: 'column', gap: 16, maxWidth: 560 }, children: [header, ...children] })

  if (error) {
    return page([
      jsx('p', { style: muted, children: `Couldn’t load the pairing code: ${error}` }),
      jsx('p', { style: muted, children: 'Make sure this plugin is enabled for this profile, then restart the gateway.' })
    ])
  }
  if (!data) return page([jsx('p', { style: muted, children: 'Loading…' })])
  if (data.state !== 'running') {
    return page([
      jsx('p', { style: muted, children: NOTES[data.state] ?? `Bridge state: ${data.state}` }),
      data.error ? jsx('p', { style: muted, children: data.error }) : null,
      data.log ? jsx('p', { style: { ...muted, wordBreak: 'break-all' }, children: `Log: ${data.log}` }) : null
    ])
  }

  return page([
    data.qr
      ? jsx('p', {
          style: muted,
          children:
            'In Clanker, open Settings → Backends and add a backend, or open this one to reconnect. Tap Scan QR code, scan this code, then Save.'
        })
      : jsx('p', {
          style: muted,
          children: data.loopbackOnly
            ? 'The bridge only accepts connections from this PC. Set its listen address to 0.0.0.0 in this plugin’s settings to reach it from your phone.'
            : 'No LAN address was found. Connect this PC to your network, then refresh.'
        }),
    // The SVG comes from the bridge's own QR encoder, never from input. It carries a white
    // background of its own, so it scans in dark themes too.
    data.qr
      ? jsx('div', {
          role: 'img',
          'aria-label': 'Clanker pairing QR code',
          style: { width: 220, height: 220, borderRadius: 12, overflow: 'hidden' },
          dangerouslySetInnerHTML: { __html: data.qr }
        })
      : null,
    data.addresses?.length
      ? jsxs('div', {
          style: { display: 'flex', flexDirection: 'column', gap: 8 },
          children: [
            jsx('div', { style: { ...label, marginBottom: 0 }, children: 'Addresses' }),
            ...data.addresses.map(address =>
              jsxs('div', {
                key: address.url,
                style: row,
                children: [
                  jsx('div', { style: value, title: address.name, children: `${address.url}  ·  ${address.name}` }),
                  jsx(CopyButton, { text: address.url, showLabel: true })
                ]
              })
            )
          ]
        })
      : null,
    jsxs(Field, {
      title: 'Bridge token',
      text: showToken ? data.token : '•'.repeat(24),
      children: [
        jsx(Button, { size: 'sm', variant: 'outline', onClick: () => setShowToken(!showToken), children: showToken ? 'Hide' : 'Show' }),
        jsx(CopyButton, { text: data.token, showLabel: true })
      ]
    }),
    jsx('p', { style: muted, children: 'Keep this code private: like the token, it gives access to this Hermes agent.' }),
    data.file ? jsx('p', { style: { ...muted, wordBreak: 'break-all' }, children: `Also saved as ${data.file}` }) : null
  ])
}

export default {
  id: 'hermes-clanker-bridge',
  name: 'Clanker bridge',
  register(ctx) {
    ctx.registerSettingsPage?.({
      id: 'pairing',
      title: 'Clanker bridge',
      icon: 'device-mobile',
      render: () => jsx(PairingPage, { ctx })
    })
  }
}
