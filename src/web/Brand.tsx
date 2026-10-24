import { Box, Group, Text, UnstyledButton } from '@mantine/core';
import { Link } from 'react-router-dom';
import classes from './Brand.module.css';

/** App logo (50 Kč coin with the Czech lion), name and tagline – fits the 56 px header. */
export function Brand() {
  return (
    <UnstyledButton component={Link} to="/" className={classes.brand} aria-label="Myfin – Moje finance přehledně" title={`Myfin ${__APP_VERSION__}`} data-testid="brand">
      <Group gap={10} wrap="nowrap">
        <img src="logo.svg" alt="" width={36} height={36} className={classes.coin} />
        <Box>
          <Text component="div" className={classes.name}>
            My<span className={classes.accent}>fin</span>
          </Text>
          <Text component="div" className={classes.tagline} visibleFrom="xs">
            Moje finance přehledně
          </Text>
        </Box>
      </Group>
    </UnstyledButton>
  );
}
