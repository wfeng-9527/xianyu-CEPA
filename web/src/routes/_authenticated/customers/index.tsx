import { createFileRoute } from '@tanstack/react-router'
import { Placeholder } from '@/features/placeholder'

export const Route = createFileRoute('/_authenticated/customers/')({
  component: () => (
    <Placeholder
      title='客户'
      note='所有聊过的买家，按最后互动时间排序。'
      todos={[
          '接 /api/sessions 的 withWho 去重',
          '调 mtop.idle.web.user.page.head 补昵称/信用',
          '加备注与标签（本地库）',
      ]}
    />
  ),
})