import { Alert, AppShell, Burger, Button, Center, Code, Group, Loader, NavLink, ScrollArea, Stack, Text } from '@mantine/core';
import { useDisclosure } from '@mantine/hooks';
import {
  IconBuildingBank,
  IconBulb,
  IconCalendarStats,
  IconCash,
  IconChartLine,
  IconChartPie,
  IconHome,
  IconListDetails,
  IconReceiptTax,
  IconRefresh,
  IconSettings,
  IconSparkles,
  IconTransfer,
} from '@tabler/icons-react';
import { Link, Route, Routes, useLocation } from 'react-router-dom';
import { api, useAccounts, useSnapshot, useStatus } from './api';
import { Brand } from './Brand';
import { DemoBadge } from './demo';
import { AccountsOverviewPage } from './pages/accounts/AccountsOverview';
import { AccountsTransactionsPage } from './pages/accounts/AccountsTransactions';
import { DividendsPage } from './pages/Dividends';
import { HomePage } from './pages/Home';
import { InsightsPage } from './pages/Insights';
import { InstrumentPage } from './pages/Instrument';
import { OptimizationPage } from './pages/Optimization';
import { OverviewPage } from './pages/Overview';
import { PortfolioPage } from './pages/Portfolio';
import { SettingsPage } from './pages/Settings';
import { TaxesPage } from './pages/Taxes';
import { TradesPage } from './pages/Trades';
import { YearsPage } from './pages/Years';

type NavItem = { to: string; label: string; icon: typeof IconHome };

const NAV: { title?: string; items: NavItem[] }[] = [
  { items: [{ to: '/', label: 'Přehled', icon: IconHome }] },
  {
    title: 'Účty',
    items: [
      { to: '/ucty', label: 'Přehled účtů', icon: IconBuildingBank },
      { to: '/ucty/transakce', label: 'Transakce', icon: IconTransfer },
    ],
  },
  {
    title: 'Investice',
    items: [
      { to: '/investice', label: 'Přehled investic', icon: IconChartLine },
      { to: '/roky', label: 'Výnosy po letech', icon: IconCalendarStats },
  { to: '/portfolio', label: 'Portfolio a loty', icon: IconChartPie },
  { to: '/obchody', label: 'Realizované obchody', icon: IconListDetails },
  { to: '/dividendy', label: 'Dividendy', icon: IconCash },
  { to: '/dane', label: 'Daně', icon: IconReceiptTax },
  { to: '/optimalizace', label: 'Daňová optimalizace', icon: IconBulb },
      { to: '/zajimavosti', label: 'Zajímavosti', icon: IconSparkles },
    ],
  },
  { items: [{ to: '/nastaveni', label: 'Nastavení a data', icon: IconSettings }] },
];

function isActive(to: string, path: string): boolean {
  if (to === '/') return path === '/';
  // "/ucty" must not stay active on "/ucty/transakce"
  if (to === '/ucty') return path === '/ucty';
  return path === to || path.startsWith(`${to}/`);
}

function Loading({ status }: { status: ReturnType<typeof useStatus>['data'] }) {
  return (
    <Center h="60vh">
      <Stack align="center" maw={600}>
        {status?.status === 'error' ? (
          <Alert color="red" title="Výpočet selhal" w="100%">
            <Code block>{status.error}</Code>
          </Alert>
        ) : (
          <>
            <Loader />
            <Text c="dimmed">{status?.progress.at(-1) ?? 'Načítám…'}</Text>
          </>
        )}
        <Button component={Link} to="/nastaveni" variant="light">
          Nastavení a nahrání exportů
        </Button>
      </Stack>
    </Center>
  );
}

export function App() {
  const [opened, { toggle }] = useDisclosure();
  const loc = useLocation();
  const status = useStatus();
  const snap = useSnapshot();
  const accounts = useAccounts();
  const loading = status.data?.status === 'loading';
  const path = loc.pathname;

  let body: React.ReactNode;
  if (path.startsWith('/nastaveni')) body = <SettingsPage />;
  else if (path === '/') body = snap.data || accounts.data ? <HomePage s={snap.data} a={accounts.data} /> : <Loading status={status.data} />;
  else if (path === '/ucty' || path.startsWith('/ucty/')) {
    // the accounts module does not wait for the investment computation (market data)
    body = !accounts.data ? (
      <Loading status={status.data} />
    ) : (
      <Routes>
        <Route path="/ucty" element={<AccountsOverviewPage a={accounts.data} />} />
        <Route path="/ucty/transakce" element={<AccountsTransactionsPage a={accounts.data} />} />
      </Routes>
    );
  } else if (!snap.data) body = <Loading status={status.data} />;
  else
    body = (
      <Routes>
        <Route path="/investice" element={<OverviewPage s={snap.data} />} />
        <Route path="/roky" element={<YearsPage s={snap.data} />} />
        <Route path="/portfolio" element={<PortfolioPage s={snap.data} />} />
        <Route path="/obchody" element={<TradesPage s={snap.data} />} />
        <Route path="/dane" element={<TaxesPage s={snap.data} />} />
        <Route path="/dividendy" element={<DividendsPage s={snap.data} />} />
        <Route path="/optimalizace" element={<OptimizationPage s={snap.data} />} />
        <Route path="/zajimavosti" element={<InsightsPage s={snap.data} />} />
        <Route path="/instrument/:id" element={<InstrumentPage s={snap.data} />} />
      </Routes>
    );

  return (
    <AppShell header={{ height: 56 }} navbar={{ width: 240, breakpoint: 'sm', collapsed: { mobile: !opened } }} padding="md">
      <AppShell.Header>
        <Group h="100%" px="md" justify="space-between">
          <Group>
            <Burger opened={opened} onClick={toggle} hiddenFrom="sm" size="sm" />
            <Brand />
            {(snap.data?.demo || accounts.data?.demo) && <DemoBadge />}
          </Group>
          <Group gap="xs">
            {loading && (
              <Group gap={6}>
                <Loader size="xs" />
                <Text size="xs" c="dimmed">
                  {status.data?.progress.at(-1)}
                </Text>
              </Group>
            )}
            <Button size="xs" variant="subtle" leftSection={<IconRefresh size={14} />} disabled={loading} onClick={() => api.reload().then(() => status.refetch())}>
              Přepočítat
            </Button>
          </Group>
        </Group>
      </AppShell.Header>
      <AppShell.Navbar p="xs">
        <ScrollArea>
          {NAV.map((g, gi) => (
            <Stack key={gi} gap={0} mt={gi ? 'xs' : 0}>
              {g.title && (
                <Text size="xs" fw={700} c="dimmed" tt="uppercase" px="sm" py={4}>
                  {g.title}
                </Text>
              )}
              {g.items.map((n) => (
                <NavLink
                  key={n.to}
                  component={Link}
                  to={n.to}
                  label={n.label}
                  leftSection={<n.icon size={18} />}
                  active={isActive(n.to, path)}
                  onClick={() => opened && toggle()}
                />
              ))}
            </Stack>
          ))}
        </ScrollArea>
      </AppShell.Navbar>
      <AppShell.Main>{body}</AppShell.Main>
    </AppShell>
  );
}
