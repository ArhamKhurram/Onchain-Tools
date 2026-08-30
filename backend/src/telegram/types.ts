export interface TelegramChat {
  id: string;
  title: string;
  type: 'user' | 'group' | 'supergroup' | 'channel';
  photo?: string | null;
  username?: string | null;
  inviteLink?: string | null;
  /** Topic-enabled (forum) supergroup — its topics are separately subscribable channels. */
  isForum?: boolean;
}

/** One forum topic of a topic-enabled supergroup, as the topics API lists them. */
export interface TelegramForumTopic {
  id: number;
  title: string;
  /** Closed topics still ingest history but usually stop producing new messages. */
  closed?: boolean;
}

export interface TelegramSender {
  id: string;
  username: string | null;
  firstName: string;
  lastName: string | null;
  photo: string | null;
}

export interface TelegramRawMessage {
  id: number;
  chatId: string;
  chatTitle: string;
  chatType: TelegramChat['type'];
  chatUsername?: string | null;
  chatInviteLink?: string | null;
  /**
   * Forum-topic id for a message in a topic-enabled (forum) supergroup, else null. This is the
   * Telegram analog of a Discord channel *within* a server: the group is the guild, the topic is
   * the channel. Null for non-forum groups and the group's "General" topic — those stay flat,
   * scoped to the group itself (backward-compatible with the pre-topics chatId-only model).
   */
  topicId?: number | null;
  /** Human-readable topic title if resolved, else null (ingestion sets null; the topics API fills it). */
  topicTitle?: string | null;
  sender: TelegramSender;
  text: string;
  date: number;
  replyTo?: {
    id: number;
    senderName: string;
    text: string;
  } | null;
  forward?: {
    senderName: string;
    chatTitle?: string;
  } | null;
  media?: TelegramMedia | null;
  sticker?: {
    url: string;
    emoji?: string;
    isAnimated: boolean;
  } | null;
  poll?: {
    question: string;
    options: { text: string; voters: number }[];
  } | null;
  buttons?: TelegramButton[] | null;
}

export interface TelegramButton {
  text: string;
  url: string;
}

export type TelegramMediaType = 'photo' | 'video' | 'document' | 'audio' | 'voice' | 'gif';

export interface TelegramMedia {
  type: TelegramMediaType;
  url: string;
  filename: string;
  size: number;
  mimeType?: string;
  width?: number;
  height?: number;
}
