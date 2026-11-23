window.__ModuleLoader__.load({
  id: '@local/dsh-mcp-switch',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    const line = { borderTop: '1px solid var(--dsw-alias-line, rgba(128,128,128,.28))' }

    function useSwitchState() {
      const [state, setState] = React.useState({ status: 'loading' })
      const load = React.useCallback(async () => {
        try {
          const response = await fetch('/mcp-switch/state', { headers: { accept: 'application/json' } })
          if (!response.ok) throw new Error(`HTTP ${response.status}`)
          setState({ status: 'ready', data: await response.json() })
        } catch (error) {
          setState({ status: 'error', message: String(error) })
        }
      }, [])
      React.useEffect(() => { void load() }, [load])
      return [state, setState, load]
    }

    function sendToggle(server, enabled) {
      return fetch('/mcp-switch/set', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ server, enabled }),
      }).then(async (response) => {
        const body = await response.json().catch(() => ({}))
        if (!response.ok) throw new Error(body.error || `HTTP ${response.status}`)
        return body
      })
    }

    function Switch(props) {
      const { checked, busy, onToggle, label } = props
      return h('button', {
        type: 'button',
        role: 'switch',
        'aria-checked': checked,
        'aria-label': label,
        disabled: busy,
        onClick: onToggle,
        style: {
          flex: '0 0 auto', width: 40, height: 22, padding: 0, borderRadius: 999,
          border: 'none', cursor: busy ? 'progress' : 'pointer', position: 'relative',
          background: checked ? 'var(--dsw-alias-accent, #2f6fed)' : 'rgba(128,128,128,.35)',
          opacity: busy ? 0.6 : 1, transition: 'background .15s ease',
        },
      }, h('span', {
        'aria-hidden': true,
        style: {
          position: 'absolute', top: 2, left: checked ? 20 : 2, width: 18, height: 18,
          borderRadius: '50%', background: '#fff', transition: 'left .15s ease',
          boxShadow: '0 1px 2px rgba(0,0,0,.3)',
        },
      }))
    }

    function Section() {
      const [state, setState, load] = useSwitchState()
      const [busy, setBusy] = React.useState('')

      const apply = React.useCallback(async (server, enabled) => {
        setBusy(server)
        try {
          setState({ status: 'ready', data: await sendToggle(server, enabled) })
        } catch (error) {
          setState({ status: 'error', message: String(error) })
        } finally {
          setBusy('')
        }
      }, [setState])

      const applyAll = React.useCallback(async (enabled) => {
        setBusy(enabled ? 'all-on' : 'all-off')
        try {
          const current = state.status === 'ready' ? state.data.servers : []
          for (const entry of current) await sendToggle(entry.server, enabled)
          await load()
        } catch (error) {
          setState({ status: 'error', message: String(error) })
        } finally {
          setBusy('')
        }
      }, [state, setState, load])

      if (state.status === 'loading') {
        return h('div', { style: { padding: '8px 0', opacity: 0.7 } }, '正在读取 MCP 服务…')
      }
      if (state.status === 'error') {
        return h('div', { style: { padding: '8px 0' } },
          h('div', { style: { color: 'var(--dsw-alias-danger, #d64545)' } }, `读取失败：${state.message}`),
          h('button', {
            type: 'button', onClick: () => { void load() },
            style: { marginTop: 8, cursor: 'pointer' },
          }, '重试'))
      }

      const servers = state.data.servers || []
      const onCount = servers.filter(entry => entry.enabled).length
      const toolCount = servers.filter(entry => entry.enabled).reduce((sum, entry) => sum + entry.tools, 0)
      return h('div', { style: { display: 'flex', flexDirection: 'column', gap: 4 } },
        h('p', { style: { margin: '0 0 8px', opacity: 0.75, lineHeight: 1.6 } },
          '默认全部关闭：只有打开的服务才会把工具说明发给模型。关掉的服务不消耗 token，连接保留，重新打开立即可用。'),
        h('p', { style: { margin: '0 0 8px', opacity: 0.9, fontSize: 12 } },
          `已开启 ${onCount} / ${servers.length} 个服务，本轮发送 ${toolCount} 个 MCP 工具`),
        h('div', { style: { display: 'flex', gap: 8, marginBottom: 8 } },
          h('button', {
            type: 'button', disabled: busy !== '', onClick: () => { void applyAll(true) },
            style: { cursor: 'pointer' },
          }, '全部开启'),
          h('button', {
            type: 'button', disabled: busy !== '' || onCount === 0, onClick: () => { void applyAll(false) },
            style: { cursor: 'pointer' },
          }, '全部关闭')),
        servers.length === 0
          ? h('p', { style: { opacity: 0.7 } }, '当前没有注册任何 MCP 服务。')
          : servers.map(entry => h('div', {
            key: entry.server,
            style: { ...line, display: 'flex', alignItems: 'center', gap: 12, padding: '10px 0' },
          },
          h('div', { style: { flex: '1 1 auto', minWidth: 0 } },
            h('div', { style: { fontWeight: 600, wordBreak: 'break-all' } }, entry.server),
            h('div', { style: { opacity: 0.65, fontSize: 12, marginTop: 2 } },
              `${entry.tools} 个工具 · ${entry.enabled ? '已开启' : '已关闭'}`)),
          h(Switch, {
            checked: entry.enabled,
            busy: busy === entry.server || busy === 'all-on' || busy === 'all-off',
            label: `${entry.enabled ? '关闭' : '开启'} ${entry.server}`,
            onToggle: () => { void apply(entry.server, !entry.enabled) },
          }))))
    }

    function Icon(props) {
      const size = props && props.size ? props.size : 16
      const active = !!(props && props.active)
      return h('svg', {
        viewBox: '0 0 24 24', width: size, height: size, 'aria-hidden': true,
        style: { display: 'block', opacity: active ? 1 : 0.75 },
      },
      h('rect', { x: 2, y: 7, width: 20, height: 10, rx: 5, fill: 'none', stroke: 'currentColor', strokeWidth: 1.8 }),
      h('circle', { cx: 16, cy: 12, r: 3.2, fill: 'currentColor' }))
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        ctx.slots.inject('settings.section', () => ctx.slots.register({
          name: 'settings.section',
          id: 'mcp-switch',
          order: 42,
          label: () => 'MCP 工具开关',
        }, Section))
        ctx.slots.inject('settings.section.icon', () => ctx.slots.register({
          name: 'settings.section.icon',
          id: 'mcp-switch',
          order: 42,
          label: () => 'MCP 工具开关',
        }, Icon))
      },
    }
  },
})
