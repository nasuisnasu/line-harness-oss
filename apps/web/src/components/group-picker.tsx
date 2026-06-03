'use client'

import { useState } from 'react'

/**
 * Group selector with explicit "select existing" / "create new" modes.
 *
 * Why split the modes instead of a single text+datalist input:
 *   - Operators couldn't tell whether typing a new value would silently
 *     create a group or just hang there as a free string.
 *   - With explicit modes, "create new" is a deliberate action and the
 *     dropdown is the safe default for picking among existing groups.
 *
 * Group existence is derived from `existingGroups` (i.e. names already
 * attached to other entities). There is no separate `groups` table —
 * dropping the last reference to a group makes it disappear from the
 * dropdown automatically. Operators wanting a stable group should attach
 * at least one item to it.
 */
export default function GroupPicker({
  value,
  onChange,
  existingGroups,
  placeholder = '例: Threads / LP / 広告',
}: {
  value: string
  onChange: (v: string) => void
  existingGroups: string[]
  placeholder?: string
}) {
  // Mode is derived from value vs known list, but we keep an explicit
  // toggle so an operator typing a brand-new name doesn't get bounced
  // back to the dropdown on every render.
  const knownSet = new Set(existingGroups)
  const isExistingValue = value && knownSet.has(value)
  const [mode, setMode] = useState<'select' | 'new'>(
    isExistingValue || !value ? 'select' : 'new',
  )

  return (
    <div className="space-y-1.5">
      <div className="flex gap-2">
        <button
          type="button"
          onClick={() => setMode('select')}
          className={`text-xs px-2.5 py-1 rounded border ${
            mode === 'select'
              ? 'border-[#06C755] bg-[#06C755]/10 text-[#06C755]'
              : 'border-gray-300 text-gray-500 bg-white'
          }`}
        >
          既存から選ぶ
        </button>
        <button
          type="button"
          onClick={() => {
            setMode('new')
            // Switching to create mode clears any previously-selected
            // existing group so the operator's typing fills a clean field.
            if (knownSet.has(value)) onChange('')
          }}
          className={`text-xs px-2.5 py-1 rounded border ${
            mode === 'new'
              ? 'border-[#06C755] bg-[#06C755]/10 text-[#06C755]'
              : 'border-gray-300 text-gray-500 bg-white'
          }`}
        >
          + 新規作成
        </button>
      </div>
      {mode === 'select' ? (
        <select
          className="w-full border border-gray-300 rounded px-3 py-2 text-sm bg-white"
          value={isExistingValue ? value : ''}
          onChange={(e) => onChange(e.target.value)}
        >
          <option value="">未分類</option>
          {existingGroups.map((g) => (
            <option key={g} value={g}>
              {g}
            </option>
          ))}
        </select>
      ) : (
        <input
          type="text"
          className="w-full border border-gray-300 rounded px-3 py-2 text-sm"
          placeholder={placeholder}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          autoFocus
        />
      )}
    </div>
  )
}
