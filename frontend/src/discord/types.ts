// The Discord-gateway subset of types the browser gateway needs. The raw Discord
// types + the (widened) FrontendMessage are now canonical in @oct/shared and
// re-exported here. isolatedModules is on → type re-exports MUST use
// `export type`; GatewayOpcodes is a runtime value.
export { GatewayOpcodes } from '@oct/shared';

export type {
  DiscordUser,
  DiscordReaction,
  DiscordAttachment,
  DiscordEmbed,
  DiscordMessage,
  GatewayPayload,
  GuildInfo,
  DMChannel,
  MessageSource,
  KeywordMatchMode,
  KeywordPattern,
  FrontendReaction,
  FrontendMessage,
} from '@oct/shared';

// Frontend-only: surfaced by the browser gateway when a token fails auth.
export interface GatewayAuthFailure {
  tokenIndex: number;
  message: string;
  invalid: boolean;
}
