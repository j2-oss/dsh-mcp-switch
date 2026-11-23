/**
 * MCP tool switch.
 *
 * Every MCP server starts switched off: only the servers the user turns on
 * contribute tool definitions to a request, so ordinary requests carry just the
 * necessary tools. Turning one on restores its definitions for the next model
 * step; turning it off removes them again without touching the connection.
 *
 * Two callers share one operation:
 *  - the `mcp_switch` tool, so a conversational "turn off github" acts on it;
 *  - the Settings page contributed by `client.js`, which talks to the JSON
 *    routes registered here (`/mcp-switch/state`, `/mcp-switch/set`).
 *
 * State lives in `<harness home>/mcp-switch.json`; visibility is enforced with
 * `ctx.tools.restrict({ deny })` on each agent's context and re-applied
 * whenever the registered global tool set changes.
 *
 * The package deliberately imports no `@deepseek-ai/*` package: a linked local
 * bundle cannot resolve them, so the tool definition and the harness home
 * lookup are spelled out here.
 *
 * @module @local/dsh-mcp-switch
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

export const name = 'mcp-switch'
export const inject = ['tools', 'agents']

/** Model-facing tool name. */
const SWITCH_TOOL = 'mcp_switch'

/** MCP tool namespace: `mcp__<server>__<tool>`. */
const MCP_NAME = /^mcp__([A-Za-z0-9-]+)__(.+)$/

/** Persisted switch state path. */
const STATE_PATH = join(
  typeof process.env.DSH_HOME === 'string' && process.env.DSH_HOME.trim() !== ''
    ? process.env.DSH_HOME.trim()
    : join(homedir(), '.dsh'),
  'mcp-switch.json',
)

/** Read the enabled server set; a missing or malformed file means every server stays off. */
function readState() {
  try {
    const parsed = JSON.parse(readFileSync(STATE_PATH, 'utf8'))
    if (Array.isArray(parsed.enabled)) {
      return new Set(parsed.enabled.filter(value => typeof value === 'string' && value.length > 0))
    }
  } catch {}
  return new Set()
}

/** Persist the enabled server set. */
function writeState(enabled) {
  try {
    mkdirSync(dirname(STATE_PATH), { recursive: true })
    writeFileSync(STATE_PATH, `${JSON.stringify({ enabled: [...enabled].sort() }, null, 2)}\n`)
  } catch {}
}

/** Write one JSON response. */
function sendJson(res, status, value) {
  const body = JSON.stringify(value)
  res.statusCode = status
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.setHeader('cache-control', 'no-store')
  res.end(body)
}

/** Read and parse a bounded JSON request body. */
function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > 65536) {
        reject(new Error('request body too large'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      if (chunks.length === 0) {
        resolve({})
        return
      }
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')))
      } catch (error) {
        reject(error)
      }
    })
    req.on('error', reject)
  })
}

/** The registry-ready switch tool definition (raw JSON Schema, no defineTool). */
const SWITCH_DEFINITION = {
  name: SWITCH_TOOL,
  description: 'Turn one MCP server on or off for every agent. Every MCP server starts off, so ordinary requests '
    + 'carry only the tools that were explicitly turned on. While a server is off its tool definitions are left out '
    + 'of the request entirely and cost no tokens; its connection is untouched, so turning it on is immediate. '
    + 'Call this whenever the user asks to switch an MCP server or its tools on or off, and use `list` when the '
    + 'user asks which servers are on or what is currently costing tokens.',
  parameters: {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        enum: ['list', 'enable', 'disable'],
        description: 'list reports servers and their switch state; enable and disable change one server.',
      },
      server: {
        type: 'string',
        description: 'MCP server key exactly as `list` reports it, such as "github" or "io-draw-mcp". Required for enable and disable.',
      },
    },
    required: ['action'],
    additionalProperties: false,
  },
  output: {
    schema: {
      type: 'object',
      properties: {
        servers: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              server: { type: 'string' },
              tools: { type: 'integer' },
              enabled: { type: 'boolean' },
            },
            required: ['server', 'tools', 'enabled'],
            additionalProperties: false,
          },
        },
        enabled: { type: 'array', items: { type: 'string' } },
      },
      required: ['servers', 'enabled'],
      additionalProperties: false,
    },
    render: (_args, value) => [{
      type: 'text',
      text: value.servers.length === 0
        ? 'No MCP servers are registered.'
        : `MCP servers: ${value.servers
          .map(entry => `${entry.server} (${entry.enabled ? 'on' : 'off'}, ${entry.tools} tools)`)
          .join('; ')}`,
    }],
  },
}

/**
 * Register the switch tool, the Settings JSON routes, and keep every agent's
 * restrictions in sync with the switch state.
 * @param ctx - host context carrying the tool registry and agent registry.
 */
