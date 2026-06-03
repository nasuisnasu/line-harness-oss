'use client'

import type { PromptTemplate } from '@/components/prompt-modal'
import { useRegisterCcPrompts } from '@/lib/cc-prompt-context'

interface CcPromptButtonProps {
  prompts: PromptTemplate[]
}

/**
 * Registrar component — renders nothing. Each page imports this with its
 * own per-page prompts; the actual trigger button is now in the sidebar
 * (see `lib/cc-prompt-context.tsx`). Kept under the same name so existing
 * page imports continue to work.
 */
export default function CcPromptButton({ prompts }: CcPromptButtonProps) {
  useRegisterCcPrompts(prompts)
  return null
}
