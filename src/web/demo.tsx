import { Badge, Tooltip } from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { api } from './api';

/** Switches between the user's exports and the bundled demo data, then waits for the recomputation. */
export function useSetDemo() {
  const qc = useQueryClient();
  return async (enabled: boolean) => {
    try {
      await api.setDemo(enabled);
      notifications.show({ message: enabled ? 'Načítám demo data…' : 'Načítám vaše exporty…', color: 'teal' });
    } catch (e) {
      notifications.show({ message: (e as Error).message, color: 'red' });
    }
    await qc.invalidateQueries({ queryKey: ['settings'] });
    await qc.invalidateQueries({ queryKey: ['status'] });
  };
}

export function DemoBadge() {
  const nav = useNavigate();
  return (
    <Tooltip
      multiline
      w={320}
      withArrow
      label="Zobrazena ukázková data: smyšlené portfolio s obchody na skutečných instrumentech za skutečné historické ceny. Na vlastní exporty přepnete v Nastavení."
    >
      <Badge size="lg" color="orange" variant="filled" radius="sm" style={{ cursor: 'pointer' }} onClick={() => nav('/nastaveni')} data-testid="demo-badge">
        DEMO
      </Badge>
    </Tooltip>
  );
}
