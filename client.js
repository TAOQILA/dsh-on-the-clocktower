/* DSH on the Clocktower - 左侧栏粗体「染」按钮 client-plugin
 * 面板只保留一个按钮：在系统浏览器中打开魔典。
 * 魔典服务由宿主端 index.js 在 DSH 进程内启动于 127.0.0.1:6325，
 * 并注入 ctx.llm + 模型清单（用你已配置的模型）。
 */
window.__ModuleLoader__.load({
  id: 'dsh-on-the-clocktower',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    // 魔典服务由宿主在 DSH 进程内启动于该地址；浏览器直接打开，绕开面板 CSP 限制。
    var BASE = 'http://127.0.0.1:6325/'

    function RanIcon(props) {
      return h('span', {
        style: {
          display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
          width: 22, height: 22, borderRadius: 6,
          background: 'linear-gradient(145deg,#8b0f17,#4a080d)',
          color: '#fff', fontWeight: 900, fontSize: 15,
          fontFamily: '"Microsoft YaHei",sans-serif',
          border: '1px solid #c9a227', cursor: 'pointer',
          opacity: props && props.disabled ? 0.5 : 1,
        },
        title: '血染钟鱼',
      }, '染')
    }

    function BotcPanel() {
      const open = function () {
        try { window.open(BASE, '_blank', 'noopener,noreferrer') }
        catch (e) { window.location.href = BASE }
      }
      return h('div', {
        style: {
          height: '100%', display: 'flex', flexDirection: 'column',
          alignItems: 'center', justifyContent: 'center', gap: 14,
          padding: 16, textAlign: 'center', boxSizing: 'border-box',
        },
      },
        h('div', { style: { fontSize: 52, lineHeight: 1, fontWeight: 900,
          background: 'linear-gradient(145deg,#8b0f17,#4a080d)', color: '#fff',
          width: 84, height: 84, borderRadius: 16, display: 'flex',
          alignItems: 'center', justifyContent: 'center', border: '1px solid #c9a227' } }, '染'),
        h('div', { style: { fontWeight: 900, fontSize: 18 } }, '血染钟鱼 · 魔典'),
        h('button', {
          onClick: open,
          style: {
            marginTop: 6, padding: '12px 26px', fontSize: 15, fontWeight: 700,
            cursor: 'pointer', border: '1px solid #c9a227', borderRadius: 8,
            background: 'linear-gradient(145deg,#8b0f17,#4a080d)', color: '#fff',
          },
        }, '在浏览器中打开魔典'),
        h('div', { style: { marginTop: 10, fontSize: 12, opacity: 0.65, wordBreak: 'break-all' } }, BASE),
        h('div', { style: { marginTop: 2, fontSize: 12, opacity: 0.5 } }, '若未自动弹出，请复制上方地址到浏览器打开'),
      )
    }

    const inject = ['slots']
    function apply(ctx) {
      ctx.slots.inject('main', () =>
        ctx.slots.register({ name: 'main', key: 'dsh-on-the-clocktower' }, BotcPanel),
      )
      ctx.slots.inject('sidebar.panellist', () =>
        ctx.slots.register(
          { name: 'sidebar.panellist', id: 'dsh-on-the-clocktower', order: 42, label: () => '血染钟鱼' },
          (props) => h(RanIcon, props || {}),
        ),
      )
    }
    return { inject, apply }
  },
})
