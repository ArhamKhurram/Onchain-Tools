export function getAvatarUrl(userId: string, avatar: string | null, discriminator?: string): string {
  if (avatar && (avatar.startsWith('/') || avatar.startsWith('http'))) {
    return avatar;
  }
  if (avatar) {
    return `https://cdn.discordapp.com/avatars/${userId}/${avatar}.webp?size=80`;
  }
  const index = discriminator === '0' || !discriminator
    ? (BigInt(userId) >> 22n) % 6n
    : parseInt(discriminator) % 5;
  return `https://cdn.discordapp.com/embed/avatars/${index}.png`;
}

export function formatTimestamp(iso: string, short = false): string {
  const d = new Date(iso);
  const now = new Date();
  const isToday = d.toDateString() === now.toDateString();
  const time = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  if (isToday) return short ? time : `Today at ${time}`;
  const yesterday = new Date(now);
  yesterday.setDate(yesterday.getDate() - 1);
  if (d.toDateString() === yesterday.toDateString()) return short ? `Yest ${time}` : `Yesterday at ${time}`;
  return short ? `${d.toLocaleDateString([], { month: 'numeric', day: 'numeric' })} ${time}` : `${d.toLocaleDateString()} ${time}`;
}
