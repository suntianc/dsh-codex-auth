/** Copy dictionaries for the codex-auth settings card. */

/** English strings (the key-set source of truth for this pair). */
export const en = {
  nav: 'GPT Auth',
  title: 'GPT Auth via codex',
  intro: 'Uses the ChatGPT login already stored by the codex CLI on this machine (~/.codex/auth.json) to reach chatgpt.com/backend-api. This is an unofficial channel: it is for personal development use only and can break or be revoked at any time.',
  loggedIn: 'Logged in',
  statusAvailable: 'codex login state available',
  loggedOut: 'Not logged in',
  notAvailable: 'codex CLI not available',
  authFileMissing: 'No codex auth file found',
  authMode: 'Auth mode',
  tokenExpiresAt: 'Token expires',
  lastRefreshAt: 'Last refreshed',
  codexVersion: 'codex version',
  credentialRef: 'Credential reference',
  login: 'Log in with ChatGPT',
  relogin: 'Log in again with ChatGPT',
  deviceLogin: 'Device-code login',
  startingLogin: 'Starting login…',
  refreshing: 'Refreshing…',
  refresh: 'Refresh status',
  riskNotice: 'This route uses the unofficial chatgpt.com backend (Responses protocol), which violates OpenAI\'s terms of service; the token can expire or be rate-limited at any time. Personal development use only.',
  privacyNotice: 'No token value is ever sent to the Web client.',
  loginHint: 'Logging in opens the official codex authorization page in your browser; click “Refresh status” when you have finished.',
  loginFailed: 'Starting the login flow failed',
  statusFailed: 'Reading the login status failed',
} as const

export type CodexAuthKey = keyof typeof en

/** Chinese strings (key-complete mirror of `en`). */
export const zh: Record<CodexAuthKey, string> = {
  nav: 'GPT Auth',
  title: '通过 codex 连接 GPT Auth',
  intro: '复用本机 codex CLI 已保存的 ChatGPT 登录态（~/.codex/auth.json）直连 chatgpt.com/backend-api。这是非官方通道，仅供个人开发自用，随时可能失效或受限。',
  loggedIn: '已登录',
  statusAvailable: 'codex 登录态可用',
  loggedOut: '未登录',
  notAvailable: 'codex CLI 不可用',
  authFileMissing: '未找到 codex 登录文件',
  authMode: '登录方式',
  tokenExpiresAt: 'Token 到期',
  lastRefreshAt: '最近刷新',
  codexVersion: 'codex 版本',
  credentialRef: '凭证引用',
  login: '登录 ChatGPT',
  relogin: '重新登录 ChatGPT',
  deviceLogin: '设备码登录',
  startingLogin: '正在启动登录…',
  refreshing: '刷新中…',
  refresh: '刷新状态',
  riskNotice: '本路由走 chatgpt.com 非官方后端（Responses 协议），违反 OpenAI 服务条款；token 可能随时失效或被风控。仅限个人开发自用。',
  privacyNotice: '任何 token 值都不会发送到 Web 客户端。',
  loginHint: '点击登录会在浏览器打开官方授权页；完成后点「刷新状态」。',
  loginFailed: '启动登录流程失败',
  statusFailed: '读取登录状态失败',
}
