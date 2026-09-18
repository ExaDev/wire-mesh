// Surfaces the two states useRegisterSW can report: the app shell is now cached and will load offline, or a new build is waiting and this tab still holds the previous one. Kept out of App.tsx (see main.tsx's own header comment on why) since it depends on the service-worker registration virtual module App's own render tests have no reason to touch.

import { Button, Group, Notification } from "@mantine/core";
import { useRegisterSW } from "virtual:pwa-register/react";

export function PwaUpdatePrompt(): React.JSX.Element | null {
  const {
    offlineReady: [offlineReady, setOfflineReady],
    needRefresh: [needRefresh, setNeedRefresh],
    updateServiceWorker,
  } = useRegisterSW();

  function dismiss(): void {
    setOfflineReady(false);
    setNeedRefresh(false);
  }

  if (!offlineReady && !needRefresh) {
    return null;
  }

  return (
    <Notification
      onClose={dismiss}
      closeButtonProps={{ "aria-label": "Dismiss" }}
      title={needRefresh ? "Update available" : "Ready to work offline"}
      pos="fixed"
      bottom="1rem"
      right="1rem"
      style={{ zIndex: 1000 }}
    >
      <Group gap="xs">
        {needRefresh ? (
          <Button
            size="xs"
            onClick={() => {
              void updateServiceWorker(true);
            }}
          >
            Reload
          </Button>
        ) : undefined}
      </Group>
    </Notification>
  );
}
