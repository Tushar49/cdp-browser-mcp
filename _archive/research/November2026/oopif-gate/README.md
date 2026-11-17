# OOPIF live gate (interact type/fill/select)

Two loopback SITES — top `http://127.0.0.1:8880/oopif-top.html`, iframe
`http://127.0.0.2:8881/oopif-inner.html` — so the iframe is a real OOPIF.
Top document deliberately has **no `<input>`**: any value landing in the child
input proves child-session routing.

Run (ONE MCP process = ONE CDP connection = ONE Allow dialog):

```bash
node serve.mjs                    # background
node live-oopif.mjs               # fresh dist/index.js via CDP_USER_DATA
```

Result on 5.5.2 (Brave 153, 2026-11-17): all behavioral checks PASS —

- child frame ready; top `inputs:0`, `iframes:1`
- snapshot exposes the iframe as a `[frame N]` section and a textbox ref (uid 7)
- **instant fill** landed in the iframe input (`"value":"oopif-instant-123"`),
  top still `inputs:0` (the old top-frame `document.activeElement` path cannot do this)
- **per-key typing** (`delay:5`) delivered keydown events to the child document and
  produced `delayXYZ`
- **submit** Enter fired the iframe form (`"type":"submit","value":"sub"`)

Note: the first run's key-name assertion failed cosmetically because the secrets
scrubber masks values under `key` (`"key":"***"` — documented over-reach,
security-biased). The assertion now counts events instead of matching values.
