/** IM channel type → JID prefix mapping. Shared between main server and agent-runner. */
import { CHANNEL_REGISTRY } from './channel-registry.js';

/** Derived from the channel registry (single source of truth, ADR-0009). */
export const CHANNEL_PREFIXES: Record<string, string> = Object.fromEntries(
  CHANNEL_REGISTRY.map((entry) => [entry.id, entry.jidPrefix]),
);

/** Determine the channel type from a JID string. Returns 'web' for unrecognized prefixes. */
export function getChannelFromJid(jid: string): string {
  for (const [type, prefix] of Object.entries(CHANNEL_PREFIXES)) {
    if (jid.startsWith(prefix)) return type;
  }
  return 'web';
}
