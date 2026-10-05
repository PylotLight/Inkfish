/** Strip markdown chrome for titles, list rows and dashboard text. */
export function plain(md: string): string {
  return md
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/[#>*_~`|]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}
