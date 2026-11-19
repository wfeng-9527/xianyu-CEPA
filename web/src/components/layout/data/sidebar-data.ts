import {
  MessageSquare,
  Users,
  Package,
  ListFilter,
  Bot,
  Settings,
  ServerCog,
  LayoutDashboard,
  Activity,
  ReceiptText,
  ShieldCheck,
  Mail,
  FlaskConical,
} from 'lucide-react'
import { type SidebarData } from '../types'

export const sidebarData: SidebarData = {
  user: {
    name: '闲管家',
    email: 'kefu@localhost',
    avatar: '/avatars/shadcn.jpg',
  },
  teams: [
    {
      name: '闲鱼客服',
      logo: MessageSquare,
      plan: '本地工作台',
    },
  ],
  navGroups: [
    {
      title: '接待',
      items: [
        {
          title: '工作台',
          url: '/im',
          icon: MessageSquare,
        },
        {
          title: '概览',
          url: '/',
          icon: LayoutDashboard,
        },
        {
          title: '客户',
          url: '/customers',
          icon: Users,
        },
        {
          title: '订单',
          url: '/orders',
          icon: ReceiptText,
        },
        {
          title: '商品',
          url: '/items',
          icon: Package,
        },
      ],
    },
    {
      title: '自动化',
      items: [
        {
          title: '规则',
          url: '/rules',
          icon: ListFilter,
        },
        {
          title: 'AI 兜底',
          url: '/ai',
          icon: Bot,
        },
        {
          title: '回复训练',
          url: '/train',
          icon: FlaskConical,
        },
        {
          title: '运行日志',
          url: '/logs',
          icon: Activity,
        },
      ],
    },
    {
      title: '系统',
      items: [
        {
          title: '保险平台',
          url: '/plans',
          icon: ShieldCheck,
        },
        {
          title: '账号与 Cookie',
          url: '/accounts',
          icon: ServerCog,
        },
        {
          title: '邮箱配置',
          url: '/mail',
          icon: Mail,
        },
        {
          title: '设置',
          icon: Settings,
          items: [
            { title: '账号设置', url: '/settings' },
            { title: '外观', url: '/settings/appearance' },
            { title: '显示', url: '/settings/display' },
            { title: '通知', url: '/settings/notifications' },
          ],
        },
      ],
    },
  ],
}