export function apply(ctx) {
  const enabled = readState()
  /** Per-agent applied restriction: the denied names and the effect that lifts it. */
  const agents = new Map()
  /** Reentrancy guard: restricting fires `tools/change`, which must not reconcile mid-update. */
  let syncing = false

  /** `server` segment of an MCP tool name, or undefined for a non-MCP tool. */
  const serverOf = (toolName) => {
    const match = MCP_NAME.exec(toolName)
    return match === null ? undefined : match[1]
  }

  /** Every registered MCP server with its tool count, read from the global view. */
  const inventory = () => {
    const servers = new Map()
    for (const schema of ctx.tools.schemas()) {
      const server = serverOf(schema.name)
      if (server === undefined) continue
      if (!servers.has(server)) servers.set(server, 0)
      servers.set(server, servers.get(server) + 1)
    }
    return servers
  }

  /** Names no switched-on server contributes to the current global tool set. */
  const desiredDeny = () => {
    const deny = new Set()
    for (const schema of ctx.tools.schemas()) {
      const server = serverOf(schema.name)
      if (server !== undefined && !enabled.has(server)) deny.add(schema.name)
    }
    return deny
  }

  const sameNames = (left, right) => left.size === right.size && [...left].every(name => right.has(name))

  /** Reconcile one agent's restriction with the switch state. */
  const applyAgent = (agent) => {
    const deny = desiredDeny()
    let record = agents.get(agent)
    if (record !== undefined && record.applied === true && sameNames(record.names, deny)) return
    record?.dispose?.()
    let names = new Set()
    let dispose
    if (deny.size > 0) {
      try {
        dispose = agent.ctx.tools.restrict({ deny: [...deny] })
        names = deny
      } catch (error) {
        ctx.logger.warn(`mcp-switch: cannot hide MCP tools this step: ${String(error)}`)
      }
    }
    record = { names, dispose, applied: true }
    agents.set(agent, record)
  }

  const applyAll = () => {
    if (syncing) return
    syncing = true
    try {
      for (const agent of ctx.agents.list()) applyAgent(agent)
    } finally {
      syncing = false
    }
  }

  ctx.on('agent/created', ({ agent }) => {
    agent.ctx.effect(() => {
      if (!syncing) {
        syncing = true
        try {
          applyAgent(agent)
        } finally {
          syncing = false
        }
      }
      return () => {
        agents.get(agent)?.dispose?.()
        agents.delete(agent)
      }
    }, 'mcp-switch')
  })

  ctx.on('tools/change', () => { applyAll() })
  ctx.effect(() => () => {
    for (const record of agents.values()) record.dispose?.()
    agents.clear()
  }, 'mcp-switch teardown')

  applyAll()

  /** Report the switch state. */
  const describeState = () => {
    const servers = inventory()
    return {
      servers: [...servers.entries()]
        .map(([server, tools]) => ({ server, tools, enabled: enabled.has(server) }))
        .sort((left, right) => left.server.localeCompare(right.server)),
      enabled: [...enabled].sort(),
    }
  }

  const definition = {
    ...SWITCH_DEFINITION,
    async execute(args) {
      if (args === null || typeof args !== 'object') throw new Error('arguments must be an object')
      const action = args.action
      if (action !== 'list' && action !== 'enable' && action !== 'disable') {
        throw new Error('action must be "list", "enable" or "disable"')
      }
      if (action === 'list') return describeState()
      const server = typeof args.server === 'string' ? args.server.trim() : ''
      if (server === '') throw new Error('server is required for enable and disable')
      const servers = inventory()
      if (!servers.has(server)) {
        const known = [...servers.keys()].sort().join(', ')
        throw new Error(`unknown MCP server "${server}"; registered servers: ${known === '' ? '(none)' : known}`)
      }
      if (action === 'disable') enabled.delete(server)
      else enabled.add(server)
      writeState(enabled)
      applyAll()
      return describeState()
    },
  }

  ctx.tools.register(definition)

  // Settings page transport: the client renders the switches and calls these.
  ctx.inject(['webServer'], (webCtx) => {
    webCtx.effect(() => {
      const disposers = [
        webCtx.webServer.register({
          kind: 'exact',
          path: '/mcp-switch/state',
          handler: (req, res) => {
            if (req.method !== 'GET' && req.method !== 'HEAD') {
              sendJson(res, 405, { error: 'use GET' })
              return
            }
            sendJson(res, 200, describeState())
          },
        }),
        webCtx.webServer.register({
          kind: 'exact',
          path: '/mcp-switch/set',
          handler: async (req, res) => {
            if (req.method !== 'POST') {
              sendJson(res, 405, { error: 'use POST' })
              return
            }
            let body
            try {
              body = await readJsonBody(req)
            } catch (error) {
              sendJson(res, 400, { error: `invalid body: ${String(error)}` })
              return
            }
            const server = typeof body.server === 'string' ? body.server.trim() : ''
            if (server === '' || typeof body.enabled !== 'boolean') {
              sendJson(res, 400, { error: 'expected { server: string, enabled: boolean }' })
              return
            }
            if (!inventory().has(server)) {
              sendJson(res, 404, { error: `unknown MCP server "${server}"` })
              return
            }
            if (body.enabled) enabled.add(server)
            else enabled.delete(server)
            writeState(enabled)
            applyAll()
            sendJson(res, 200, describeState())
          },
        }),
      ]
      return () => { for (const dispose of disposers) dispose() }
    }, 'mcp-switch routes')
  })
}
