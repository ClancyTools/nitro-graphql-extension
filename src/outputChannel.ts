import * as vscode from "vscode"

let channel: vscode.OutputChannel | undefined

export function initOutputChannel(context: vscode.ExtensionContext): void {
  channel = vscode.window.createOutputChannel("NitroGraphQL")
  context.subscriptions.push(channel)
}

export function log(message: string): void {
  const ts = new Date().toTimeString().slice(0, 8)
  const line = `[${ts}] ${message}`
  channel?.appendLine(line)
  // Also log to console for test environments (no vscode)
  console.log(line)
}

export function warn(message: string): void {
  const ts = new Date().toTimeString().slice(0, 8)
  const line = `[${ts}] WARN: ${message}`
  channel?.appendLine(line)
  console.warn(line)
}

export function error(message: string): void {
  const ts = new Date().toTimeString().slice(0, 8)
  const line = `[${ts}] ERROR: ${message}`
  channel?.appendLine(line)
  console.error(line)
}

export function showChannel(): void {
  channel?.show(true)
}
