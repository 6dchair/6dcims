// import type { CapacitorConfig } from '@capacitor/cli';

// const config: CapacitorConfig = {
//   appId: 'com.sixd.inventory',
//   appName: 'InventorySystem',
//   webDir: 'dist'
// };

// export default config;

import type { CapacitorConfig } from "@capacitor/cli";

const config: CapacitorConfig = {
  appId: "com.sixd.inventory",
  appName: "InventorySystem",
  webDir: "dist",
  // Only while the backend is plain http (LAN/testing).
  // Remove this line once the backend is on https.
  server: { androidScheme: "http", cleartext: true },
};

export default config;