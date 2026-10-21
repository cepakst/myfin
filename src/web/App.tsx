import { Alert, AppShell, Burger, Button, Center, Code, Group, Loader, NavLink, ScrollArea, Stack, Text, Title } from '@mantine/core';
import { useDisclosure } from '@mantine/hooks';
import {
  IconBulb,
  IconCalendarStats,
  IconCash,
  IconChartPie,
  IconHome,
  IconListDetails,
  IconReceiptTax,
  IconRefresh,
  IconSettings,
  IconSparkles,
} from '@tabler/icons-react';
import { Link, Route, Routes, useLocation } from 'react-router-dom';
import { api, useSnapshot, useStatus } from './api';
import { DividendsPage } from './pages/Dividends';
import { InsightsPage } from './pages/Insights';
import { InstrumentPage } from './pages/Instrument';
import { OptimizationPage } from './pages/Optimization';
import { OverviewPage } from './pages/Overview';
import { PortfolioPage } from './pages/Portfolio';
import { SettingsPage } from './pages/Settings';
import { TaxesPage } from './pages/Taxes';
import { TradesPage } from './pages/Trades';
import { YearsPage } from './pages/Years';

const NAV = [
  { to: '/', label: 'Přehled', icon: IconHome },
  { to: '/roky', label: 'Výnosy po letech', icon: IconCalendarStats },
  { to: '/portfolio', label: 'Portfolio a loty', icon: IconChartPie },
  { to: '/obchody', label: 'Realizované obchody', icon: IconListDetails },
  { to: '/dane', label: 'Daně – CP (§10)', icon: IconReceiptTax },
  { to: '/dividendy', label: 'Dividendy (§8)', icon: IconCash },
  { to: '/optimalizace', label: 'Daňová optimalizace', icon: IconBulb },
  { to: '/zajimavosti', label: 'Zajímavosti', icon: IconSparkles },
  { to: '/nastaveni', label: 'Nastavení a data', icon: IconSettings },
];

export function App() {
  const [opened, { toggle }] = useDisclosure();
  const loc = useLocation();
  const status = useStatus();
  const snap = useSnapshot();
  const loading = status.data?.status === 'loading';

  let body: React.ReactNode;
  if (loc.pathname.startsWith('/nastaveni')) body = <SettingsPage />;
  else if (!snap.data) {
    body = (
      <Center h="60vh">
        <Stack align="center" maw={600}>
          {status.data?.status === 'error' ? (
            <Alert color="red" title="Výpočet selhal" w="100%">
              <Code block>{status.data.error}</Code>
            </Alert>
          ) : (
            <>
              <Loader />
              <Text c="dimmed">{status.data?.progress.at(-1) ?? 'Načítám…'}</Text>
            </>
          )}
          <Button component={Link} to="/nastaveni" variant="light">
            Nastavení a nahrání exportů
          </Button>
        </Stack>
      </Center>
    );
  } else
    body = (
      <Routes>
        <Route path="/" element={<OverviewPage s={snap.data} />} />
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
            <Title order={3}>My finance</Title>
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
          {NAV.map((n) => (
            <NavLink
              key={n.to}
              component={Link}
              to={n.to}
              label={n.label}
              leftSection={<n.icon size={18} />}
              active={n.to === '/' ? loc.pathname === '/' : loc.pathname.startsWith(n.to)}
              onClick={() => opened && toggle()}
            />
          ))}
        </ScrollArea>
      </AppShell.Navbar>
      <AppShell.Main>{body}</AppShell.Main>
    </AppShell>
  );
}
