import { useId, useState } from 'react'
import { normalizeTag, uniqueTags } from '../../../shared/tags'

/**
 * Note header tags: `#chip ×` per frontmatter tag plus a small "+ tag" input (↵ / , / Tab adds,
 * Esc cancels, ⌫ on empty removes the last). Writes go through `onChange` → front matter `tags:`.
 */
export default function TagChips({
  tags,
  allTags,
  onChange,
  onTagClick
}: {
  tags: readonly string[]
  /** Every tag in the vault — autocomplete. */
  allTags?: readonly string[]
  onChange: (tags: string[]) => void
  /** Click a chip: search the sidebar for it. */
  onTagClick?: (tag: string) => void
}): React.JSX.Element {
  const [adding, setAdding] = useState(false)
  const [value, setValue] = useState('')
  const listId = useId()

  const commit = (raw: string, keepOpen: boolean): void => {
    const add = raw
      .split(/[,\s]+/)
      .map(normalizeTag)
      .filter(Boolean)
    if (add.length) onChange(uniqueTags([...tags, ...add]))
    setValue('')
    if (!keepOpen) setAdding(false)
  }

  return (
    <div className="ed-tags" aria-label="Tags">
      {tags.map((t) => (
        <span key={t} className="tag-chip">
          <button className="tag-chip-name" title={`Show notes tagged #${t}`} onClick={() => onTagClick?.(t)}>
            #{t}
          </button>
          <button
            className="tag-chip-x"
            aria-label={`Remove tag ${t}`}
            title="Remove tag"
            onClick={() => onChange(tags.filter((x) => x !== t))}
          >
            ×
          </button>
        </span>
      ))}
      {adding ? (
        <>
          <input
            className="tag-input"
            value={value}
            autoFocus
            list={listId}
            spellCheck={false}
            placeholder="tag"
            aria-label="Add tag"
            size={Math.max(4, value.length + 1)}
            onChange={(e) => {
              const v = e.target.value
              if (/[,]$/.test(v)) commit(v, true)
              else setValue(v)
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || (e.key === 'Tab' && value.trim())) {
                e.preventDefault()
                commit(value, e.key === 'Tab')
              } else if (e.key === 'Escape') {
                e.preventDefault()
                e.stopPropagation()
                setValue('')
                setAdding(false)
              } else if (e.key === 'Backspace' && !value && tags.length) {
                e.preventDefault()
                onChange(tags.slice(0, -1))
              }
            }}
            onBlur={() => commit(value, false)}
          />
          {allTags && allTags.length > 0 && (
            <datalist id={listId}>
              {allTags
                .filter((t) => !tags.includes(t))
                .slice(0, 200)
                .map((t) => (
                  <option key={t} value={t} />
                ))}
            </datalist>
          )}
        </>
      ) : (
        <button
          className="tag-add"
          onClick={() => setAdding(true)}
          title="Add a tag (saved in the note's front matter)"
        >
          + tag
        </button>
      )}
    </div>
  )
}
