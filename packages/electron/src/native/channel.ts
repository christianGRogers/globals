/**
 * The IPC channel names the native transport uses. A module of its own with no Electron
 * import, because both process sides need the names and neither may load the other's
 * modules.
 */
export const NATIVE_CHANNEL = "globals:native";
export const HELLO = `${NATIVE_CHANNEL}:hello`;
export const DISPATCH = `${NATIVE_CHANNEL}:dispatch`;
export const COMMIT = `${NATIVE_CHANNEL}:commit`;

/** What the main process answers a connecting window with. */
export interface Hello {
  regionPath: string;
  version: number;
}

/** A write intent. The renderer never writes memory; it asks the owner to. */
export interface DispatchMessage {
  operation: string;
  payload: unknown;
}
