/*
 * DSH on the Clocktower（血染钟鱼）
 * Copyright (C) 2026 TAOQILA
 *
 * 本项目以 GNU Affero General Public License v3.0（AGPL-3.0-only）发布。
 * 完整条款见项目根目录的 LICENSE 文件，或 <https://www.gnu.org/licenses/agpl-3.0.txt>。
 *
 * This program is free software: you can redistribute it and/or modify it under the
 * terms of the GNU Affero General Public License as published by the Free Software
 * Foundation, version 3 of the License. There is NO WARRANTY, to the extent permitted
 * by law. See the LICENSE file for details.
 */
/**
 * DSH on the Clocktower — host half.
 *
 * 宿主激活时，经 webServer 把整套魔典 UI + API 挂到 DSH 同源路由
 * /dsh-on-the-clocktower/，并注入 ctx.llm + 模型清单，让每个 Agent / 说书人
 * 使用用户在 DSH 里已配置的模型。同源路由自动跟随宿主端口，无需记固定端口。
 * client 面板的「在浏览器中打开魔典」按钮即指向该同源地址。
 *
 * 若宿主不提供 webServer，退回在 RAN_PORT（默认 6325）独立启服务兜底。
 */
import { createRequire } from 'node:module'
import { randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import fs from 'node:fs'

export const inject = []

const MOUNT = '/dsh-on-the-clocktower'
const PORT = Number(process.env.RAN_PORT || 6325) // 仅兜底独立进程模式；主入口走同源路由
const MAX_TOKENS = 1200
const VERSION = '0.13.1'

const here = path.dirname(fileURLToPath(import.meta.url))
const require = createRequire(import.meta.url)

const LOG_FILE = path.join(process.env.USERPROFILE || process.env.HOME || '.', '.dsh', 'dsh-on-the-clocktower.log')
function fileLog(message) {
  const line = new Date().toISOString() + ' ' + message
  try { fs.appendFileSync(LOG_FILE, line + '\n') } catch { /* logging must never break activation */ }
  try { console.log('[dsh-on-the-clocktower] ' + message) } catch { /* ignore */ }
}

function serverEntry() {
  for (const name of ['server.cjs', 'server.js']) {
    const file = path.join(here, name)
    if (fs.existsSync(file)) return file
  }
  return null
}

function currentRoute(ctx) {
  try {
    const service = ctx && typeof ctx.get === 'function' ? ctx.get('agentDefaultModel') : null
    const selection = service && typeof service.currentSelection === 'function' ? service.currentSelection() : null
    if (selection && selection.provider && selection.model) {
      return { provider: selection.provider, model: selection.model }
    }
  } catch { /* no default-model service: let the adapter decide */ }
  return null
}

function userMessage(text) {
  return {
    id: randomUUID(),
    role: 'user',
    content: [{ type: 'text', text }],
    source: { kind: 'plugin', plugin: 'dsh-on-the-clocktower' },
  }
}

function makeLlmCall(ctx) {
  return async function llmCall(request) {
    const llm = ctx && typeof ctx.get === 'function' ? ctx.get('llm') : null
    if (!llm || typeof llm.stream !== 'function') {
      throw new Error('llm service is not mounted')
    }
    const explicit = request && request.provider && request.model
      ? { provider: String(request.provider), model: String(request.model) }
      : null
    const route = explicit || currentRoute(ctx)
    const options = {
      messages: [userMessage(String(request && request.prompt ? request.prompt : ''))],
      system: String((request && request.system) || ''),
      maxTokens: MAX_TOKENS,
      purpose: 'dsh-on-the-clocktower',
    }
    if (route) {
      options.provider = route.provider
      options.model = route.model
    }
    let text = ''
    let failure = null
    for await (const chunk of llm.stream(options)) {
      if (!chunk) continue
      if (chunk.type === 'text-delta' && typeof chunk.text === 'string') text += chunk.text
      else if (chunk.type === 'text' && typeof chunk.text === 'string') text += chunk.text
      else if (chunk.type === 'finish' && chunk.reason) {
        const kind = chunk.reason.kind
        if (kind === 'error') failure = (chunk.reason.failure && chunk.reason.failure.message) || 'llm error'
        else if (kind === 'aborted') failure = 'llm aborted'
      }
    }
    if (failure) throw new Error(failure)
    if (!text.trim()) throw new Error('model produced no text')
    return text
  }
}

/* llm.listProviders() 返回的是 { id, name } 对象数组（不是字符串数组），
   listModels 要走 registration(provider).adapter.listModels(provider) 才能取到清单。 */
function normalizeModelRows(listed) {
  if (!Array.isArray(listed)) return []
  const out = []
  for (const m of listed) {
    if (typeof m === 'string') { if (m) out.push({ id: m, name: m }); continue }
    if (!m || !m.id) continue
    out.push({ id: String(m.id), name: String(m.name || m.displayName || m.id) })
  }
  return out
}

async function modelsForProvider(llm, provider) {
  if (!provider) return []
  try {
    if (typeof llm.listModels === 'function') {
      const rows = normalizeModelRows(await llm.listModels(provider))
      if (rows.length > 0) return rows
    }
  } catch {}
  try {
    const reg = typeof llm.registration === 'function' ? llm.registration(provider) : null
    const adapter = reg && reg.adapter
    if (adapter && typeof adapter.listModels === 'function') {
      return normalizeModelRows(await adapter.listModels(provider))
    }
  } catch {}
  return []
}

function makeListModels(ctx) {
  return async function listModels() {
    const llm = ctx && typeof ctx.get === 'function' ? ctx.get('llm') : null
    if (!llm) return { providers: [], default: null }
    let raw = []
    try { raw = typeof llm.listProviders === 'function' ? llm.listProviders() : [] } catch { raw = [] }
    if (!Array.isArray(raw)) raw = []
    const seen = {}
    const providers = []
    for (const entry of raw) {
      const id = typeof entry === 'string' ? entry : String((entry && (entry.id || entry.provider)) || '')
      if (!id || seen[id]) continue
      seen[id] = true
      const name = typeof entry === 'object' && entry && entry.name ? String(entry.name) : id
      providers.push({ id: id, name: name, models: await modelsForProvider(llm, id) })
    }
    const def = currentRoute(ctx)
    return { providers: providers.filter((p) => p.models.length), default: def || null }
  }
}

export function apply(ctx) {
  try { return applyInner(ctx) } catch (err) { fileLog('apply 抛错：' + String((err && err.stack) || err)) } }

function applyInner(ctx) {
  fileLog('apply() 开始执行 v' + VERSION)
  const log = (message) => {
    try {
      const logger = typeof ctx.get === 'function' ? ctx.get('logger') : null
      if (logger && typeof logger.warn === 'function') logger.warn(message)
      else console.warn(message)
    } catch { /* logging must never break activation */ }
    fileLog(message)
  }

  const file = serverEntry()
  if (!file) { log('血染钟鱼：找不到 server.cjs，魔典服务未启动'); return }

  let mod
  try { mod = require(file) }
  catch (err) { log('血染钟鱼：加载服务端失败 ' + String((err && err.message) || err)); return }

  const llmCall = makeLlmCall(ctx)
  const listModels = makeListModels(ctx)

  // 1) 主入口：同源挂载（带 ctx.llm + 模型清单桥），自动跟随宿主端口。
  let mounted = false
  try {
    const webServer = typeof ctx.get === 'function' ? ctx.get('webServer') : null
    if (webServer && typeof webServer.register === 'function') {
      const route = { kind: 'prefix', path: MOUNT, handler: mod.makeHandler({ llmCall, listModels }, MOUNT) }
      if (typeof ctx.effect === 'function') ctx.effect(() => webServer.register(route))
      else webServer.register(route)
      mounted = true
      log('血染钟鱼：魔典已挂载到同源路由 ' + MOUNT + '/（自动跟随 DSH 端口）')
    }
  } catch (err) {
    log('血染钟鱼：同源挂载失败 ' + String((err && err.message) || err))
  }

  // 2) 固定端口服务：始终启动（RAN_PORT，默认 6325），带 ctx.llm 桥。
  {
    Promise.resolve(mod.serve({ port: PORT, llmCall, listModels })).then(function (result) {
      if (result && result.ok) {
        log('血染钟鱼：魔典已就绪 http://127.0.0.1:' + PORT + (result.reused ? '（端口已有服务，直接复用）' : ''))
        if (result.server && typeof ctx.effect === 'function') {
          // effect 会立即执行回调，返回的函数才是 disposer —— 必须返回关闭函数，不能直接关。
          ctx.effect(() => () => { try { result.server.close() } catch {} })
        }
      } else {
        log('血染钟鱼：魔典服务启动失败 ' + String((result && result.error) || 'unknown error'))
      }
    }).catch(function (err) {
      log('血染钟鱼：魔典服务启动异常 ' + String((err && err.message) || err))
    })
  }
}

export default { apply }
