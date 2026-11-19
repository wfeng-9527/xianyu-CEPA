import { createFileRoute } from '@tanstack/react-router'
import { AiPage } from '@/features/ai'

export const Route = createFileRoute('/_authenticated/ai/')({
  component: AiPage,
})
