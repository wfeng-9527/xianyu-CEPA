import { Construction } from 'lucide-react'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Header } from '@/components/layout/header'
import { Main } from '@/components/layout/main'
import { ConfigDrawer } from '@/components/config-drawer'
import { ProfileDropdown } from '@/components/profile-dropdown'
import { ThemeSwitch } from '@/components/theme-switch'

type Props = {
  title: string
  note: string
  todos?: string[]
}

export function Placeholder({ title, note, todos }: Props) {
  return (
    <>
      <Header>
        <h1 className='me-auto text-base font-semibold'>{title}</h1>
        <ThemeSwitch />
        <ConfigDrawer />
        <ProfileDropdown />
      </Header>
      <Main>
        <Card>
          <CardHeader>
            <CardTitle className='flex items-center gap-2 text-base'>
              <Construction />
              {title}
            </CardTitle>
            <CardDescription>{note}</CardDescription>
          </CardHeader>
          <CardContent>
            {todos && todos.length > 0 ? (
              <ul className='flex list-disc flex-col gap-1 ps-5 text-sm text-muted-foreground'>
                {todos.map((t) => (
                  <li key={t}>{t}</li>
                ))}
              </ul>
            ) : (
              <p className='text-sm text-muted-foreground'>骨架已就位，等接数据。</p>
            )}
          </CardContent>
        </Card>
      </Main>
    </>
  )
}
