// The console's entry point: builds this device's one shared identity/clock, then hands them to <App> as props. Kept here rather than inside App.tsx so App itself stays a plain, testable component that never touches IndexedDB/WebCrypto directly -- a test renders <App identity={fakeIdentity} clock={fixedClock} /> against fakes, exactly the same way the domain layer's own tests never touch a real adapter.

import "@mantine/core/styles.css";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { MantineProvider } from "@mantine/core";
import { createIndexedDbStorage } from "./adapters/indexeddb-storage.js";
import { createPersistedWebCryptoIdentity } from "./adapters/web-crypto-identity.js";
import { createMessageStore } from "./message-store.js";
import { App } from "./App.js";

const identity = await createPersistedWebCryptoIdentity(
  await createIndexedDbStorage(),
);
const clock = { now: () => Date.now() };
const messageStore = createMessageStore(await createIndexedDbStorage());

const container = document.getElementById("root");
if (container === null) {
  throw new Error("missing #root element");
}

createRoot(container).render(
  <StrictMode>
    <MantineProvider>
      <App identity={identity} clock={clock} messageStore={messageStore} />
    </MantineProvider>
  </StrictMode>,
);
