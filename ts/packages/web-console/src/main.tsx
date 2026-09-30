// The console's entry point: builds this device's one shared identity/clock, then hands them to <App> as props. Kept here rather than inside App.tsx so App itself stays a plain, testable component that never touches IndexedDB/WebCrypto directly -- a test renders <App identity={fakeIdentity} clock={fixedClock} /> against fakes, exactly the same way the domain layer's own tests never touch a real adapter.

import "@mantine/core/styles.css";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { MantineProvider } from "@mantine/core";
import { createIndexedDbStorage } from "./adapters/indexeddb-storage.js";
import { createPersistedWebCryptoIdentity } from "./adapters/web-crypto-identity.js";
import { createCertificateMemory } from "./certificate-memory.js";
import { createIdentityBackupService } from "./adapters/identity-backup.js";
import { createGrantStore } from "./grant-store.js";
import { createRevocationStore } from "./revocation-store.js";
import { createPreferencesStore } from "./preferences-store.js";
import { createNameStore } from "./name-store.js";
import { createMessageStore } from "./message-store.js";
import { App } from "./App.js";
import { PwaUpdatePrompt } from "./components/PwaUpdatePrompt.js";
import { defaultHubAddress } from "./default-hub-address.js";

const identityStorage = await createIndexedDbStorage();
const identity = await createPersistedWebCryptoIdentity(identityStorage);
const clock = { now: () => Date.now() };
const grants = createGrantStore(await createIndexedDbStorage());
const revocations = await createRevocationStore({
  storage: await createIndexedDbStorage(),
  identity,
  clock,
});
const identityBackup = createIdentityBackupService(identityStorage);
const messageStore = createMessageStore(await createIndexedDbStorage());
const roomStorage = await createIndexedDbStorage();
const certificateMemory = createCertificateMemory(
  await createIndexedDbStorage(),
);
const nameStore = createNameStore(await createIndexedDbStorage());
const preferences = createPreferencesStore(await createIndexedDbStorage());
const address = defaultHubAddress(import.meta.env.DEV, window.location);

const container = document.getElementById("root");
if (container === null) {
  throw new Error("missing #root element");
}

createRoot(container).render(
  <StrictMode>
    <MantineProvider>
      <App
        identity={identity}
        clock={clock}
        messageStore={messageStore}
        roomStorage={roomStorage}
        certificateMemory={certificateMemory}
        nameStore={nameStore}
        preferences={preferences}
        grants={grants}
        revocations={revocations}
        identityBackup={identityBackup}
        defaultAddress={address}
      />
      <PwaUpdatePrompt />
    </MantineProvider>
  </StrictMode>,
);
