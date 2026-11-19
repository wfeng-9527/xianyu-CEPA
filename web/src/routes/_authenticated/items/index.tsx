import { createFileRoute } from '@tanstack/react-router'
import { ItemsPage } from '@/features/items'

export const Route = createFileRoute('/_authenticated/items/')({
  component: ItemsPage,
})