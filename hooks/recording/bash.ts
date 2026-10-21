/** Make whole Claude bash-mode rows readable without rewriting tag examples in prose. */
export function bashMarkdown(text: string): string {
  const tags = /<(bash-input|bash-stdout|bash-stderr)>([\s\S]*?)<\/\1>/g
  const parts = [...text.matchAll(tags)]
  if (!parts.length || text.replace(tags, '').trim()) return text
  const delimiter = (body: string, minimum: number) => {
    let length = minimum
    for (const run of body.matchAll(/`+/g)) length = Math.max(length, run[0].length + 1)
    return '`'.repeat(length)
  }
  const fenced = (body: string) => {
    const fence = delimiter(body, 3)
    return `${fence}\n${body}${body.endsWith('\n') ? '' : '\n'}${fence}`
  }
  // Both groups always match; the defaults only satisfy the indexed-access check.
  return parts.flatMap(([, tag = '', body = '']) => {
    if (tag === 'bash-input') {
      if (/[\r\n]/.test(body)) return [`Ran\n\n${fenced(body)}`]
      const fence = delimiter(body, 1)
      const padding = body.startsWith('`') || body.endsWith('`') ? ' ' : ''
      return [`Ran ${fence}${padding}${body}${padding}${fence}`]
    }
    if (tag === 'bash-stderr') return body.trim() ? [`Stderr:\n\n${fenced(body)}`] : []
    return body ? [fenced(body)] : []
  }).join('\n\n')
}
