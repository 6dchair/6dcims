import { Capacitor } from "@capacitor/core";

/**
 * "local"  = data is stored on the device itself (works fully offline)
 * "server" = data lives on the FastAPI server
 *
 * Phone app (Capacitor)  -> local, automatically
 * Browser                -> server, unless VITE_DATA_MODE=local is set
 * Set VITE_DATA_MODE to "local" or "server" to force either one.
 */
const configured = import.meta.env.VITE_DATA_MODE;

export const LOCAL_MODE: boolean =
  configured === "local"
    ? true
    : configured === "server"
      ? false
      : Capacitor.isNativePlatform();